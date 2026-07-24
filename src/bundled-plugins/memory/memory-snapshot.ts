export type MemorySample = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers'>

const BYTES_PER_MB = 1024 * 1024

export function formatMemorySnapshot(sample: MemorySample = process.memoryUsage()): string {
  const mb = (bytes: number): number => Math.round(bytes / BYTES_PER_MB)
  return `rss_mb=${mb(sample.rss)} heapUsed_mb=${mb(sample.heapUsed)} external_mb=${mb(sample.external)} arrayBuffers_mb=${mb(sample.arrayBuffers)}`
}
