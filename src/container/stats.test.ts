import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExec, DockerExecResult } from './shared'
import { parseStatsLine, stats } from './stats'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-stats-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type FakeDockerOptions = {
  inspect?: DockerExecResult
  stats?: DockerExecResult
}

type RecordingExec = DockerExec & { calls: string[] }

// Records the docker subcommand of every call and THROWS on any subcommand the
// test didn't stub, so a spurious `docker stats` on the missing/stopped path is
// a hard failure instead of a silently-swallowed benign error. Callers assert on
// `.calls` to pin the exact inspect-vs-stats sequence.
function recordingExec(opts: FakeDockerOptions): RecordingExec {
  const calls: string[] = []
  const exec = (async (args) => {
    const sub = args[0] ?? ''
    calls.push(sub)
    if (sub === 'inspect') {
      return opts.inspect ?? { exitCode: 1, stdout: '', stderr: 'no inspect stub' }
    }
    if (sub === 'stats') {
      if (opts.stats === undefined) throw new Error(`unexpected docker stats call: ${args.join(' ')}`)
      return opts.stats
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`)
  }) as RecordingExec
  exec.calls = calls
  return exec
}

describe('stats', () => {
  test('reports missing and probes only inspect when docker inspect exits non-zero', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const exec = recordingExec({ inspect: { exitCode: 1, stdout: '', stderr: 'No such object' } })

    const result = await stats({ cwd: folder, exec })

    expect(result).toEqual({ kind: 'missing', containerName: 'coder', imageTag: 'typeclaw-coder' })
    expect(exec.calls).toEqual(['inspect'])
  })

  test('reports stopped and probes only inspect when Running is false', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const exec = recordingExec({ inspect: { exitCode: 0, stdout: 'false|0001-01-01T00:00:00Z\n', stderr: '' } })

    const result = await stats({ cwd: folder, exec })

    expect(result).toEqual({ kind: 'stopped', containerName: 'coder', imageTag: 'typeclaw-coder' })
    expect(exec.calls).toEqual(['inspect'])
  })

  test('reports running with parsed cpu, memory, and pids after inspect then stats', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const exec = recordingExec({
      inspect: { exitCode: 0, stdout: 'true|2026-07-22T08:28:42.217286468Z\n', stderr: '' },
      stats: { exitCode: 0, stdout: '3.16%|919.8MiB / 15.65GiB|5.74%|57\n', stderr: '' },
    })

    const result = await stats({ cwd: folder, exec })

    expect(result).toEqual({
      kind: 'running',
      containerName: 'coder',
      imageTag: 'typeclaw-coder',
      startedAt: '2026-07-22T08:28:42.217286468Z',
      cpuPercent: '3.16%',
      memUsage: '919.8MiB / 15.65GiB',
      memPercent: '5.74%',
      pids: '57',
    })
    expect(exec.calls).toEqual(['inspect', 'stats'])
  })

  test('reports running with dashes when docker stats has no row for the container', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const exec = recordingExec({
      inspect: { exitCode: 0, stdout: 'true|2026-07-22T08:28:42Z\n', stderr: '' },
      stats: { exitCode: 1, stdout: '', stderr: 'no such container' },
    })

    const result = await stats({ cwd: folder, exec })

    expect(result).toMatchObject({
      kind: 'running',
      cpuPercent: '-',
      memUsage: '-',
      memPercent: '-',
      pids: '-',
    })
    expect(exec.calls).toEqual(['inspect', 'stats'])
  })

  test('reports running with null startedAt when inspect omits it', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)
    const exec = recordingExec({
      inspect: { exitCode: 0, stdout: 'true|\n', stderr: '' },
      stats: { exitCode: 0, stdout: '1.0%|10MiB / 1GiB|1.0%|3\n', stderr: '' },
    })

    const result = await stats({ cwd: folder, exec })

    expect(result).toMatchObject({ kind: 'running', startedAt: null })
  })
})

describe('parseStatsLine', () => {
  test('parses a pipe-delimited stats row preserving the mem-usage field', () => {
    expect(parseStatsLine('47.06%|1.494GiB / 15.65GiB|9.55%|31\n')).toEqual({
      cpuPercent: '47.06%',
      memUsage: '1.494GiB / 15.65GiB',
      memPercent: '9.55%',
      pids: '31',
    })
  })

  test('returns null for empty output', () => {
    expect(parseStatsLine('')).toBeNull()
    expect(parseStatsLine('\n  \n')).toBeNull()
  })
})
