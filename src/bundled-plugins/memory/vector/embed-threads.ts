import { availableParallelism, cpus } from 'node:os'

// The container is launched with no docker `--cpus` limit, so onnxruntime-node's
// default `intraOpNumThreads` (0 = auto) sizes the shared session's intra-op
// thread pool to one worker PER visible host core — each with its own activation
// workspace, held for the life of the embedder singleton. On an 11-core host
// that is ~11 thread-local buffers, a real contributor to the container's RSS.
// The pool is session-level and shared: the transformers.js Node path calls
// `session.run()` directly (concurrent `Run()` is allowed — serialization only
// applies to the web backend), so concurrent embeds from overlapping turns
// contend for it. Capping is a deliberate trade: it caps intra-op parallelism
// (per embed and across overlapping embeds) in exchange for RSS bounded by the
// cap instead of by host core count. The workload is short per-turn query embeds
// (tens of ms each), so bounding memory is the priority over peak parallelism.
export const DEFAULT_MAX_EMBED_THREADS = 4

// Halve the visible cores (leaves headroom for the event loop and concurrent
// sessions), then clamp into [1, cap]. `min 1` handles a single-core box; the
// cap stops the many-core blowup.
export function resolveEmbedThreadCount(input?: { cap?: number; parallelism?: number }): number {
  const cap = input?.cap ?? DEFAULT_MAX_EMBED_THREADS
  const parallelism = input?.parallelism ?? detectParallelism()
  const halved = Math.floor(parallelism / 2)
  return Math.min(Math.max(halved, 1), cap)
}

function detectParallelism(): number {
  try {
    const n = availableParallelism()
    if (Number.isInteger(n) && n >= 1) return n
  } catch {
    // availableParallelism is Node 18.14+/20+; fall back to cpus() on older runtimes.
  }
  const count = cpus().length
  return count >= 1 ? count : 1
}
