import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { DockerExec } from '@/container/shared'

import { prepareAgentMessengerHostConfigDir } from './host-config-dir'

describe('prepareAgentMessengerHostConfigDir', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-messenger-host-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('migrates a stopped legacy install and returns the new host path', async () => {
    const legacy = join(agentDir, 'workspace', '.agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'session.json'), 'legacy-session')

    const result = await prepareAgentMessengerHostConfigDir(agentDir, {
      exec: inspectResult('false', []),
    })

    expect(result).toEqual({ ok: true, hostDir: join(agentDir, 'workspace', '.config', 'agent-messenger') })
    expect(existsSync(legacy)).toBe(false)
    expect(await readFile(join(agentDir, 'workspace', '.config', 'agent-messenger', 'session.json'), 'utf8')).toBe(
      'legacy-session',
    )
  })

  test('re-probes before migration and refuses when the container became running', async () => {
    const legacy = join(agentDir, 'workspace', '.agent-messenger')
    const canonical = join(agentDir, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'session.json'), 'legacy-session')
    let inspections = 0
    const exec: DockerExec = async () => {
      inspections += 1
      return inspections === 1
        ? { exitCode: 0, stdout: 'false\n[]\n', stderr: '' }
        : {
            exitCode: 0,
            stdout: 'true\n["AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.config/agent-messenger"]\n',
            stderr: '',
          }
    }

    const result = await prepareAgentMessengerHostConfigDir(agentDir, { exec })

    expect(result).toEqual({
      ok: false,
      reason: `Container ${basename(agentDir)} became running while authentication was being prepared. No credentials were written; retry authentication.`,
    })
    expect(await readFile(join(legacy, 'session.json'), 'utf8')).toBe('legacy-session')
    expect(existsSync(canonical)).toBe(false)
  })

  test('uses a running container legacy env without changing either filesystem location', async () => {
    const legacy = join(agentDir, 'workspace', '.agent-messenger')
    const current = join(agentDir, 'workspace', '.config', 'agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'session.json'), 'live-session')

    const result = await prepareAgentMessengerHostConfigDir(agentDir, {
      exec: inspectResult('true', ['AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger']),
    })

    expect(result).toEqual({ ok: true, hostDir: legacy })
    expect(await readFile(join(legacy, 'session.json'), 'utf8')).toBe('live-session')
    expect(existsSync(current)).toBe(false)
  })

  test('fails closed on Docker daemon or permission errors without migrating', async () => {
    const legacy = join(agentDir, 'workspace', '.agent-messenger')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'session.json'), 'legacy-session')
    const exec: DockerExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'permission denied while trying to connect to the Docker daemon socket',
    })

    const result = await prepareAgentMessengerHostConfigDir(agentDir, { exec })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Could not determine whether the TypeClaw container is running')
    expect(await readFile(join(legacy, 'session.json'), 'utf8')).toBe('legacy-session')
    expect(existsSync(join(agentDir, 'workspace', '.config', 'agent-messenger'))).toBe(false)
  })

  test('rejects an unmappable running container path before host writes can begin', async () => {
    const result = await prepareAgentMessengerHostConfigDir(agentDir, {
      exec: inspectResult('true', ['AGENT_MESSENGER_CONFIG_DIR=/var/lib/agent-messenger']),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('outside /agent')
    expect(existsSync(join(agentDir, 'workspace'))).toBe(false)
  })

  test.each([
    ['an explicitly empty config env', ['AGENT_MESSENGER_CONFIG_DIR=']],
    ['an absent config env', []],
  ])('fails closed for a running container with %s', async (_label, env) => {
    const result = await prepareAgentMessengerHostConfigDir(agentDir, {
      exec: inspectResult('true', env),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('AGENT_MESSENGER_CONFIG_DIR')
    expect(result.reason).toContain('path under /agent')
    expect(result.reason).toContain('stop the container')
    expect(existsSync(join(agentDir, '.config'))).toBe(false)
    expect(existsSync(join(agentDir, 'session.json'))).toBe(false)
    expect(existsSync(join(agentDir, 'workspace'))).toBe(false)
  })

  test.each(['Error: No such container: tc-agent', 'Error: No such object: tc-agent'])(
    'treats a genuine missing-container response as stopped: %s',
    async (stderr) => {
      const legacy = join(agentDir, 'workspace', '.agent-messenger')
      await mkdir(legacy, { recursive: true })
      await writeFile(join(legacy, 'session.json'), 'legacy-session')
      const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr })

      const result = await prepareAgentMessengerHostConfigDir(agentDir, { exec })

      expect(result).toEqual({ ok: true, hostDir: join(agentDir, 'workspace', '.config', 'agent-messenger') })
      expect(existsSync(legacy)).toBe(false)
    },
  )
})

function inspectResult(running: 'true' | 'false', env: string[]): DockerExec {
  return async (args) => {
    expect(args).toEqual(['inspect', '--format', '{{.State.Running}}\n{{json .Config.Env}}', expect.any(String)])
    return { exitCode: 0, stdout: `${running}\n${JSON.stringify(env)}\n`, stderr: '' }
  }
}
