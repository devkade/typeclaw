import { describe, expect, test } from 'bun:test'

import { formatMemorySnapshot } from './memory-snapshot'

describe('formatMemorySnapshot', () => {
  test('renders rss/heap/external as MB key=value pairs', () => {
    const line = formatMemorySnapshot({
      rss: 512 * 1024 * 1024,
      heapUsed: 128 * 1024 * 1024,
      heapTotal: 256 * 1024 * 1024,
      external: 64 * 1024 * 1024,
      arrayBuffers: 32 * 1024 * 1024,
    })

    expect(line).toBe('rss_mb=512 heapUsed_mb=128 external_mb=64 arrayBuffers_mb=32')
  })

  test('rounds to whole MB', () => {
    const line = formatMemorySnapshot({
      rss: 512.7 * 1024 * 1024,
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
    })

    expect(line).toBe('rss_mb=513 heapUsed_mb=0 external_mb=0 arrayBuffers_mb=0')
  })
})
