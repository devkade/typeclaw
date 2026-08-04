import { join, posix } from 'node:path'

import type { WithAgentOperationLock } from '@/container/agent-operation-lock'
import { containerNameFromCwd, defaultDockerExec, type DockerExec, isGenuineMissingContainer } from '@/container/shared'

import { migrateAgentMessengerConfigDir, resolveAgentMessengerConfigPolicy } from './config-dir'

const CONTAINER_AGENT_DIR = '/agent'
const CONFIG_ENV_PREFIX = 'AGENT_MESSENGER_CONFIG_DIR='

export type HostAgentMessengerConfigResult = { ok: true; hostDir: string } | { ok: false; reason: string }

export type HostAgentMessengerConfigDeps = { exec?: DockerExec; operationLock?: WithAgentOperationLock }

export async function prepareAgentMessengerHostConfigDir(
  agentDir: string,
  deps: HostAgentMessengerConfigDeps = {},
): Promise<HostAgentMessengerConfigResult> {
  const exec = deps.exec ?? defaultDockerExec
  const containerName = containerNameFromCwd(agentDir)
  const inspected = await inspectRunningConfig(exec, containerName)
  if (!inspected.ok) return inspected

  if (inspected.state === 'running') {
    return mapContainerDirToHost(agentDir, inspected.containerDir)
  }

  try {
    const policy = resolveAgentMessengerConfigPolicy(agentDir)
    if (policy.migrate) {
      const reprobed = await inspectRunningConfig(exec, containerName)
      if (!reprobed.ok) return reprobed
      if (reprobed.state === 'running') {
        return {
          ok: false,
          reason: `Container ${containerName} became running while authentication was being prepared. No credentials were written; retry authentication.`,
        }
      }
      const migration = await migrateAgentMessengerConfigDir(agentDir)
      if (!migration.ok) return migration
    }
    return mapContainerDirToHost(agentDir, policy.containerDir)
  } catch (error) {
    return {
      ok: false,
      reason: `Could not prepare the host agent-messenger config directory: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

type RunningConfigInspection =
  | { ok: true; state: 'running'; containerDir: string }
  | { ok: true; state: 'stopped-or-missing' }
  | { ok: false; reason: string }

async function inspectRunningConfig(exec: DockerExec, containerName: string): Promise<RunningConfigInspection> {
  let result
  try {
    result = await exec(['inspect', '--format', '{{.State.Running}}\n{{json .Config.Env}}', containerName])
  } catch (error) {
    return indeterminateDockerState(error instanceof Error ? error.message : String(error))
  }

  if (result.exitCode !== 0) {
    if (isGenuineMissingContainer(result.stderr)) return { ok: true, state: 'stopped-or-missing' }
    return indeterminateDockerState(result.stderr.trim() || `docker inspect exited with code ${result.exitCode}`)
  }

  const parsed = parseInspectOutput(result.stdout)
  if (!parsed.ok) return indeterminateDockerState(parsed.reason)
  if (!parsed.running) return { ok: true, state: 'stopped-or-missing' }

  const activeEnv = parsed.env.find((entry) => entry.startsWith(CONFIG_ENV_PREFIX))
  const activeDir = activeEnv?.slice(CONFIG_ENV_PREFIX.length)
  // Empty means unset here to mirror the SDK's `override && override.length > 0` check.
  if (activeDir === undefined || activeDir.length === 0) {
    return {
      ok: false,
      reason:
        'The running TypeClaw container has no non-empty AGENT_MESSENGER_CONFIG_DIR and is using its in-container HOME fallback, which the host cannot write. Set AGENT_MESSENGER_CONFIG_DIR to a path under /agent or stop the container before authenticating.',
    }
  }
  return { ok: true, state: 'running', containerDir: posix.resolve(CONTAINER_AGENT_DIR, activeDir) }
}

function indeterminateDockerState(detail: string): { ok: false; reason: string } {
  return {
    ok: false,
    reason: `Could not determine whether the TypeClaw container is running; refusing to migrate or authenticate. Resolve Docker access and retry. ${detail}`,
  }
}

type ParsedInspectOutput = { ok: true; running: boolean; env: string[] } | { ok: false; reason: string }

function parseInspectOutput(stdout: string): ParsedInspectOutput {
  const lines = stdout.trimEnd().split('\n')
  if (lines.length !== 2 || (lines[0] !== 'true' && lines[0] !== 'false')) {
    return { ok: false, reason: 'docker inspect returned malformed running-state/config output' }
  }
  try {
    const env: unknown = JSON.parse(lines[1]!)
    if (!Array.isArray(env) || !env.every((entry) => typeof entry === 'string')) {
      return { ok: false, reason: 'docker inspect returned a malformed container environment' }
    }
    return { ok: true, running: lines[0] === 'true', env }
  } catch {
    return { ok: false, reason: 'docker inspect returned malformed environment JSON' }
  }
}

function mapContainerDirToHost(agentDir: string, containerDir: string): HostAgentMessengerConfigResult {
  const resolved = posix.resolve(CONTAINER_AGENT_DIR, containerDir)
  const relative = posix.relative(CONTAINER_AGENT_DIR, resolved)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
    return {
      ok: false,
      reason: `AGENT_MESSENGER_CONFIG_DIR resolves outside /agent (${resolved}) and cannot be mapped to the host agent directory. Set it to /agent or a path beneath /agent before authenticating.`,
    }
  }
  return { ok: true, hostDir: relative === '' ? agentDir : join(agentDir, ...relative.split('/')) }
}
