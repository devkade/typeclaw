import { resolve } from 'node:path'

import type {
  AgentOperation,
  AgentOperationLease,
  AgentOperationLockResult,
  WithAgentOperationLock,
} from '@/container/agent-operation-lock'
import { containerNameFromCwd } from '@/container/shared'

export class FakeAgentOperationCoordinator {
  readonly events: string[] = []
  readonly operationLock: WithAgentOperationLock

  private readonly active = new Set<string>()

  constructor(private readonly contentionReason = 'contended') {
    this.operationLock = async <T>(
      input: { agentDir: string; operation: AgentOperation; lease?: AgentOperationLease },
      run: (lease: AgentOperationLease) => Promise<T>,
    ): Promise<AgentOperationLockResult<T>> => {
      const agentDir = resolve(input.agentDir)
      const containerName = containerNameFromCwd(agentDir)
      const lease = { containerName, agentDir }
      if (input.lease !== undefined) {
        if (input.lease.containerName !== containerName || resolve(input.lease.agentDir) !== agentDir) {
          return { ok: false, reason: 'mismatched lease' }
        }
        return { ok: true, value: await run(input.lease) }
      }
      if (this.active.has(containerName)) {
        this.events.push(`lock-contention:${input.operation}`)
        return { ok: false, reason: this.contentionReason }
      }
      this.active.add(containerName)
      this.events.push(`lock-enter:${input.operation}`)
      try {
        return { ok: true, value: await run(lease) }
      } finally {
        this.events.push(`lock-exit:${input.operation}`)
        this.active.delete(containerName)
      }
    }
  }

  park(): { entered: Promise<void>; wait: () => Promise<void>; release: () => void } {
    const entered = deferred()
    const released = deferred()
    return {
      entered: entered.promise,
      wait: async () => {
        entered.resolve()
        await released.promise
      },
      release: () => released.resolve(),
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
