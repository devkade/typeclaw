import { hooklessGitArgs } from './hookless'
import { resolveAgentGit } from './resolve-agent-git'

// Machine-local `git config` written into the agent repo on every `typeclaw
// start` to bound git's gc/repack/pack-objects memory. Agents force-commit
// sessions/ + memory/, so packs grow to GB scale; on such a repo git's default
// auto-gc was measured at ~1.8GB RSS and OOM-killed the container. These keys cap
// the peak (git-config(1): peak ≈ pack.threads × pack.windowMemory + overhead).
// Do NOT "modernize" any back to a git default without re-checking the OOM:
//   gc.auto/autoPackLimit=0   no surprise full repack from the backup's `git
//                             commit`; reclamation moves to the idle backup path
//                             (see bound-git-maintenance / Fix 2).
//   pack.threads=1            default auto-detects to CPU count; windowMemory is
//                             PER THREAD, so N cores = N× the spike.
//   pack.windowMemory=64m     default is UNLIMITED — the primary per-thread bound.
//   pack.deltaCacheSize=1     virtually disables the 256MB write-phase delta cache.
//   core.bigFileThreshold=10m load-bearing for append-only JSONL: bigger objects
//                             store plain-deflated with NO delta attempt, keeping
//                             transcripts out of the memory-heavy delta pipeline.
//   core.multiPackIndex=true  required for Fix 2's `maintenance incremental-repack`.
export const BOUND_GC_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  ['gc.auto', '0'],
  ['gc.autoPackLimit', '0'],
  ['gc.bigPackThreshold', '100m'],
  ['pack.threads', '1'],
  ['pack.windowMemory', '64m'],
  ['pack.deltaCacheSize', '1'],
  ['pack.window', '5'],
  ['pack.depth', '10'],
  ['core.bigFileThreshold', '10m'],
  ['core.deltaBaseCacheLimit', '16m'],
  ['core.multiPackIndex', 'true'],
] as const

// Writes BOUND_GC_CONFIG into the agent repo's machine-local git config.
//
// Best-effort, exactly like untrackTrulyIgnoredFiles / commitSystemFile: no-ops
// when the folder is not a git repo or Bun is missing, and NEVER throws — start()
// hygiene must not block boot. These are `git config` (local scope) writes: they
// live in .git/config, are not tracked, not committed, and are idempotent —
// re-running just re-sets the same values.
//
// Returns the number of keys successfully written (0 when skipped) so callers /
// tests can assert the write happened without coupling to git internals.
export async function applyBoundGcConfig(cwd: string): Promise<{ applied: number }> {
  const bun = getBun()
  if (!bun) return { applied: 0 }
  const repo = resolveAgentGit(cwd)
  if (!repo) return { applied: 0 }

  let applied = 0
  for (const [key, value] of BOUND_GC_CONFIG) {
    if (await setLocalConfig(bun, cwd, repo.gitArgs, key, value)) applied += 1
  }
  return { applied }
}

async function setLocalConfig(
  bun: BunLike,
  cwd: string,
  gitArgs: readonly string[],
  key: string,
  value: string,
): Promise<boolean> {
  try {
    const proc = bun.spawn({
      cmd: ['git', ...hooklessGitArgs([...gitArgs, 'config', '--local', key, value])],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

type BunLike = { spawn: typeof Bun.spawn }

function getBun(): BunLike | undefined {
  return (globalThis as { Bun?: BunLike }).Bun
}
