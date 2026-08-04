import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type AgentOperationLease,
  reserveAgentOperationLock,
  type ReserveAgentOperationLock,
} from '@/container/agent-operation-lock'

import { buildSupervisor, type SupervisorLogEvent, type SupervisorRestart } from './supervisor'

describe('buildSupervisor', () => {
  test('rejects before scheduling when reservation fails', async () => {
    const logs: SupervisorLogEvent[] = []
    let restartCalls = 0
    const supervisor = buildSupervisor({
      restart: async () => {
        restartCalls += 1
        return { ok: true }
      },
      reserveLock: async () => ({ ok: false, reason: 'lock contended' }),
      onLog: (event) => logs.push(event),
      isStopped: () => false,
    })

    const result = await supervisor.scheduleRestart({ containerName: 'agent', cwd: '/agent' })

    expect(result).toEqual({ ok: false, reason: 'lock contended' })
    expect(restartCalls).toBe(0)
    expect(logs).not.toContainEqual({ kind: 'restart-scheduled', containerName: 'agent', build: false })
  })

  test.each([
    ['success', { ok: true } as const],
    ['failure', { ok: false, reason: 'restart failed' } as const],
  ])('passes the reserved lease and releases it once after %s', async (_name, restartResult) => {
    const lease: AgentOperationLease = { containerName: 'agent', agentDir: resolve('/agent') }
    const restartSettled = deferred<void>()
    const released = deferred<void>()
    const restartCalls: AgentOperationLease[] = []
    let releaseCalls = 0
    const restart: SupervisorRestart = async (input) => {
      if (input.operationLease) restartCalls.push(input.operationLease)
      await restartSettled.promise
      return restartResult
    }
    const reserveLock: ReserveAgentOperationLock = async () => ({
      ok: true,
      lease,
      release: async () => {
        releaseCalls += 1
        released.resolve()
      },
    })
    const supervisor = buildSupervisor({ restart, reserveLock, onLog: () => {}, isStopped: () => false })

    expect(await supervisor.scheduleRestart({ containerName: 'agent', cwd: '/agent' })).toEqual({ ok: true })
    expect(restartCalls).toEqual([lease])
    expect(restartCalls[0]).toBe(lease)
    expect(releaseCalls).toBe(0)

    restartSettled.resolve()
    await released.promise
    expect(releaseCalls).toBe(1)
  })

  test('short-circuits a stopped daemon before reservation', async () => {
    let reservationCalls = 0
    const supervisor = buildSupervisor({
      restart: async () => ({ ok: true }),
      reserveLock: async () => {
        reservationCalls += 1
        return { ok: false, reason: 'unexpected' }
      },
      onLog: () => {},
      isStopped: () => true,
    })

    expect(await supervisor.scheduleRestart({ containerName: 'agent', cwd: '/agent' })).toEqual({
      ok: false,
      reason: 'daemon stopping',
    })
    expect(reservationCalls).toBe(0)
  })
})

describe('restart lock orchestration', () => {
  let root: string
  let previousHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'typeclaw-supervisor-lock-'))
    previousHome = process.env.TYPECLAW_HOME
    process.env.TYPECLAW_HOME = join(root, 'home')
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.TYPECLAW_HOME
    else process.env.TYPECLAW_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })

  test('rejects the ACK while an auth operation holds the agent lock', async () => {
    const agentDir = join(root, 'agent')
    await mkdir(agentDir)
    const authReservation = await reserveAgentOperationLock({ agentDir, operation: 'instagram-auth' })
    expect(authReservation.ok).toBe(true)
    if (!authReservation.ok) throw new Error('expected auth reservation to succeed')
    let restartCalls = 0
    const supervisor = buildSupervisor({
      restart: async () => {
        restartCalls += 1
        return { ok: true }
      },
      onLog: () => {},
      isStopped: () => false,
    })

    const ack = await supervisor.scheduleRestart({ containerName: 'agent', cwd: agentDir })

    expect(ack.ok).toBe(false)
    expect(restartCalls).toBe(0)
    await authReservation.release()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolvePromiseValue) => {
    resolvePromise = resolvePromiseValue
  })
  return { promise, resolve: resolvePromise }
}
