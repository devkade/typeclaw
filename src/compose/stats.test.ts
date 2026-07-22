import { describe, expect, test } from 'bun:test'

import type { ContainerStats } from '@/container'

import type { AgentEntry } from './discover'
import { composeStats, type StatsProbe } from './stats'

function agent(name: string): AgentEntry {
  return { name, cwd: `/agents/${name}`, containerName: name }
}

function running(
  containerName: string,
  over: Partial<Extract<ContainerStats, { kind: 'running' }>> = {},
): ContainerStats {
  return {
    kind: 'running',
    containerName,
    imageTag: `typeclaw-${containerName}`,
    startedAt: '2026-07-22T08:28:42Z',
    cpuPercent: '3.16%',
    memUsage: '919.8MiB / 15.65GiB',
    memPercent: '5.74%',
    pids: '57',
    ...over,
  }
}

function stopped(containerName: string): ContainerStats {
  return { kind: 'stopped', containerName, imageTag: `typeclaw-${containerName}` }
}

function missing(containerName: string): ContainerStats {
  return { kind: 'missing', containerName, imageTag: `typeclaw-${containerName}` }
}

function probeFrom(byCwd: Record<string, ContainerStats>): StatsProbe {
  return async (cwd) => {
    const stat = byCwd[cwd]
    if (stat === undefined) throw new Error(`no probe stub for ${cwd}`)
    return stat
  }
}

describe('composeStats', () => {
  test('fans out over discovered agents and preserves discovery order', async () => {
    const discovered = [agent('alpha'), agent('mango'), agent('zebra')]
    const result = await composeStats('/agents', {
      discover: () => discovered,
      probe: probeFrom({
        '/agents/alpha': running('alpha'),
        '/agents/mango': stopped('mango'),
        '/agents/zebra': missing('zebra'),
      }),
    })

    expect(result.rootCwd).toBe('/agents')
    expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'mango', 'zebra'])
  })

  test('classifies running / stopped / absent from the container stats kind', async () => {
    const result = await composeStats('/agents', {
      discover: () => [agent('run'), agent('stop'), agent('gone')],
      probe: probeFrom({
        '/agents/run': running('run'),
        '/agents/stop': stopped('stop'),
        '/agents/gone': missing('gone'),
      }),
    })

    const byName = new Map(result.entries.map((e) => [e.name, e.state]))
    expect(byName.get('run')).toBe('running')
    expect(byName.get('stop')).toBe('stopped')
    expect(byName.get('gone')).toBe('absent')
  })

  test('propagates cpu, memory, and pid metrics for running agents', async () => {
    const result = await composeStats('/agents', {
      discover: () => [agent('coder')],
      probe: probeFrom({
        '/agents/coder': running('coder', {
          cpuPercent: '47.06%',
          memUsage: '1.494GiB / 15.65GiB',
          memPercent: '9.55%',
          pids: '31',
        }),
      }),
    })

    expect(result.entries[0]).toMatchObject({
      name: 'coder',
      state: 'running',
      cpuPercent: '47.06%',
      memUsage: '1.494GiB / 15.65GiB',
      memPercent: '9.55%',
      pids: '31',
    })
  })

  test('reports null metrics for stopped and absent agents', async () => {
    const result = await composeStats('/agents', {
      discover: () => [agent('stop'), agent('gone')],
      probe: probeFrom({ '/agents/stop': stopped('stop'), '/agents/gone': missing('gone') }),
    })

    for (const entry of result.entries) {
      expect(entry.cpuPercent).toBeNull()
      expect(entry.memUsage).toBeNull()
      expect(entry.memPercent).toBeNull()
      expect(entry.pids).toBeNull()
    }
  })

  test('returns an empty result when no agents are discovered', async () => {
    const result = await composeStats('/agents', { discover: () => [], probe: probeFrom({}) })
    expect(result).toEqual({ rootCwd: '/agents', entries: [] })
  })
})
