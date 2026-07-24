import { readFileSync, statfsSync } from 'node:fs'
import { totalmem } from 'node:os'

import { formatMemorySnapshot } from '@/bundled-plugins/memory/memory-snapshot'

// The container's memory/cpu ceiling is fixed at `docker run` and never changes
// while the process lives, so this reports once at boot. It is the missing half
// of an OOM post-mortem: the per-operation RSS lines show usage climbing, but
// only this line names the ceiling it climbed toward. Read from INSIDE the
// container (cgroup + statfs) because the container stage cannot call the host's
// `docker inspect`.
//
// Every read is a tri-state: `finite` (a real limit), `unlimited` (a genuine
// no-limit sentinel — v2 `max`, v1 `-1`/`LONG_MAX`), or `unknown` (missing,
// unreadable, or malformed). The distinction is load-bearing: collapsing
// `unknown` into `unlimited` would turn an unsupported cgroup layout or a read
// error into a false "no ceiling" claim, which is exactly the wrong signal in an
// OOM investigation. `unknown` renders as `?`.

export type Limit = { kind: 'finite'; value: number } | { kind: 'unlimited' } | { kind: 'unknown' }

// v1 writes "unlimited" as LONG_MAX rounded DOWN to a page boundary, so the
// exact value is page-size dependent: 4 KiB pages → 9223372036854771712,
// 64 KiB pages → 9223372036854710272. Hard-coding the 4 KiB value would let the
// 64 KiB sentinel slip through as a ~8 EiB finite limit. Instead treat the whole
// near-LONG_MAX family as unlimited: any value within one max-page (64 KiB) of
// LONG_MAX. Real container limits are astronomically smaller, so the band is safe.
const LONG_MAX = 9223372036854775807n
const MAX_PAGE_SIZE = 65536n
const CGROUP_V1_UNLIMITED_FLOOR = LONG_MAX - MAX_PAGE_SIZE

export function parseCgroupMemory(raw: string | null): Limit {
  if (raw === null) return { kind: 'unknown' }
  const trimmed = raw.trim()
  if (trimmed === 'max') return { kind: 'unlimited' }
  if (trimmed === '') return { kind: 'unknown' }
  let value: bigint
  try {
    value = BigInt(trimmed)
  } catch {
    return { kind: 'unknown' }
  }
  if (value >= CGROUP_V1_UNLIMITED_FLOOR) return { kind: 'unlimited' }
  if (value <= 0n) return { kind: 'unknown' }
  return { kind: 'finite', value: Number(value) }
}

export function parseCpuMax(raw: string | null): Limit {
  if (raw === null) return { kind: 'unknown' }
  const parts = raw.trim().split(/\s+/)
  // Shape first: exactly two fields with a finite, positive period. A malformed
  // record (`max garbage`, `max 100000 extra`, empty) is `unknown`, never
  // `unlimited` — an unreadable ceiling must not masquerade as "no ceiling".
  if (parts.length !== 2) return { kind: 'unknown' }
  const [quota, period] = parts
  if (quota === undefined || period === undefined) return { kind: 'unknown' }
  const periodN = Number(period)
  if (!Number.isFinite(periodN) || periodN <= 0) return { kind: 'unknown' }
  // Only genuine no-limit sentinels are unlimited: v2 `max`, v1 `-1`.
  if (quota === 'max') return { kind: 'unlimited' }
  const quotaN = Number(quota)
  if (quotaN === -1) return { kind: 'unlimited' }
  if (!Number.isFinite(quotaN) || quotaN <= 0) return { kind: 'unknown' }
  return { kind: 'finite', value: quotaN / periodN }
}

const BYTES_PER_MB = 1024 * 1024

function renderLimit(limit: Limit, label: string, render: (value: number) => string): string {
  if (limit.kind === 'unknown') return `${label}=?`
  if (limit.kind === 'unlimited') return `${label}=unlimited`
  return `${label}=${render(limit.value)}`
}

export function formatCgroupMemory(limit: Limit): string {
  return renderLimit(limit, 'mem_limit_mb', (v) => String(Math.round(v / BYTES_PER_MB)))
}

export function formatCpuMax(limit: Limit): string {
  return renderLimit(limit, 'cpu_quota', (v) => String(v))
}

// The controller's cgroup membership for THIS process, parsed from
// /proc/self/cgroup. A container is not at the v1 hierarchy root: Docker places
// it under `/docker/<id>` (cgroupfs) or `/system.slice/docker-<id>.scope`
// (systemd), so reading the root file would report the HOST limit (usually
// unlimited) instead of the container's.
//
// `mount` is the controller FIELD verbatim (e.g. `cpu,cpuacct`) — the directory
// name the controller is actually mounted under in /sys/fs/cgroup, which for a
// combined controller is NOT the bare controller name. `subPath` is the
// per-process path within that hierarchy. The requested controller is matched as
// one comma-separated entry, not whole-field equality. Returns null when the
// controller is absent (e.g. a pure cgroup-v2 host, whose /proc/self/cgroup has
// a single `0::` line).
export type CgroupV1Membership = { mount: string; subPath: string }

export function resolveCgroupV1Path(procSelfCgroup: string | null, controller: string): CgroupV1Membership | null {
  if (procSelfCgroup === null) return null
  for (const line of procSelfCgroup.split('\n')) {
    if (line === '') continue
    const firstColon = line.indexOf(':')
    const secondColon = line.indexOf(':', firstColon + 1)
    if (firstColon === -1 || secondColon === -1) continue
    const field = line.slice(firstColon + 1, secondColon)
    if (field.split(',').includes(controller)) return { mount: field, subPath: line.slice(secondColon + 1) }
  }
  return null
}

