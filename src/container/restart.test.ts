import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import type { AgentOperation, AgentOperationLease, WithAgentOperationLock } from './agent-operation-lock'
import { restart } from './restart'

describe('restart', () => {
  test('threads one lease through stop and start without reacquiring', async () => {
    const cwd = '/tmp/test-agent'
    const lease = { containerName: 'test-agent', agentDir: resolve(cwd) }
    const calls: Array<{ operation: string; lease?: AgentOperationLease }> = []
    const operationLock: WithAgentOperationLock = async <T>(
      input: { agentDir: string; operation: AgentOperation; lease?: AgentOperationLease },
      run: (lease: AgentOperationLease) => Promise<T>,
    ) => {
      calls.push({ operation: input.operation, lease: input.lease })
      if (input.operation === 'restart') return { ok: true, value: await run(lease) }
      if (input.operation === 'stop') {
        const value = { ok: true, containerName: lease.containerName, running: true }
        return { ok: true, value: value as T }
      }
      return { ok: true, value: successfulStart(lease.containerName) as T }
    }

    const result = await restart({ cwd, preferredHostPort: 8973, operationLock })

    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      { operation: 'restart', lease: undefined },
      { operation: 'stop', lease },
      { operation: 'start', lease },
    ])
  })

  test('short-circuits start when stop fails', async () => {
    const operations: string[] = []
    const operationLock: WithAgentOperationLock = async <T>(
      input: { agentDir: string; operation: AgentOperation; lease?: AgentOperationLease },
      run: (lease: AgentOperationLease) => Promise<T>,
    ) => {
      operations.push(input.operation)
      if (input.operation === 'restart') {
        return {
          ok: true,
          value: await run({ containerName: 'test-agent', agentDir: resolve(input.agentDir) }),
        }
      }
      return { ok: true, value: { ok: false, reason: 'cannot stop' } as T }
    }

    const result = await restart({ cwd: '/tmp/test-agent', preferredHostPort: 8973, operationLock })

    expect(result).toEqual({ ok: false, reason: 'stop failed: cannot stop' })
    expect(operations).toEqual(['restart', 'stop'])
  })
})

function successfulStart(containerName: string) {
  return {
    ok: true as const,
    plan: {
      containerName,
      imageTag: `${containerName}:latest`,
      buildContext: '/tmp/test-agent',
      dockerfile: '/tmp/test-agent/Dockerfile',
      runArgs: [],
      needsBuild: false,
      hostPort: 8973,
      tuiToken: null,
    },
    containerId: 'a'.repeat(64),
    built: false,
    hostPort: 8973,
    tuiToken: null,
    hostd: { state: 'disabled' as const },
    alreadyRunning: false,
    autoUpgrade: { kind: 'up-to-date' as const, installedVersion: '0.48.0' },
    skippedPlugins: [],
    dockerfileWarnings: [],
  }
}
