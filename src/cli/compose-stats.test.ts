import { describe, expect, test } from 'bun:test'

import type { AgentStatsEntry, ComposeStatsResult } from '@/compose'

import { formatComposeStats } from './compose-stats'

function entry(overrides: Partial<AgentStatsEntry> & Pick<AgentStatsEntry, 'name'>): AgentStatsEntry {
  const { name } = overrides
  return {
    name,
    cwd: overrides.cwd ?? `/agents/${name}`,
    containerName: overrides.containerName ?? name,
    state: overrides.state ?? 'running',
    cpuPercent: overrides.cpuPercent ?? (overrides.state && overrides.state !== 'running' ? null : '3.16%'),
    memUsage: overrides.memUsage ?? (overrides.state && overrides.state !== 'running' ? null : '919.8MiB / 15.65GiB'),
    memPercent: overrides.memPercent ?? (overrides.state && overrides.state !== 'running' ? null : '5.74%'),
    pids: overrides.pids ?? (overrides.state && overrides.state !== 'running' ? null : '57'),
  }
}

function result(entries: AgentStatsEntry[], rootCwd = '/agents'): ComposeStatsResult {
  return { rootCwd, entries }
}

describe('formatComposeStats', () => {
  test('empty fleet renders a dim "no agents" line including the cwd', () => {
    const out = formatComposeStats(result([], '/somewhere'))
    expect(out).toContain('No typeclaw agents in /somewhere.')
  })

  test('renders agent count, cwd, and per-agent resource rows', () => {
    const out = formatComposeStats(
      result([entry({ name: 'coder' }), entry({ name: 'planner', state: 'stopped' })], '/agents'),
    )
    expect(out).toContain('2 agents in /agents')
    expect(out).toContain('coder')
    expect(out).toContain('3.16%')
    expect(out).toContain('919.8MiB / 15.65GiB')
    expect(out).toContain('57 pids')
  })

  test('uses singular "1 agent" when there is one entry', () => {
    const out = formatComposeStats(result([entry({ name: 'solo' })]))
    expect(out).toContain('1 agent in /agents')
    expect(out).not.toContain('1 agents')
  })

  test('shows resource columns only for running agents', () => {
    const out = formatComposeStats(
      result([
        entry({ name: 'coder', state: 'running' }),
        entry({ name: 'planner', state: 'stopped' }),
        entry({ name: 'scratchpad', state: 'absent' }),
      ]),
    )
    const lines = out.split('\n')
    const stoppedLine = lines.find((l) => l.includes('planner'))
    const absentLine = lines.find((l) => l.includes('scratchpad'))
    expect(stoppedLine).toBeDefined()
    expect(absentLine).toBeDefined()
    expect(stoppedLine).not.toContain('pids')
    expect(absentLine).not.toContain('pids')
  })

  test('shows lowercase state words, not docker-style upper-case', () => {
    const out = formatComposeStats(
      result([
        entry({ name: 'coder', state: 'running' }),
        entry({ name: 'planner', state: 'stopped' }),
        entry({ name: 'scratchpad', state: 'absent' }),
      ]),
    )
    expect(out).toContain('running')
    expect(out).toContain('stopped')
    expect(out).toContain('not started')
    expect(out).not.toContain('RUNNING')
  })

  test('uses status glyphs (●/○/·), not text symbols', () => {
    const out = formatComposeStats(
      result([
        entry({ name: 'a', state: 'running' }),
        entry({ name: 'b', state: 'stopped' }),
        entry({ name: 'c', state: 'absent' }),
      ]),
    )
    expect(out).toContain('●')
    expect(out).toContain('○')
    expect(out).toContain('·')
  })

  test('pads agent names so the state column aligns', () => {
    const out = formatComposeStats(result([entry({ name: 'a' }), entry({ name: 'longer-name' })]))
    const lines = out.split('\n')
    const aLine = lines.find((l) => l.includes(' a '))
    const longLine = lines.find((l) => l.includes('longer-name'))
    expect(aLine).toBeDefined()
    expect(longLine).toBeDefined()
    expect(aLine!.indexOf('running')).toBe(longLine!.indexOf('running'))
  })

  test('emits ANSI color escapes under useColor=true', () => {
    const out = formatComposeStats(
      result([entry({ name: 'coder', state: 'running' }), entry({ name: 'planner', state: 'stopped' })]),
      { useColor: true },
    )
    expect(out).toContain('\u001b[32m')
    expect(out).toContain('\u001b[33m')
  })

  test('emits no ANSI escapes when useColor is unset', () => {
    const out = formatComposeStats(result([entry({ name: 'coder', state: 'running' })]))
    expect(out).not.toContain('\u001b[')
  })
})
