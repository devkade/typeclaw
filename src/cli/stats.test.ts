import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExecResult } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { formatDuration, formatStats, runStats, type StatsReport } from './stats'

function baseReport(overrides: Partial<StatsReport> = {}): StatsReport {
  return {
    cwd: '/agents/coder',
    container: { kind: 'missing', containerName: 'coder', imageTag: 'typeclaw-coder' },
    ...overrides,
  }
}

describe('formatStats', () => {
  test('renders container header, cwd, image, and missing state', () => {
    const out = formatStats(baseReport())

    expect(out).toContain('Container  coder')
    expect(out).toContain('  cwd     /agents/coder')
    expect(out).toContain('  image   typeclaw-coder')
    expect(out).toContain('  state   missing')
    expect(out).not.toContain('  cpu ')
  })

  test('renders stopped state without resource rows', () => {
    const out = formatStats(
      baseReport({ container: { kind: 'stopped', containerName: 'coder', imageTag: 'typeclaw-coder' } }),
    )

    expect(out).toContain('  state   stopped')
    expect(out).not.toContain('  cpu ')
    expect(out).not.toContain('  memory ')
    expect(out).not.toContain('  pids ')
  })

  test('renders running state with cpu, memory, and pids rows', () => {
    const out = formatStats(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          startedAt: null,
          cpuPercent: '3.16%',
          memUsage: '919.8MiB / 15.65GiB',
          memPercent: '5.74%',
          pids: '57',
        },
      }),
    )

    expect(out).toContain('  state   running')
    expect(out).toContain('  cpu     3.16%')
    expect(out).toContain('  memory  919.8MiB / 15.65GiB (5.74%)')
    expect(out).toContain('  pids    57')
  })

  test('appends an uptime suffix when startedAt is a recent timestamp', () => {
    const startedAt = new Date(Date.now() - 90_000).toISOString()
    const out = formatStats(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          startedAt,
          cpuPercent: '1%',
          memUsage: '10MiB / 1GiB',
          memPercent: '1%',
          pids: '3',
        },
      }),
    )

    expect(out).toContain('running up 1m')
  })

  test('omits uptime when startedAt is unparseable', () => {
    const out = formatStats(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          startedAt: 'not-a-date',
          cpuPercent: '1%',
          memUsage: '10MiB / 1GiB',
          memPercent: '1%',
          pids: '3',
        },
      }),
    )

    expect(out).toContain('  state   running')
    expect(out).not.toContain(' up ')
  })

  test('useColor=true wraps the container header with ANSI escapes', () => {
    const out = formatStats(baseReport(), { useColor: true })
    const ESC = '\u001b'
    expect(out).toContain(`${ESC}[1mContainer`)
  })

  test('useColor=false produces output free of ANSI escape codes', () => {
    const out = formatStats(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          startedAt: new Date().toISOString(),
          cpuPercent: '3.16%',
          memUsage: '919.8MiB / 15.65GiB',
          memPercent: '5.74%',
          pids: '57',
        },
      }),
    )

    expect(out).not.toContain('\u001b[')
  })
})

describe('formatDuration', () => {
  test('renders days and hours for multi-day durations', () => {
    expect(formatDuration((2 * 86400 + 5 * 3600) * 1000)).toBe('2d 5h')
  })

  test('renders hours and minutes under a day', () => {
    expect(formatDuration((3 * 3600 + 12 * 60) * 1000)).toBe('3h 12m')
  })

  test('renders minutes and seconds under an hour', () => {
    expect(formatDuration((4 * 60 + 9) * 1000)).toBe('4m 9s')
  })

  test('renders seconds under a minute', () => {
    expect(formatDuration(42 * 1000)).toBe('42s')
  })
})

describe('typeclaw stats render flow', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-stats-render-'))
  })

  afterEach(async () => {
    await rmTempDir(cwd)
  })

  const runningExec = async (args: string[]): Promise<DockerExecResult> => {
    if (args[0] === 'inspect') return { exitCode: 0, stdout: 'true|2026-07-22T08:28:42Z\n', stderr: '' }
    if (args[0] === 'stats') return { exitCode: 0, stdout: '3.16%|919.8MiB / 15.65GiB|5.74%|57\n', stderr: '' }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` }
  }

  async function captureStats(): Promise<string> {
    let out = ''
    await runStats({
      cwd,
      preflight: async () => ({ ok: true }),
      exec: runningExec,
      write: (text) => {
        out += text
      },
    })
    return out
  }

  test('renders the resource snapshot for a running container', async () => {
    const out = await captureStats()
    expect(out).toContain('Container')
    expect(out).toContain('cpu')
    expect(out).toContain('919.8MiB / 15.65GiB')
    expect(out).toContain('57')
  })

  test('does not exit the process when Docker is available', async () => {
    await expect(captureStats()).resolves.toBeString()
  })
})
