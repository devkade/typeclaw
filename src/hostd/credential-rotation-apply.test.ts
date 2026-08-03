import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelManager } from '@/channels/manager'
import { createChannelsReloadable } from '@/channels/reloadable'
import { defaultHistoryConfig } from '@/channels/schema'
import type { ReloadResult } from '@/reload'
import { createFileSecretsProvider } from '@/secrets/secrets-provider'

import {
  applyCredentialRotation,
  type CredentialRotationApplyDeps,
  type RenewableAdapter,
} from './credential-rotation-apply'

type ReloadCall = { url: string; scope?: string; cause?: unknown; cwd?: string; token?: string | null }

function channelsResult(details?: unknown): ReloadResult[] {
  return [{ scope: 'channels', ok: true, summary: 'applied', ...(details === undefined ? {} : { details }) }]
}

function applied(adapter: RenewableAdapter, outcome: string): unknown {
  return { credentialApply: { adapter, outcome } }
}

function makeDeps(overrides: Partial<CredentialRotationApplyDeps> = {}): {
  deps: CredentialRotationApplyDeps
  reloadCalls: ReloadCall[]
  restartCalls: string[]
} {
  const reloadCalls: ReloadCall[] = []
  const restartCalls: string[] = []
  const deps: CredentialRotationApplyDeps = {
    resolveHostPort: async () => 12345,
    resolveTuiToken: async () => 'tok',
    requestReloadWithFallback: async (options) => {
      reloadCalls.push({
        url: options.url,
        scope: options.scope,
        cause: options.cause,
        cwd: options.cwd,
        token: options.token,
      })
      return { transport: 'host', results: channelsResult(applied('teams', 'restarted')) }
    },
    restartContainer: async ({ containerName }) => {
      restartCalls.push(containerName)
      return { ok: true }
    },
    ...overrides,
  }
  return { deps, reloadCalls, restartCalls }
}

const input = { containerName: 'agent', cwd: '/agent', adapter: 'teams' as const }

