import type { CurrentHostDaemon } from '@/container'
import {
  type AgentOperationLease,
  reserveAgentOperationLock,
  type ReserveAgentOperationLock,
} from '@/container/agent-operation-lock'

import type { Response } from './protocol'

export type SupervisorRestart = (input: {
  containerName: string
  cwd: string
  // When true, the underlying `start()` runs with `forceBuild: true`, which
  // regenerates the Dockerfile from the current CLI template AND rebuilds the
  // image even if it already exists. Default false matches the host-side
  // `typeclaw restart` (no `--build` flag) behavior.
  build?: boolean
  // Injected by the daemon so the restart registers the container in-process
  // instead of over the socket — see CurrentHostDaemon docs in src/container.
  currentHostDaemon?: CurrentHostDaemon
  operationLease?: AgentOperationLease
}) => Promise<{ ok: true } | { ok: false; reason: string }>

export type SupervisorOptions = {
  restart?: SupervisorRestart
}

export type SupervisorLogEvent =
  | { kind: 'restart-scheduled'; containerName: string; build: boolean }
  | { kind: 'restart-completed'; containerName: string }
  | { kind: 'restart-failed'; containerName: string; reason: string }

export type Supervisor = {
  scheduleRestart: (input: {
    containerName: string
    cwd: string
    build?: boolean
    currentHostDaemon?: CurrentHostDaemon
  }) => Promise<Response>
}

export type SupervisorBuildOptions = {
  restart: SupervisorRestart
  onLog: (event: SupervisorLogEvent) => void
  isStopped: () => boolean
  reserveLock?: ReserveAgentOperationLock
}

// The daemon reserves the lifecycle lock before ACKing, then runs stop+start in
// the background so the agent's RPC connection can close before `docker stop`.
// The requester exits about 500 ms after the ACK, so a lock failure discovered
// later would be invisible; rejecting the ACK lets the agent surface and retry
// the error. Failures after scheduling are still surfaced through the log channel.
export function buildSupervisor({
  restart,
  onLog,
  isStopped,
  reserveLock = reserveAgentOperationLock,
}: SupervisorBuildOptions): Supervisor {
  return {
    scheduleRestart: async ({ containerName, cwd, build = false, currentHostDaemon }): Promise<Response> => {
      if (isStopped()) return { ok: false, reason: 'daemon stopping' }
      const reservation = await reserveLock({ agentDir: cwd, operation: 'restart' })
      if (!reservation.ok) return { ok: false, reason: reservation.reason }
      onLog({ kind: 'restart-scheduled', containerName, build })
      void runRestart(reservation.lease, reservation.release)
      return { ok: true }

      async function runRestart(lease: AgentOperationLease, release: () => Promise<void>): Promise<void> {
        try {
          const result = await restart({
            containerName,
            cwd,
            build,
            operationLease: lease,
            ...(currentHostDaemon ? { currentHostDaemon } : {}),
          })
          if (result.ok) onLog({ kind: 'restart-completed', containerName })
          else onLog({ kind: 'restart-failed', containerName, reason: result.reason })
        } catch (error) {
          onLog({
            kind: 'restart-failed',
            containerName,
            reason: error instanceof Error ? error.message : String(error),
          })
        } finally {
          await release().catch(() => {})
        }
      }
    },
  }
}
