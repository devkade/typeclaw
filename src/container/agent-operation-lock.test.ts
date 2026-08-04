import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { reserveAgentOperationLock, withAgentOperationLock } from './agent-operation-lock'
import { containerNameFromCwd } from './shared'

let root: string
let previousHome: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-agent-lock-'))
  previousHome = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = join(root, 'home')
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = previousHome
  await rm(root, { recursive: true, force: true })
})

describe('withAgentOperationLock', () => {
  test('contends for the same agent while allowing a different agent', async () => {
    const firstAgent = join(root, 'alpha')
    const secondAgent = join(root, 'bravo')
    await mkdir(firstAgent)
    await mkdir(secondAgent)
    const holder = deferred<void>()
    const entered = deferred<void>()

    const first = withAgentOperationLock({ agentDir: firstAgent, operation: 'line-auth' }, async () => {
      entered.resolve()
      await holder.promise
      return 'first'
    })
    await entered.promise

    const different = await withAgentOperationLock({ agentDir: secondAgent, operation: 'start' }, async () => 'second')
    const contended = await withAgentOperationLock({ agentDir: firstAgent, operation: 'stop' }, async () => 'never')

    expect(different).toEqual({ ok: true, value: 'second' })
    expect(contended).toEqual({
      ok: false,
      reason: `Another TypeClaw lifecycle or channel-auth operation is already in progress for agent \`${containerNameFromCwd(firstAgent)}\`. Wait for it to finish, then retry. If the previous process was killed, the lock is reclaimed within 30 seconds.`,
    })

    holder.resolve()
    expect(await first).toEqual({ ok: true, value: 'first' })
  })

  test('a matching lease skips reacquisition', async () => {
    const agentDir = join(root, 'alpha')
    await mkdir(agentDir)

    const result = await withAgentOperationLock({ agentDir, operation: 'restart' }, async (lease) => {
      return await withAgentOperationLock({ agentDir, operation: 'start', lease }, async (innerLease) => innerLease)
    })

    expect(result).toEqual({
      ok: true,
      value: {
        ok: true,
        value: { containerName: containerNameFromCwd(agentDir), agentDir: resolve(agentDir) },
      },
    })
  })

  test('a mismatched lease fails without running the operation', async () => {
    const agentDir = join(root, 'alpha')
    await mkdir(agentDir)
    let ran = false

    const result = await withAgentOperationLock(
      {
        agentDir,
        operation: 'start',
        lease: { containerName: `typeclaw-${basename(root)}`, agentDir: root },
      },
      async () => {
        ran = true
      },
    )

    expect(result.ok).toBe(false)
    expect(ran).toBe(false)
    if (result.ok) throw new Error('expected mismatched lease failure')
    expect(result.reason).toContain('does not match')
  })
})

describe('reserveAgentOperationLock', () => {
  test('holds one agent lock until release while allowing a different agent', async () => {
    const firstAgent = join(root, 'alpha')
    const secondAgent = join(root, 'bravo')
    await mkdir(firstAgent)
    await mkdir(secondAgent)

    const first = await reserveAgentOperationLock({ agentDir: firstAgent, operation: 'line-auth' })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected first reservation to succeed')

    const different = await reserveAgentOperationLock({ agentDir: secondAgent, operation: 'restart' })
    expect(different.ok).toBe(true)
    if (!different.ok) throw new Error('expected different agent reservation to succeed')

    const contended = await reserveAgentOperationLock({ agentDir: firstAgent, operation: 'restart' })
    expect(contended).toEqual({
      ok: false,
      reason: `Another TypeClaw lifecycle or channel-auth operation is already in progress for agent \`${containerNameFromCwd(firstAgent)}\`. Wait for it to finish, then retry. If the previous process was killed, the lock is reclaimed within 30 seconds.`,
    })

    await first.release()
    const subsequent = await reserveAgentOperationLock({ agentDir: firstAgent, operation: 'stop' })
    expect(subsequent.ok).toBe(true)
    if (!subsequent.ok) throw new Error('expected reservation after release to succeed')

    await subsequent.release()
    await different.release()
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}
