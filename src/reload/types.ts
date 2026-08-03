export type ReloadResult =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

// An operator-initiated reload (CLI, agent tool, /reload) carries no cause and
// stays non-destructive for live adapters. A credential-rotation reload names
// the single adapter whose credential was just rewritten on disk, which is what
// authorizes the channels reloadable to bounce exactly that one adapter.
export type ReloadCause = { kind: 'credential-rotation'; adapter: string }

export type ReloadContext = { cause?: ReloadCause }

export type Reloadable = {
  scope: string
  description: string
  reload: (context?: ReloadContext) => Promise<ReloadResult>
}

export type ReloadAllResult = {
  results: ReloadResult[]
}
