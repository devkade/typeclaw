import type { requestReloadWithFallback as RequestReloadWithFallback, ReloadResult } from '@/reload'

export type RenewableAdapter = 'kakaotalk' | 'webex' | 'teams'

export type CredentialRotationApplyInput = {
  containerName: string
  cwd: string
  adapter: RenewableAdapter
}

export type CredentialRotationApplyDeps = {
  resolveHostPort: (options: { cwd: string }) => Promise<number>
  resolveTuiToken: (options: { cwd: string }) => Promise<string | null>
  requestReloadWithFallback: typeof RequestReloadWithFallback
  restartContainer: (input: { containerName: string; cwd: string }) => Promise<{ ok: boolean; reason?: string }>
  timeoutMs?: number
}

export type CredentialRotationApplyResult =
  | { kind: 'reloaded'; transport: 'host' | 'container-local' }
  | { kind: 'restarted'; reloadError: string }
  | { kind: 'failed'; reloadError: string; restartError: string }

const DEFAULT_TIMEOUT_MS = 30_000

// Applying a renewed credential used to stop, remove and recreate the whole
// container, which killed every in-flight session, cron job and subagent on
// every OTHER channel too. Teams tokens expire every ~6h, so that fired ~4x a
// day. Bounce just the one adapter over the existing reload transport instead,
// and keep the container restart only as the fallback for when neither
// transport can reach the container at all.
export async function applyCredentialRotation(
  input: CredentialRotationApplyInput,
  deps: CredentialRotationApplyDeps,
): Promise<CredentialRotationApplyResult> {
  const reload = await requestAdapterReload(input, deps)
  if (reload.error === null) return { kind: 'reloaded', transport: reload.transport }

  const restart = await deps.restartContainer({ containerName: input.containerName, cwd: input.cwd })
  if (restart.ok) return { kind: 'restarted', reloadError: reload.error }
  return { kind: 'failed', reloadError: reload.error, restartError: restart.reason ?? 'restart failed' }
}

type AdapterReloadAttempt = { transport: 'host' | 'container-local'; error: string | null }

async function requestAdapterReload(
  { cwd, adapter }: CredentialRotationApplyInput,
  deps: CredentialRotationApplyDeps,
): Promise<AdapterReloadAttempt> {
  try {
    const port = await deps.resolveHostPort({ cwd })
    const token = await deps.resolveTuiToken({ cwd })
    const url = new URL(`ws://127.0.0.1:${port}`)
    if (token !== null) url.searchParams.set('token', token)

    const response = await deps.requestReloadWithFallback({
      url: url.toString(),
      cwd,
      token,
      scope: 'channels',
      cause: { kind: 'credential-rotation', adapter },
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    return { transport: response.transport, error: describeUnapplied(response.results, adapter) }
  } catch (err) {
    return { transport: 'host', error: err instanceof Error ? err.message : String(err) }
  }
}

// Only `stop-failed` warrants the fallback: the adapter is still live on the
// superseded credential, so nothing was applied. Every other outcome means the
// rotation landed or is landing — including `recovery-pending`, where the
// adapter is already down holding no stale token and supervision is retrying it
// on backoff. Recreating the container cannot fix a credential the platform
// rejected, so falling back there would destroy unrelated work for nothing.
function describeUnapplied(results: ReloadResult[], adapter: RenewableAdapter): string | null {
  const channels = results.find((result) => result.scope === 'channels')
  if (channels === undefined) return 'channels scope missing from reload result'
  if (!channels.ok) return channels.reason

  const applied = readCredentialApply(channels.details)
  if (applied === null || applied.adapter !== adapter) return `reload did not apply the ${adapter} credential`
  if (applied.outcome === 'stop-failed') return `${adapter} adapter could not be stopped to apply the credential`
  return null
}

function readCredentialApply(details: unknown): { adapter: string; outcome: string } | null {
  if (typeof details !== 'object' || details === null) return null
  const candidate = (details as { credentialApply?: unknown }).credentialApply
  if (typeof candidate !== 'object' || candidate === null) return null
  const { adapter, outcome } = candidate as { adapter?: unknown; outcome?: unknown }
  if (typeof adapter !== 'string' || typeof outcome !== 'string') return null
  return { adapter, outcome }
}
