import { describe, expect, test } from 'bun:test'

import { RemediationRegistry, repairAndRetryOnce } from './remediations'

describe('repairAndRetryOnce', () => {
  test('runs an allowlisted handler and retries exactly once', async () => {
    const registry = new RemediationRegistry()
    let repairs = 0
    let attempts = 0
    const fact = { kind: 'sandbox-proc-unavailable' as const }
    registry.register('sandbox-proc-unavailable', async () => {
      repairs += 1
      return { repaired: true }
    })

    const result = await repairAndRetryOnce(registry, fact, new Error('first failure'), async () => {
      attempts += 1
      return 'ok'
    })

    expect(result).toEqual({ outcome: 'retried', value: 'ok' })
    expect(repairs).toBe(1)
    expect(attempts).toBe(1)
  })

  test('unknown incidents receive no action and no retry', async () => {
    const registry = new RemediationRegistry()
    let attempts = 0
    const original = new Error('failure')
    const result = await repairAndRetryOnce(
      registry,
      { kind: 'bash-command-not-found', bin: 'opensoma' },
      original,
      async () => {
        attempts += 1
        throw new Error('retry should not run')
      },
    )

    expect(result).toEqual({ outcome: 'unhandled', error: original })
    expect(attempts).toBe(0)
  })

  test('one classifier registration handles every normalized fingerprint in that class', async () => {
    const registry = new RemediationRegistry()
    const repairedBins: string[] = []
    registry.register('bash-command-not-found', async (fact) => {
      if (fact.kind === 'bash-command-not-found') repairedBins.push(fact.bin)
      return { repaired: true }
    })

    for (const bin of ['opensoma', 'another-cli']) {
      const result = await repairAndRetryOnce(
        registry,
        { kind: 'bash-command-not-found', bin },
        new Error('failure'),
        async () => 'ok',
      )
      expect(result.outcome).toBe('retried')
    }

    expect(repairedBins).toEqual(['opensoma', 'another-cli'])
  })

  test('registration is idempotent for session setup and uses the latest handler', async () => {
    const registry = new RemediationRegistry()
    const handlers: string[] = []
    registry.register('sandbox-proc-unavailable', async () => {
      handlers.push('first')
      return { repaired: true }
    })
    expect(() =>
      registry.register('sandbox-proc-unavailable', async () => {
        handlers.push('second')
        return { repaired: true }
      }),
    ).not.toThrow()

    await repairAndRetryOnce(registry, { kind: 'sandbox-proc-unavailable' }, new Error('failure'), async () => 'ok')

    expect(handlers).toEqual(['second'])
  })

  test('a failed retry returns the retry failure without another attempt', async () => {
    const registry = new RemediationRegistry()
    registry.register('sandbox-proc-unavailable', async () => ({ repaired: true }))
    let attempts = 0
    const result = await repairAndRetryOnce(
      registry,
      { kind: 'sandbox-proc-unavailable' },
      new Error('initial failure'),
      async () => {
        attempts += 1
        throw new Error('retry failure')
      },
    )

    expect(result).toEqual({ outcome: 'retry-failed', error: expect.objectContaining({ message: 'retry failure' }) })
    expect(attempts).toBe(1)
  })

  test('a failed repair does not retry the operation', async () => {
    const registry = new RemediationRegistry()
    registry.register('sandbox-proc-unavailable', async () => ({ repaired: false }))
    let attempts = 0
    const original = new Error('failure')
    const result = await repairAndRetryOnce(registry, { kind: 'sandbox-proc-unavailable' }, original, async () => {
      attempts += 1
      throw new Error('retry should not run')
    })

    expect(result).toEqual({ outcome: 'repair-failed', error: original })
    expect(attempts).toBe(0)
  })
})
