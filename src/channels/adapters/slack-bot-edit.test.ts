import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createSlackEditMessageCallback } from './slack-bot-edit'

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'slack-bot',
  workspace: 'T1',
  chat: 'C1',
  thread: null,
  messageId: '1700000000.000100',
  text: 'edited body',
  ...over,
})

type Captured = { url: string; body: URLSearchParams }

type FakeResponse = { body?: { ok?: boolean; error?: string }; status?: number; retryAfter?: string }

function fakeFetch(response: { ok?: boolean; error?: string }, capture?: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) })
    return new Response(JSON.stringify(response), { status: 200 }) as unknown as Response
  }) as unknown as typeof fetch
}

// Returns a fetch that replays the given responses in order (last one repeats),
// so a retry sequence like [429, 429, ok] can be exercised deterministically.
function sequenceFetch(responses: FakeResponse[], capture?: Captured[]): typeof fetch {
  let call = 0
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    const spec = responses[Math.min(call, responses.length - 1)]!
    call++
    capture?.push({ url: String(_url), body: new URLSearchParams(String(_init?.body ?? '')) })
    const headers = spec.retryAfter !== undefined ? { 'retry-after': spec.retryAfter } : undefined
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      ...(headers !== undefined ? { headers } : {}),
    }) as unknown as Response
  }) as unknown as typeof fetch
}

const noSleep = async () => {}

describe('createSlackEditMessageCallback', () => {
  it('calls chat.update with markdown_text (raw GFM) and returns ok', async () => {
    const calls: Captured[] = []
    const cb = createSlackEditMessageCallback({ token: 'xoxb-1', fetchImpl: fakeFetch({ ok: true }, calls) })

    const result = await cb(req({ text: '**bold** update' }))

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/chat.update')
    expect(calls[0]!.body.get('channel')).toBe('C1')
    expect(calls[0]!.body.get('ts')).toBe('1700000000.000100')
    // Raw GFM: Slack's markdown_text renders it natively — no hand-conversion.
    expect(calls[0]!.body.get('markdown_text')).toBe('**bold** update')
    // markdown_text must not be combined with text/blocks (markdown_text_conflict).
    expect(calls[0]!.body.get('text')).toBeNull()
    expect(calls[0]!.body.get('blocks')).toBeNull()
  })

  it('preserves a non-Latin (CJK) GFM body verbatim in markdown_text', async () => {
    const calls: Captured[] = []
    const cb = createSlackEditMessageCallback({ token: 'xoxb-1', fetchImpl: fakeFetch({ ok: true }, calls) })

    await cb(req({ text: '**状態の分布** 更新' }))

    expect(calls[0]!.body.get('markdown_text')).toBe('**状態の分布** 更新')
  })

  it('rejects a mismatched adapter as not-supported', async () => {
    const cb = createSlackEditMessageCallback({ token: 'xoxb-1', fetchImpl: fakeFetch({ ok: true }) })

    const result = await cb(req({ adapter: 'discord-bot' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: discord-bot', code: 'not-supported' })
  })

  it('maps message_not_found to not-found', async () => {
    const cb = createSlackEditMessageCallback({
      token: 'xoxb-1',
      fetchImpl: fakeFetch({ ok: false, error: 'message_not_found' }),
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('maps cant_update_message (not the author) to permission-denied', async () => {
    const cb = createSlackEditMessageCallback({
      token: 'xoxb-1',
      fetchImpl: fakeFetch({ ok: false, error: 'cant_update_message' }),
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('appends the scope hint on missing_scope', async () => {
    const cb = createSlackEditMessageCallback({
      token: 'xoxb-1',
      fetchImpl: fakeFetch({ ok: false, error: 'missing_scope' }),
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('permission-denied')
      expect(result.error).toContain('chat:write')
    }
  })

  it('maps a network throw to a transient (adapter-unavailable) failure without crashing', async () => {
    const throwingFetch = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const cb = createSlackEditMessageCallback({ token: 'xoxb-1', fetchImpl: throwingFetch })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('socket hang up')
      expect(result.code).toBe('adapter-unavailable')
    }
  })

  describe('rate limiting', () => {
    it('retries an HTTP 429 and succeeds on a later attempt', async () => {
      const calls: Captured[] = []
      const cb = createSlackEditMessageCallback({
        token: 'xoxb-1',
        fetchImpl: sequenceFetch([{ status: 429, retryAfter: '0' }, { status: 429 }, { body: { ok: true } }], calls),
        sleep: noSleep,
      })

      const result = await cb(req())

      expect(result).toEqual({ ok: true })
      expect(calls).toHaveLength(3)
    })

    it('retries a 200 body ratelimited error, then succeeds', async () => {
      const cb = createSlackEditMessageCallback({
        token: 'xoxb-1',
        fetchImpl: sequenceFetch([{ body: { ok: false, error: 'ratelimited' } }, { body: { ok: true } }]),
        sleep: noSleep,
      })

      const result = await cb(req())

      expect(result).toEqual({ ok: true })
    })

    it('honors the Retry-After header (seconds) when computing backoff', async () => {
      const sleeps: number[] = []
      const cb = createSlackEditMessageCallback({
        token: 'xoxb-1',
        fetchImpl: sequenceFetch([{ status: 429, retryAfter: '2' }, { body: { ok: true } }]),
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      })

      await cb(req())

      // Retry-After: 2s, first retry (attempt 0) -> 2 * 1000 * 1.
      expect(sleeps).toEqual([2000])
    })

    it('gives up after the retry budget and reports transient, never not-found', async () => {
      const calls: Captured[] = []
      const cb = createSlackEditMessageCallback({
        token: 'xoxb-1',
        fetchImpl: sequenceFetch([{ status: 429, retryAfter: '0' }], calls),
        sleep: noSleep,
      })

      const result = await cb(req())

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('adapter-unavailable')
        expect(result.code).not.toBe('not-found')
        expect(result.error).toContain('rate-limited')
      }
      // Initial attempt + 3 retries.
      expect(calls).toHaveLength(4)
    })
  })
})
