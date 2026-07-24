import { mkdir, readdir, readFile, stat } from 'node:fs/promises'

import { parseShard, type ShardFrontmatter } from './frontmatter'
import { topicShardPath, topicsDir } from './paths'

export type TopicShard = {
  path: string
  slug: string
  frontmatter: ShardFrontmatter
  body: string
}

type Logger = { warn(message: string): void }

// Per-shard cache entry. `(mtimeMs, ctimeMs, size)` is the invalidation key.
// For TypeClaw's own writers -- atomic writeFile in dreaming.ts and migration
// staging, plus the migration's directory rename -- mtime alone is sufficient
// because every write produces a fresh mtime. ctimeMs guards against
// metadata-preserving external edits (rsync -t, touch -r, restored backups,
// `git checkout` with timestamps): the kernel always bumps ctime on inode
// content changes and ctime cannot be backdated via utimes, so these cases
// invalidate even when mtime and size are unchanged.
// A `null` shard caches a known-malformed file so a hot session-create loop
// doesn't re-parse the same bad shard on every prompt.
type ShardCacheEntry = {
  mtimeMs: number
  ctimeMs: number
  size: number
  shard: TopicShard | null
}

// Module-level cache keyed by absolute agent directory. One Bun process owns
// one agent dir in production (the container stage), so this map has cardinality
// 1 at runtime. Multi-entry support exists for tests that exercise multiple
// agent dirs in the same process.
const shardCache = new Map<string, Map<string, ShardCacheEntry>>()

export async function loadAllShards(agentDir: string, options: { logger?: Logger } = {}): Promise<TopicShard[]> {
  const slugs = await listShardSlugs(agentDir)
  const cache = getOrCreateCache(agentDir)

  // Per-shard stat+read fans out concurrently. resolveShard only READS the
  // cache and returns the write it wants, so applying writes after all tasks
  // settle keeps the parallel phase race-free. slugs is pre-sorted and
  // Promise.all preserves input order, so the result stays slug-sorted.
  const outcomes = await Promise.all(slugs.map((slug) => resolveShard(agentDir, slug, cache, options)))

  const shards: TopicShard[] = []
  const seen = new Set<string>()
  for (const outcome of outcomes) {
    seen.add(outcome.slug)
    if (outcome.kind === 'missing') {
      cache.delete(outcome.slug)
      continue
    }
    if (outcome.kind === 'read') cache.set(outcome.slug, outcome.entry)
    if (outcome.shard !== null) shards.push(outcome.shard)
  }

  // Drop cache entries whose underlying files have disappeared so a later
  // round-trip after a recreate gets fresh content.
  for (const slug of cache.keys()) {
    if (!seen.has(slug)) cache.delete(slug)
  }

  return shards
}

type ShardOutcome =
  | { kind: 'missing'; slug: string }
  | { kind: 'cached'; slug: string; shard: TopicShard | null }
  | { kind: 'read'; slug: string; shard: TopicShard | null; entry: ShardCacheEntry }

async function resolveShard(
  agentDir: string,
  slug: string,
  cache: Map<string, ShardCacheEntry>,
  options: { logger?: Logger },
): Promise<ShardOutcome> {
  const path = topicShardPath(agentDir, slug)
  const fileStat = await statShard(path)
  if (fileStat === null) return { kind: 'missing', slug }

  const cached = cache.get(slug)
  if (
    cached !== undefined &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.ctimeMs === fileStat.ctimeMs &&
    cached.size === fileStat.size
  ) {
    return { kind: 'cached', slug, shard: cached.shard }
  }

  const shard = await readAndParseShard(path, slug, options)
  const entry: ShardCacheEntry = {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    size: fileStat.size,
    shard,
  }
  return { kind: 'read', slug, shard, entry }
}

export async function loadShard(
  agentDir: string,
  slug: string,
  options: { logger?: Logger } = {},
): Promise<TopicShard | null> {
  // The single-slug API contract is "read fresh from disk." No production
  // caller depends on it today (every reader bulk-loads via `loadAllShards`);
  // this is the escape hatch for any future caller that needs a stale-free
  // read without going through the bulk cache. Keep the bypass even if it
  // looks unused -- adding the cache here later is mechanical, removing it
  // is a breaking change.
  const path = topicShardPath(agentDir, slug)
  return readAndParseShard(path, slug, options)
}

export async function listShardSlugs(agentDir: string): Promise<string[]> {
  const dir = topicsDir(agentDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    // ENOENT: the topics dir doesn't exist yet (fresh agent, or a wiped memory
    // tree). Self-heal by recreating it so every downstream reader -- per-turn
    // injection, memory_search, dreaming, the startup index build, and the
    // doctor vector-index check -- sees a real, empty directory instead of a
    // missing one. mkdir is idempotent, so a lost race just no-ops.
    if (isEnoent(err)) return healMissingTopicsDir(dir)
    // ENOTDIR: a bind-mount/tmpfs coherency hiccup can momentarily replace the
    // topics dir (or a parent path component) with a non-directory; readdir
    // then throws ENOTDIR. We can't self-heal this -- mkdir over a regular file
    // would either fail or clobber operator data -- so degrade to empty and let
    // the transient host state resolve itself, exactly as before.
    if (isEnotdir(err)) return []
    throw err
  }

  return names
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
}

async function healMissingTopicsDir(dir: string): Promise<string[]> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    // A concurrent healer already created it, or the parent briefly became a
    // non-directory. Either way the empty-list contract still holds; never let
    // the heal attempt turn a self-healing state into a hard error.
    if (!isEnotdir(err)) throw err
  }
  return []
}

// Test-only helper. Clears the in-memory shard cache so tests that exercise
// the cache invalidation path can simulate a cold start without spinning up a
// fresh process.
export function __resetShardCacheForTests(): void {
  shardCache.clear()
}

async function readAndParseShard(path: string, slug: string, options: { logger?: Logger }): Promise<TopicShard | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }

  try {
    const { frontmatter, body } = parseShard(text)
    return { path, slug, frontmatter, body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const logger = options.logger ?? console
    logger.warn(`[memory] skipping malformed topic shard ${slug}: ${message}`)
    return null
  }
}

async function statShard(path: string): Promise<{ mtimeMs: number; ctimeMs: number; size: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size }
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

function getOrCreateCache(agentDir: string): Map<string, ShardCacheEntry> {
  let cache = shardCache.get(agentDir)
  if (cache === undefined) {
    cache = new Map()
    shardCache.set(agentDir, cache)
  }
  return cache
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

function isEnotdir(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOTDIR'
}