// The absolute path to a v1 controller file for THIS process, resolved through
// BOTH /proc/self/cgroup (membership) and /proc/self/mountinfo (the actual
// mountpoint + mount root). The membership path from /proc/self/cgroup is
// relative to the cgroup HIERARCHY root, which is NOT necessarily the mountpoint:
// a container commonly has its subtree bind-mounted so hierarchy root
// `/docker/<id>` appears AT `/sys/fs/cgroup/memory`. Appending the full
// membership path onto the mountpoint (the previous approach) then reads a
// non-existent `/sys/fs/cgroup/memory/docker/<id>/...` and reports `?`.
//
// mountinfo gives, per mount: field[3]=root, field[4]=mountpoint, and after the
// ` - ` separator, fstype=`cgroup` with the controller in its super-options. The
// file lives at `mountpoint + (membershipPath relative to mount root)`.
export function resolveCgroupV1File(
  procSelfCgroup: string | null,
  mountinfo: string | null,
  controller: string,
  file: string,
): string | null {
  const membership = resolveCgroupV1Path(procSelfCgroup, controller)
  if (membership === null || mountinfo === null) return null

  for (const line of mountinfo.split('\n')) {
    if (line === '') continue
    const sep = line.indexOf(' - ')
    if (sep === -1) continue
    const pre = line.slice(0, sep).split(/\s+/)
    const post = line.slice(sep + 3).split(/\s+/)
    const [fstype, , superOptions] = post
    if (fstype !== 'cgroup') continue
    if (superOptions === undefined || !superOptions.split(',').includes(controller)) continue
    const mountRoot = pre[3]
    const mountPoint = pre[4]
    if (mountRoot === undefined || mountPoint === undefined) continue
    const rel = relativeToMountRoot(membership.subPath, mountRoot)
    if (rel === null) continue
    return joinCgroupPath(joinCgroupPath(mountPoint, rel), file)
  }
  return null
}

// The membership sub-path expressed relative to the mount's root. When the mount
// root IS the membership path (subtree mount), the file sits directly at the
// mountpoint (rel = ''). When root is `/` (whole-hierarchy mount), rel is the
// full sub-path. A membership outside the mount root is unreachable → null.
function relativeToMountRoot(subPath: string, mountRoot: string): string | null {
  if (mountRoot === '/') return subPath === '/' ? '' : subPath
  if (subPath === mountRoot) return ''
  if (subPath.startsWith(`${mountRoot}/`)) return subPath.slice(mountRoot.length)
  return null
}

function joinCgroupPath(base: string, segment: string): string {
  if (segment === '' || segment === '/') return base
  return `${base.replace(/\/$/, '')}/${segment.replace(/^\//, '')}`
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function readV1ControllerFile(controller: string, file: string): string | null {
  const path = resolveCgroupV1File(
    readOrNull('/proc/self/cgroup'),
    readOrNull('/proc/self/mountinfo'),
    controller,
    file,
  )
  return path === null ? null : readOrNull(path)
}

function readCgroupMemoryLimit(): Limit {
  const v2 = readOrNull('/sys/fs/cgroup/memory.max')
  if (v2 !== null) return parseCgroupMemory(v2)
  return parseCgroupMemory(readV1ControllerFile('memory', 'memory.limit_in_bytes'))
}

function readCgroupCpuQuota(): Limit {
  const v2 = readOrNull('/sys/fs/cgroup/cpu.max')
  if (v2 !== null) return parseCpuMax(v2)
  const quota = readV1ControllerFile('cpu', 'cpu.cfs_quota_us')
  const period = readV1ControllerFile('cpu', 'cpu.cfs_period_us')
  if (quota === null || period === null) return { kind: 'unknown' }
  return parseCpuMax(`${quota.trim()} ${period.trim()}`)
}

function formatStorage(path: string): string {
  try {
    const fs = statfsSync(path)
    const totalMb = Math.round((fs.blocks * fs.bsize) / BYTES_PER_MB)
    const freeMb = Math.round((fs.bavail * fs.bsize) / BYTES_PER_MB)
    return `disk_total_mb=${totalMb} disk_free_mb=${freeMb}`
  } catch {
    return 'disk_total_mb=? disk_free_mb=?'
  }
}

export function logResourceReport(agentDir = '/agent'): void {
  try {
    const memLimit = formatCgroupMemory(readCgroupMemoryLimit())
    const cpuQuota = formatCpuMax(readCgroupCpuQuota())
    // The host/VM total is the OOM ceiling when no cgroup --memory is set (the
    // default `docker run`): the kernel can still kill the process at host RAM
    // exhaustion even with mem_limit=unlimited, so this gives the RSS lines a
    // real comparison point instead of only an "unlimited" that isn't.
    const hostMem = `host_total_mb=${Math.round(totalmem() / BYTES_PER_MB)}`
    const cores = `cpus_visible=${globalThis.navigator?.hardwareConcurrency ?? '?'}`
    const storage = formatStorage(agentDir)
    console.info(`[resource-report] ${memLimit} ${hostMem} ${cpuQuota} ${cores} ${storage} ${formatMemorySnapshot()}`)
  } catch (err) {
    console.warn(`[resource-report] failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
