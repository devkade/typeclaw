import { describe, expect, test } from 'bun:test'

import type { ReloadContext } from '@/reload'

import type { ChannelManager, ChannelReloadDiff, ChannelReloadOptions } from './manager'
import { createChannelsReloadable } from './reloadable'

function emptyDiff(overrides: Partial<ChannelReloadDiff> = {}): ChannelReloadDiff {
  return { started: [], stopped: [], restarted: [], restartRequired: [], ...overrides }
}

function makeManager(reload: (options?: ChannelReloadOptions) => Promise<ChannelReloadDiff>): {
  manager: Pick<ChannelManager, 'reload'>
  calls: (ChannelReloadOptions | undefined)[]
} {
  const calls: (ChannelReloadOptions | undefined)[] = []
  const manager = {
    reload: async (options?: ChannelReloadOptions) => {
      calls.push(options)
      return await reload(options)
    },
  }
  return { manager, calls }
}

async function reloadWith(
  context: ReloadContext | undefined,
  diff: ChannelReloadDiff = emptyDiff(),
): Promise<{
  calls: (ChannelReloadOptions | undefined)[]
  result: Awaited<ReturnType<ReturnType<typeof createChannelsReloadable>['reload']>>
}> {
  const { manager, calls } = makeManager(async () => diff)
  const result = await createChannelsReloadable({ manager }).reload(context)
  return { calls, result }
}

describe('channels reloadable', () => {
  test('an operator reload does not authorize bouncing any adapter', async () => {
    const { calls } = await reloadWith(undefined)

    expect(calls[0]?.applyCredentialRotation).toBeUndefined()
  })

  test('forwards the named adapter from a credential-rotation cause', async () => {
    const { calls } = await reloadWith({ cause: { kind: 'credential-rotation', adapter: 'teams' } })

    expect(calls[0]).toEqual({ applyCredentialRotation: 'teams' })
  })

  // The adapter name arrives off the wire. Anything unrecognized must degrade to
  // a plain reload rather than being forwarded into a destructive code path.
  test('ignores a cause naming an adapter that does not exist', async () => {
    const { calls } = await reloadWith({ cause: { kind: 'credential-rotation', adapter: 'not-an-adapter' } })

    expect(calls[0]?.applyCredentialRotation).toBeUndefined()
  })

  test('reports restarted adapters in the summary', async () => {
    const { result } = await reloadWith(
      { cause: { kind: 'credential-rotation', adapter: 'teams' } },
      emptyDiff({ restarted: ['teams'] }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.summary).toContain('1 restarted')
  })

  test('still reports rotations it was not authorized to apply', async () => {
    const { result } = await reloadWith(undefined, emptyDiff({ restartRequired: ['teams (credential rotation)'] }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.summary).toContain('1 restart-required')
  })

  test('surfaces the credential-apply outcome to the caller', async () => {
    const diff = emptyDiff({ restarted: ['teams'], credentialApply: { adapter: 'teams', outcome: 'restarted' } })
    const { result } = await reloadWith({ cause: { kind: 'credential-rotation', adapter: 'teams' } }, diff)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.details).toEqual(diff)
  })

  test('reports a failing manager instead of throwing', async () => {
    const { manager } = makeManager(async () => {
      throw new Error('manager exploded')
    })

    const result = await createChannelsReloadable({ manager }).reload()

    expect(result).toEqual({ scope: 'channels', ok: false, reason: 'manager exploded' })
  })
})
