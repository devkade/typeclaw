import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

import { describeError } from '../describe-error'

const SLACK_API_BASE = 'https://slack.com/api'

// Mirrors the agent-messenger SlackBotClient.withRetry budget (3 retries on
// `ratelimited`), which this direct chat.update call replaces. Without it, a
// transient 429 during a burst would surface as a hard edit failure.
const MAX_RATE_LIMIT_RETRIES = 3
const DEFAULT_RETRY_AFTER_SECONDS = 1

type EditErrorCode = NonNullable<(EditMessageResult & { ok: false })['code']>

// The agent emits GitHub-Flavored Markdown. Slack's `chat.update` accepts a
// native `markdown_text` field that renders GFM correctly (bold `**` -> `*`,
// headings, tables), so edits reuse Slack's own renderer with no lossy
// hand-conversion — mirroring the `markdown` block used on the post path.
// `markdown_text` must not be combined with `text`/`blocks` or Slack returns
// `markdown_text_conflict`. The `agent-messenger` SDK's updateMessage only
// forwards `text`, so we call chat.update directly with the adapter token —
// and re-implement the SDK's rate-limit retry here (see MAX_RATE_LIMIT_RETRIES).
export function createSlackEditMessageCallback(deps: {
  token: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}): EditMessageCallback {
  const fetchFn = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    const body = new URLSearchParams({
      channel: req.chat,
      ts: req.messageId,
      markdown_text: req.text,
    }).toString()

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      let response: Response
      try {
        response = await fetchFn(`${SLACK_API_BASE}/chat.update`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${deps.token}`,
            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body,
        })
      } catch (err) {
        // Network throw is transient, not a missing target — surface as
        // adapter-unavailable so the caller can distinguish it from a 404.
        return { ok: false, error: describeError(err), code: 'adapter-unavailable' }
      }

      const raw = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (raw.ok === true) return { ok: true }
      const code = raw.error ?? null

      // Slack signals throttling with HTTP 429 (+ Retry-After header) and/or a
      // `ratelimited` body error. Retry within budget honoring Retry-After;
      // once exhausted, surface as transient (adapter-unavailable), never 404.
      if (response.status === 429 || code === 'ratelimited') {
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          await sleep(retryAfterMs(response, attempt))
          continue
        }
        return {
          ok: false,
          error: `Slack rate-limited chat.update after ${MAX_RATE_LIMIT_RETRIES} retries (ratelimited)`,
          code: 'adapter-unavailable',
        }
      }

      return { ok: false, error: withScopeHint(code, code ?? 'unknown slack error'), code: classifyEditError(code) }
    }
    // Unreachable: the loop returns on every path, but TS needs a terminal.
    return { ok: false, error: 'unreachable', code: 'adapter-unavailable' }
  }
}

// Retry-After is in seconds per Slack's docs; fall back to a 1s base and grow
// it linearly per attempt (matching the SDK's `retryAfter * (attempt+1)`).
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  const seconds = header !== null && header !== '' ? Number.parseInt(header, 10) : DEFAULT_RETRY_AFTER_SECONDS
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS
  return base * 1000 * (attempt + 1)
}

// `chat:write` is the scope the bot token needs to edit its own messages;
// `cant_update_message` fires when the bot did not author the target, and
// `message_not_found` when the ts is wrong or the post is gone.
function withScopeHint(code: string | null, error: string): string {
  if (code !== 'missing_scope') return error
  return `${error} (Slack bot token needs the \`chat:write\` scope; reinstall/reauthorize the app with that scope.)`
}

function classifyEditError(code: string | null): EditErrorCode {
  switch (code) {
    case 'message_not_found':
    case 'channel_not_found':
      return 'not-found'
    case 'cant_update_message':
    case 'edit_window_closed':
    case 'missing_scope':
    case 'not_in_channel':
    case 'is_archived':
    case 'not_authed':
    case 'invalid_auth':
      return 'permission-denied'
    // Transient Slack-side failures the agent should treat as retryable, not
    // as a missing/forbidden target.
    case 'ratelimited':
    case 'service_unavailable':
    case 'fatal_error':
    case 'internal_error':
      return 'adapter-unavailable'
    default:
      return 'not-found'
  }
}
