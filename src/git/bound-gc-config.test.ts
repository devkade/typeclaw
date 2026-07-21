import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyBoundGcConfig, BOUND_GC_CONFIG } from './bound-gc-config'

async function gitInit(cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd: ['git', 'init', '-b', 'main'], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
}

async function readConfig(cwd: string, key: string): Promise<string> {
  const gitArgs = existsSync(join(cwd, '.gitstore')) ? ['--git-dir', join(cwd, '.gitstore'), '--work-tree', cwd] : []
  const proc = Bun.spawn({ cmd: ['git', ...gitArgs, 'config', '--local', key], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'bound-gc-config-'))
}

describe('applyBoundGcConfig', () => {
  test('writes every bounding key into the repo local config', async () => {
    const dir = await makeDir()
    try {
      await gitInit(dir)

      const { applied } = await applyBoundGcConfig(dir)

      expect(applied).toBe(BOUND_GC_CONFIG.length)
      for (const [key, value] of BOUND_GC_CONFIG) {
        expect(await readConfig(dir, key)).toBe(value)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('caps the delta pipeline: threads=1, unlimited window bounded, big files skip delta', async () => {
    const dir = await makeDir()
    try {
      await gitInit(dir)

      await applyBoundGcConfig(dir)

      expect(await readConfig(dir, 'gc.auto')).toBe('0')
      expect(await readConfig(dir, 'pack.threads')).toBe('1')
      expect(await readConfig(dir, 'pack.windowMemory')).toBe('64m')
      expect(await readConfig(dir, 'core.bigFileThreshold')).toBe('10m')
      expect(await readConfig(dir, 'core.multiPackIndex')).toBe('true')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('is idempotent across repeated starts', async () => {
    const dir = await makeDir()
    try {
      await gitInit(dir)

      await applyBoundGcConfig(dir)
      const { applied } = await applyBoundGcConfig(dir)

      expect(applied).toBe(BOUND_GC_CONFIG.length)
      expect(await readConfig(dir, 'pack.windowMemory')).toBe('64m')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('supports the relocated .gitstore layout', async () => {
    const dir = await makeDir()
    try {
      await gitInit(dir)
      await rename(join(dir, '.git'), join(dir, '.gitstore'))

      const { applied } = await applyBoundGcConfig(dir)

      expect(applied).toBe(BOUND_GC_CONFIG.length)
      expect(await readConfig(dir, 'gc.auto')).toBe('0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('no-ops on a folder that is not a git repo', async () => {
    const dir = await makeDir()
    try {
      const { applied } = await applyBoundGcConfig(dir)
      expect(applied).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
