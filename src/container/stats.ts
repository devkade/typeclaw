import { containerNameFromCwd, defaultDockerExec, imageTagFromCwd, type DockerExec } from './shared'

export type ContainerStats =
  | { kind: 'missing'; containerName: string; imageTag: string }
  | { kind: 'stopped'; containerName: string; imageTag: string }
  | {
      kind: 'running'
      containerName: string
      imageTag: string
      startedAt: string | null
      cpuPercent: string
      memUsage: string
      memPercent: string
      pids: string
    }

export type StatsOptions = {
  cwd: string
  exec?: DockerExec
}

// `docker stats --no-stream` only emits a row for a RUNNING container; a stopped
// or absent one yields no line at all, so it cannot by itself distinguish the two.
// Probe `docker inspect` first to classify missing vs stopped vs running (and to
// pull StartedAt for an uptime line), then read the live resource snapshot from
// `docker stats` for the running case.
export async function stats({ cwd, exec = defaultDockerExec }: StatsOptions): Promise<ContainerStats> {
  const containerName = containerNameFromCwd(cwd)
  const imageTag = imageTagFromCwd(cwd)

  const inspect = await exec(['inspect', '--format', '{{.State.Running}}|{{.State.StartedAt}}', containerName])
  if (inspect.exitCode !== 0) {
    return { kind: 'missing', containerName, imageTag }
  }

  const [runningRaw = '', startedAtRaw = ''] = inspect.stdout.trim().split('|')
  if (runningRaw.trim() !== 'true') {
    return { kind: 'stopped', containerName, imageTag }
  }

  const snapshot = await queryStats(exec, containerName)
  return {
    kind: 'running',
    containerName,
    imageTag,
    startedAt: startedAtRaw.trim() === '' ? null : startedAtRaw.trim(),
    cpuPercent: snapshot?.cpuPercent ?? '-',
    memUsage: snapshot?.memUsage ?? '-',
    memPercent: snapshot?.memPercent ?? '-',
    pids: snapshot?.pids ?? '-',
  }
}

export type StatsSnapshot = {
  cpuPercent: string
  memUsage: string
  memPercent: string
  pids: string
}

// Pipe-delimited so a mem-usage field like "919.8MiB / 15.65GiB" (which contains
// spaces and slashes) survives intact — a space or comma separator would split it.
const STATS_FORMAT = '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.PIDs}}'

async function queryStats(exec: DockerExec, containerName: string): Promise<StatsSnapshot | null> {
  const result = await exec(['stats', '--no-stream', '--format', STATS_FORMAT, containerName])
  if (result.exitCode !== 0) return null
  return parseStatsLine(result.stdout)
}

export function parseStatsLine(stdout: string): StatsSnapshot | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (line === undefined) return null

  const [cpuPercent = '', memUsage = '', memPercent = '', pids = ''] = line.split('|').map((f) => f.trim())
  if (cpuPercent === '' && memUsage === '' && memPercent === '' && pids === '') return null
  return {
    cpuPercent: cpuPercent || '-',
    memUsage: memUsage || '-',
    memPercent: memPercent || '-',
    pids: pids || '-',
  }
}