describe('applyCredentialRotation', () => {
  test('applies the credential over reload without restarting the container', async () => {
    const { deps, reloadCalls, restartCalls } = makeDeps()

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'reloaded', transport: 'host' })
    expect(restartCalls).toEqual([])
    expect(reloadCalls).toHaveLength(1)
    expect(reloadCalls[0]?.scope).toBe('channels')
    expect(reloadCalls[0]?.cause).toEqual({ kind: 'credential-rotation', adapter: 'teams' })
  })

  test('names the adapter being renewed, not a hardcoded one', async () => {
    const { deps, reloadCalls } = makeDeps({
      requestReloadWithFallback: async (options) => {
        reloadCalls.push({ url: options.url, scope: options.scope, cause: options.cause })
        return { transport: 'host', results: channelsResult(applied('webex', 'restarted')) }
      },
    })

    await applyCredentialRotation({ ...input, adapter: 'webex' }, deps)

    expect(reloadCalls.at(-1)?.cause).toEqual({ kind: 'credential-rotation', adapter: 'webex' })
  })

  test('passes cwd and token so the container-local fallback can be used', async () => {
    const { deps, reloadCalls } = makeDeps()

    await applyCredentialRotation(input, deps)

    expect(reloadCalls[0]?.cwd).toBe('/agent')
    expect(reloadCalls[0]?.token).toBe('tok')
    expect(reloadCalls[0]?.url).toContain('token=tok')
  })

  test('reports the container-local transport when the host socket was unusable', async () => {
    const { deps } = makeDeps({
      requestReloadWithFallback: async () => ({
        transport: 'container-local',
        results: channelsResult(applied('teams', 'restarted')),
        hostError: 'connect refused',
      }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'reloaded', transport: 'container-local' })
  })

  test('falls back to a container restart when both reload transports fail', async () => {
    const { deps, restartCalls } = makeDeps({
      requestReloadWithFallback: async () => {
        throw new Error('docker exec failed')
      },
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'restarted', reloadError: 'docker exec failed' })
    expect(restartCalls).toEqual(['agent'])
  })

  test('falls back to a container restart when the channels scope reload failed', async () => {
    const { deps, restartCalls } = makeDeps({
      requestReloadWithFallback: async () => ({
        transport: 'host',
        results: [{ scope: 'channels', ok: false, reason: 'manager exploded' }],
      }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'restarted', reloadError: 'manager exploded' })
    expect(restartCalls).toEqual(['agent'])
  })

  test('falls back to a container restart when the adapter could not be stopped', async () => {
    const { deps, restartCalls } = makeDeps({
      requestReloadWithFallback: async () => ({
        transport: 'host',
        results: channelsResult(applied('teams', 'stop-failed')),
      }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result.kind).toBe('restarted')
    expect(restartCalls).toEqual(['agent'])
  })

  test('falls back to a container restart when the reload applied nothing', async () => {
    const { deps, restartCalls } = makeDeps({
      requestReloadWithFallback: async () => ({ transport: 'host', results: channelsResult() }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result.kind).toBe('restarted')
    expect(restartCalls).toEqual(['agent'])
  })

  // Recreating the container cannot fix a credential the platform rejected, and
  // the adapter is already down holding no stale token, so restarting here would
  // destroy unrelated in-flight work for nothing.
  test('does not restart the container when the adapter is already under supervision', async () => {
    const { deps, restartCalls } = makeDeps({
      requestReloadWithFallback: async () => ({
        transport: 'host',
        results: channelsResult(applied('teams', 'recovery-pending')),
      }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'reloaded', transport: 'host' })
    expect(restartCalls).toEqual([])
  })

  test('reports both errors when the reload and the fallback restart fail', async () => {
    const { deps } = makeDeps({
      requestReloadWithFallback: async () => {
        throw new Error('unreachable')
      },
      restartContainer: async () => ({ ok: false, reason: 'docker down' }),
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result).toEqual({ kind: 'failed', reloadError: 'unreachable', restartError: 'docker down' })
  })

  // The reviewed regression: an expired token is exactly what knocks an adapter
  // into the failed map, so this is the ordinary shape of a renewal, not an edge
  // case. Runs the real manager and reloadable so a future refactor that stops
  // reporting the outcome is caught here rather than in production.
  test('does not restart the container when renewal revives an adapter that was down', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-credrotate-e2e-'))
    await writeKakaoSecrets(agentDir, 'expired')

    let tokenAccepted = false
    const adapter = {
      startCalls: 0,
      async start() {
        if (!tokenAccepted) throw new Error('token rejected')
        adapter.startCalls++
      },
      async stop() {},
      isConnected: () => tokenAccepted,
    }
    const cfg = { kakaotalk: enabledKakaoCfg() }
    const manager = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { TYPECLAW_CONTAINER_NAME: 'typeclaw-test' },
      secretsProvider: createFileSecretsProvider(join(agentDir, 'secrets.json')),
      createKakaotalkAdapter: () => adapter,
    })
    await manager.start()
    expect(adapter.startCalls).toBe(0)

    const reloadable = createChannelsReloadable({ manager })
    const restartCalls: string[] = []
    const deps: CredentialRotationApplyDeps = {
      resolveHostPort: async () => 12345,
      resolveTuiToken: async () => null,
      requestReloadWithFallback: async (options) => ({
        transport: 'host',
        results: [await reloadable.reload(options.cause ? { cause: options.cause } : undefined)],
      }),
      restartContainer: async ({ containerName }) => {
        restartCalls.push(containerName)
        return { ok: true }
      },
    }

    tokenAccepted = true
    await writeKakaoSecrets(agentDir, 'renewed')
    const result = await applyCredentialRotation({ containerName: 'agent', cwd: agentDir, adapter: 'kakaotalk' }, deps)

    expect(adapter.startCalls).toBe(1)
    expect(result).toEqual({ kind: 'reloaded', transport: 'host' })
    expect(restartCalls).toEqual([])

    await manager.stop()
  })

  test('falls back to a container restart when the host port cannot be resolved', async () => {
    const { deps, restartCalls } = makeDeps({
      resolveHostPort: async () => {
        throw new Error('container not running')
      },
    })

    const result = await applyCredentialRotation(input, deps)

    expect(result.kind).toBe('restarted')
    expect(restartCalls).toEqual(['agent'])
  })
})

function enabledKakaoCfg() {
  return {
    enabled: true,
    engagement: {
      trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
      stickiness: { perReply: { window: 300_000 } },
    },
    history: defaultHistoryConfig(),
  }
}

async function writeKakaoSecrets(dir: string, accountId: string): Promise<void> {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        kakaotalk: {
          currentAccount: accountId,
          accounts: {
            [accountId]: {
              account_id: accountId,
              oauth_token: `oauth-${accountId}`,
              user_id: accountId,
              device_uuid: `device-${accountId}`,
              device_type: 'tablet',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
    }),
  )
}
