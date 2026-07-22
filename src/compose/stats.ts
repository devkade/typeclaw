import { type ContainerStats, resolveController } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'

export type AgentStatsState = 'running' | 'stopped' | 'absent'

export type AgentStatsEntry = AgentEntry & {
  state: AgentStatsState
  cpuPercent: string | null
  memUsage: string | null
  memPercent: string | null
  pids: string | null
}

export type ComposeStatsResult = {
  rootCwd: string
  entries: AgentStatsEntry[]
}

export type StatsProbe = (cwd: string) => Promise<ContainerStats>

export type ComposeStatsDeps = {
  discover?: (rootCwd: string) => AgentEntry[]
  probe?: StatsProbe
}

export async function composeStats(rootCwd: string, deps: ComposeStatsDeps = {}): Promise<ComposeStatsResult> {
  const discover = deps.discover ?? discoverAgents
  const probe = deps.probe ?? ((cwd) => resolveController().stats({ cwd }))

  const agents = discover(rootCwd)
  const entries = await Promise.all(agents.map(async (agent) => classify(agent, await probe(agent.cwd))))
  return { rootCwd, entries }
}

function classify(agent: AgentEntry, container: ContainerStats): AgentStatsEntry {
  if (container.kind === 'missing') {
    return { ...agent, state: 'absent', cpuPercent: null, memUsage: null, memPercent: null, pids: null }
  }
  if (container.kind === 'stopped') {
    return { ...agent, state: 'stopped', cpuPercent: null, memUsage: null, memPercent: null, pids: null }
  }
  return {
    ...agent,
    state: 'running',
    cpuPercent: container.cpuPercent,
    memUsage: container.memUsage,
    memPercent: container.memPercent,
    pids: container.pids,
  }
}
