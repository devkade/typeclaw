import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InstagramAccount } from 'agent-messenger/instagram'

import { prepareAgentMessengerHostConfigDir } from '@/agent-messenger/host-config-dir'

import {
  runInstagramBootstrap,
  type InstagramAuthenticateResult,
  type InstagramLoginClient,
  type InstagramLoginCredentialManager,
} from './instagram-auth'

const managedConfigDeps = {
  prepareConfigDir: async (agentDir: string) => ({
    ok: true as const,
    hostDir: join(agentDir, 'workspace', '.config', 'agent-messenger'),
  }),
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-instagram-auth-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function fakeManager(accountId = 'alice'): { manager: InstagramLoginCredentialManager; saved: InstagramAccount[] } {
  const saved: InstagramAccount[] = []
  let current: string | null = null
  return {
    saved,
    manager: {
      ensureAccountPaths: async (id) => ({ session_path: `/tmp/${id}/session.json` }),
      getAccount: async (id) => saved.find((account) => account.account_id === (id ?? current)) ?? null,
      setAccount: async (account) => {
        saved.push(account)
      },
      setCurrent: async (id) => {
        current = id
        return id === accountId
      },
    },
  }
}

function fakeManagerWithSession(
  sessionPath: string,
  accountId = 'alice',
): { manager: InstagramLoginCredentialManager; saved: InstagramAccount[] } {
  const base = fakeManager(accountId)
  return { ...base, manager: { ...base.manager, ensureAccountPaths: async () => ({ session_path: sessionPath }) } }
}

const noopChallengeMethods = {
  twoFactorLogin: async () => ({ userId: '' }),
  challengeSendCode: async () => ({ contactPoint: '', stepName: '' }),
  challengeSubmitCode: async () => ({ userId: '' }),
}

// Mimics the SDK's checkpoint path: authenticate() persists a partial session
// to disk (challenge_path + cookies) before returning challengeRequired, which
// is exactly the file the bootstrap must roll back on a failed second factor.
function checkpointWritingClient(
  overrides: Partial<InstagramLoginClient> = {},
  challengePath = '/challenge/xyz/',
): InstagramLoginClient {
  let sessionPath = ''
  return {
    setSessionPath: (path) => {
      sessionPath = path
    },
    authenticate: async () => {
      await writeFile(sessionPath, JSON.stringify({ challenge_path: challengePath, cookies: 'partial' }))
      return { userId: '', challengeRequired: true, challengePath }
    },
    getUserId: () => null,
    ...noopChallengeMethods,
    ...overrides,
  }
}

function fakeClient(result: InstagramAuthenticateResult): InstagramLoginClient {
  return {
    authenticate: async () => result,
    setSessionPath: () => {},
    getUserId: () => result.userId || null,
    ...noopChallengeMethods,
  }
}

function observingClient(result: InstagramAuthenticateResult, onAuthenticate: () => void): InstagramLoginClient {
  return {
    authenticate: async () => {
      onAuthenticate()
      return result
    },
    setSessionPath: () => {},
    getUserId: () => result.userId || null,
    ...noopChallengeMethods,
  }
}

describe('runInstagramBootstrap', () => {
  test('uses a stale running container legacy path without creating the managed tree', async () => {
    await withDir(async (dir) => {
      const legacy = join(dir, 'workspace', '.agent-messenger')
      const current = join(dir, 'workspace', '.config', 'agent-messenger')
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, 'session.json'), 'live-session')
      const { manager } = fakeManager()
      const events: string[] = []
      let observedConfigDir: string | undefined

      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: observingClient({ userId: '12345' }, () => {
            events.push('login')
            observedConfigDir = process.env.AGENT_MESSENGER_CONFIG_DIR
          }),
        },
        {
          prepareConfigDir: async (agentDir) => {
            const result = await prepareAgentMessengerHostConfigDir(agentDir, {
              exec: async () => ({
                exitCode: 0,
                stdout: 'true\n["AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger"]\n',
                stderr: '',
              }),
            })
            events.push('prepared')
            return result
          },
        },
      )

      expect(status).toEqual({ ok: true })
      expect(events).toEqual(['prepared', 'login'])
      expect(observedConfigDir).toBe(legacy)
      expect(await readFile(join(legacy, 'session.json'), 'utf8')).toBe('live-session')
      expect(existsSync(current)).toBe(false)
    })
  })

  test('points the SDK storage at the agent workspace during login, then restores the env', async () => {
    await withDir(async (dir) => {
      const savedEnv = process.env.AGENT_MESSENGER_CONFIG_DIR
      delete process.env.AGENT_MESSENGER_CONFIG_DIR
      try {
        const { manager } = fakeManager()
        let duringLogin: string | undefined
        await runInstagramBootstrap(
          {
            username: 'alice',
            password: 'secret',
            agentDir: dir,
            credentialManager: manager,
            client: observingClient({ userId: '12345' }, () => {
              duringLogin = process.env.AGENT_MESSENGER_CONFIG_DIR
            }),
          },
          managedConfigDeps,
        )
        expect(duringLogin ?? '').toBe(join(dir, 'workspace', '.config', 'agent-messenger'))
        expect(process.env.AGENT_MESSENGER_CONFIG_DIR).toBeUndefined()
      } finally {
        if (savedEnv === undefined) delete process.env.AGENT_MESSENGER_CONFIG_DIR
        else process.env.AGENT_MESSENGER_CONFIG_DIR = savedEnv
      }
    })
  })

  test('mirrors SDK account metadata into secrets after clean authentication', async () => {
    await withDir(async (dir) => {
      const { manager, saved } = fakeManager()
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: fakeClient({ userId: '12345' }),
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: true })
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ account_id: 'alice', username: 'alice', pk: '12345' })

      const raw = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')) as {
        channels: {
          instagram: {
            currentAccount: string
            accounts: Record<string, { account_id: string; username: string; pk?: string }>
          }
        }
      }
      expect(raw.channels.instagram.currentAccount).toBe('alice')
      expect(raw.channels.instagram.accounts.alice).toMatchObject({
        account_id: 'alice',
        username: 'alice',
        pk: '12345',
      })
    })
  })

  test('reports login failures', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const client: InstagramLoginClient = {
        ...fakeClient({ userId: '' }),
        authenticate: async () => {
          throw new Error('login exploded')
        },
        getUserId: () => null,
      }
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client,
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: false, reason: 'login exploded' })
    })
  })

  test('completes 2FA by echoing the identifier and the entered code, then persists', async () => {
    await withDir(async (dir) => {
      const { manager, saved } = fakeManager()
      const calls: Array<{ username: string; code: string; identifier: string }> = []
      const client: InstagramLoginClient = {
        ...fakeClient({ userId: '', requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: 'tfi-abc' } }),
        twoFactorLogin: async (username, code, identifier) => {
          calls.push({ username, code, identifier })
          return { userId: '99999' }
        },
      }
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client,
          callbacks: { onTwoFactorCode: async () => '123456' },
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: true })
      expect(calls).toEqual([{ username: 'alice', code: '123456', identifier: 'tfi-abc' }])
      expect(saved[0]).toMatchObject({ pk: '99999' })
    })
  })

  test('completes a checkpoint challenge: sends the code, submits the entered code, persists', async () => {
    await withDir(async (dir) => {
      const { manager, saved } = fakeManager()
      const sent: string[] = []
      const submitted: Array<{ path: string; code: string }> = []
      const client: InstagramLoginClient = {
        ...fakeClient({ userId: '', challengeRequired: true, challengePath: '/challenge/xyz/' }),
        challengeSendCode: async (path) => {
          sent.push(path)
          return { contactPoint: 'a****@example.com', stepName: 'verify_email' }
        },
        challengeSubmitCode: async (path, code) => {
          submitted.push({ path, code })
          return { userId: '77777' }
        },
      }
      let promptedContact = ''
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client,
          callbacks: {
            onChallengeCode: async ({ contactPoint }) => {
              promptedContact = contactPoint
              return { code: '654321' }
            },
          },
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: true })
      expect(sent).toEqual(['/challenge/xyz/'])
      expect(submitted).toEqual([{ path: '/challenge/xyz/', code: '654321' }])
      expect(promptedContact).toBe('a****@example.com')
      expect(saved[0]).toMatchObject({ pk: '77777' })
    })
  })

  // Per the repo multi-language rule (AGENTS.md), an interactive flow must be
  // asserted with non-Latin input alongside the English cases.
  test('completes 2FA for an account with a non-Latin username', async () => {
    await withDir(async (dir) => {
      const { manager, saved } = fakeManager('앨리스')
      const client: InstagramLoginClient = {
        ...fakeClient({ userId: '', requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: 'tfi-korean' } }),
        twoFactorLogin: async () => ({ userId: '55555' }),
      }
      const status = await runInstagramBootstrap(
        {
          username: '앨리스',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client,
          callbacks: { onTwoFactorCode: async () => '246810' },
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: true })
      expect(saved[0]).toMatchObject({ username: '앨리스', pk: '55555' })
    })
  })

  test('fails clearly when 2FA is required but no interactive prompt is available', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: fakeClient({ userId: '', requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: 'x' } }),
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      if (status.ok) throw new Error('expected failure')
      expect(status.reason).toContain('2FA')
      expect(status.reason).toContain('no interactive prompt')
    })
  })

  test('fails clearly when a checkpoint is required but no interactive prompt is available', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: fakeClient({ userId: '', challengeRequired: true, challengePath: '/challenge/' }),
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      if (status.ok) throw new Error('expected failure')
      expect(status.reason).toContain('checkpoint')
      expect(status.reason).toContain('no interactive prompt')
    })
  })

  test('fails when the operator cancels the 2FA prompt', async () => {
    await withDir(async (dir) => {
      const { manager } = fakeManager()
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: fakeClient({ userId: '', requiresTwoFactor: true, twoFactorInfo: { two_factor_identifier: 'x' } }),
          callbacks: { onTwoFactorCode: async () => null },
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      if (status.ok) throw new Error('expected failure')
      expect(status.reason).toContain('cancelled')
    })
  })

  test('removes the partial checkpoint session when the checkpoint has no interactive prompt', async () => {
    await withDir(async (dir) => {
      const sessionPath = join(dir, 'session.json')
      const { manager } = fakeManagerWithSession(sessionPath)
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: checkpointWritingClient(),
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      expect(existsSync(sessionPath)).toBe(false)
    })
  })

  test('removes the partial checkpoint session when the operator cancels the checkpoint prompt', async () => {
    await withDir(async (dir) => {
      const sessionPath = join(dir, 'session.json')
      const { manager } = fakeManagerWithSession(sessionPath)
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: checkpointWritingClient(),
          callbacks: { onChallengeCode: async () => null },
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      expect(existsSync(sessionPath)).toBe(false)
    })
  })

  test('restores a pre-existing session when a checkpoint login fails', async () => {
    await withDir(async (dir) => {
      const sessionPath = join(dir, 'session.json')
      await writeFile(sessionPath, JSON.stringify({ user_id: 'existing', cookies: 'valid' }))
      const { manager } = fakeManagerWithSession(sessionPath)
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: checkpointWritingClient(),
          callbacks: { onChallengeCode: async () => null },
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      const restored = JSON.parse(await readFile(sessionPath, 'utf8')) as { user_id: string }
      expect(restored.user_id).toBe('existing')
    })
  })

  test('removes the partial checkpoint session when challengeSubmitCode throws', async () => {
    await withDir(async (dir) => {
      const sessionPath = join(dir, 'session.json')
      const { manager } = fakeManagerWithSession(sessionPath)
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: checkpointWritingClient({
            challengeSubmitCode: async () => {
              throw new Error('invalid verification code')
            },
          }),
          callbacks: { onChallengeCode: async () => ({ code: '000000' }) },
        },
        managedConfigDeps,
      )
      expect(status).toEqual({ ok: false, reason: 'invalid verification code' })
      expect(existsSync(sessionPath)).toBe(false)
    })
  })

  test('restores a pre-existing session when challengeSubmitCode throws', async () => {
    await withDir(async (dir) => {
      const sessionPath = join(dir, 'session.json')
      await writeFile(sessionPath, JSON.stringify({ user_id: 'existing', cookies: 'valid' }))
      const { manager } = fakeManagerWithSession(sessionPath)
      const status = await runInstagramBootstrap(
        {
          username: 'alice',
          password: 'secret',
          agentDir: dir,
          credentialManager: manager,
          client: checkpointWritingClient({
            challengeSubmitCode: async () => {
              throw new Error('network error')
            },
          }),
          callbacks: { onChallengeCode: async () => ({ code: '000000' }) },
        },
        managedConfigDeps,
      )
      expect(status.ok).toBe(false)
      const restored = JSON.parse(await readFile(sessionPath, 'utf8')) as { user_id: string }
      expect(restored.user_id).toBe('existing')
    })
  })
})
