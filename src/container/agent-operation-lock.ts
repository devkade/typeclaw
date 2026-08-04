import { resolve } from 'node:path'

import lockfile from 'proper-lockfile'

import { agentOperationLockPath, ensureAgentOperationLocksDir } from '@/hostd/paths'

import { containerNameFromCwd } from './shared'

export type AgentOperation = 'start' | 'stop' | 'restart' | 'line-auth' | 'instagram-auth'
export type AgentOperationLease = { readonly containerName: string; readonly agentDir: string }
export type AgentOperationReservation =
  | { ok: true; lease: AgentOperationLease; release: () => Promise<void> }
  | { ok: false; reason: string }
export type ReserveAgentOperationLock = (input: {
  agentDir: string
  operation: AgentOperation
}) => Promise<AgentOperationReservation>
export type AgentOperationLockResult<T> = { ok: true; value: T } | { ok: false; reason: string }
export type WithAgentOperationLock = <T>(
  input: { agentDir: string; operation: AgentOperation; lease?: AgentOperationLease },
  run: (lease: AgentOperationLease) => Promise<T>,
) => Promise<AgentOperationLockResult<T>>

export const withAgentOperationLock: WithAgentOperationLock = async (input, run) => {
  const agentDir = resolve(input.agentDir)
  const containerName = containerNameFromCwd(agentDir)

  if (input.lease !== undefined) {
    if (input.lease.containerName !== containerName || resolve(input.lease.agentDir) !== agentDir) {
      return {
        ok: false,
        reason: `Agent operation lease does not match agent ${containerName} at ${agentDir}.`,
      }
    }
    return { ok: true, value: await run(input.lease) }
  }

  // Acquisition is deliberately outside the try that runs the operation: an
  // ELOCKED thrown from inside `run` (a nested lifecycle call) must not be
  // reported as contention for THIS lock.
  const reservation = await reserveAgentOperationLock(input)
  if (!reservation.ok) return reservation

  try {
    return { ok: true, value: await run(reservation.lease) }
  } finally {
    await reservation.release()
  }
}

export const reserveAgentOperationLock: ReserveAgentOperationLock = async (input) => {
  const agentDir = resolve(input.agentDir)
  const containerName = containerNameFromCwd(agentDir)
  const lease = { containerName, agentDir }
  await ensureAgentOperationLocksDir()
  const path = agentOperationLockPath(containerName)

  let releaseLock: () => Promise<void>
  try {
    // Interactive QR and checkpoint prompts can hold this lease for minutes, so
    // contenders fail after a bounded wait instead of queueing behind a human.
    releaseLock = await lockfile.lock(path, {
      lockfilePath: path,
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false },
    })
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') {
      return {
        ok: false,
        reason: `Another TypeClaw lifecycle or channel-auth operation is already in progress for agent \`${containerName}\`. Wait for it to finish, then retry. If the previous process was killed, the lock is reclaimed within 30 seconds.`,
      }
    }
    throw error
  }

  return { ok: true, lease, release: async () => await releaseLock().catch(() => {}) }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}
