import type { OperationalIncidentFact } from './classify-tool-outcome'

export type RemediationResult = { repaired: boolean }
export type RemediationHandler = (fact: OperationalIncidentFact) => Promise<RemediationResult>

export class RemediationRegistry {
  private readonly handlers = new Map<OperationalIncidentFact['kind'], RemediationHandler>()

  register(kind: OperationalIncidentFact['kind'], handler: RemediationHandler): void {
    this.handlers.set(kind, handler)
  }

  get(fact: OperationalIncidentFact): RemediationHandler | undefined {
    return this.handlers.get(fact.kind)
  }
}

export const operationalRemediations = new RemediationRegistry()

export type RepairAndRetryResult<T> =
  | { outcome: 'retried'; value: T }
  | { outcome: 'unhandled'; error: unknown }
  | { outcome: 'repair-failed'; error: unknown }
  | { outcome: 'retry-failed'; error: unknown }

export async function repairAndRetryOnce<T>(
  registry: RemediationRegistry,
  fact: OperationalIncidentFact,
  originalError: unknown,
  retry: () => Promise<T>,
): Promise<RepairAndRetryResult<T>> {
  const handler = registry.get(fact)
  if (handler === undefined) return { outcome: 'unhandled', error: originalError }
  const repaired = await handler(fact).catch(() => ({ repaired: false }))
  if (!repaired.repaired) return { outcome: 'repair-failed', error: originalError }
  try {
    return { outcome: 'retried', value: await retry() }
  } catch (retryError) {
    return { outcome: 'retry-failed', error: retryError }
  }
}
