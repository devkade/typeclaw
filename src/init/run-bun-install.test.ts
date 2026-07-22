import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBunInstall, runBunUpdate } from './run-bun-install'

// A child whose stdout drain rejects and whose exit only settles after kill(),
// so the test can prove the drain-failure path reaps the process instead of
// disarming the timeout and leaking it.
function spawnRejectingDrain(): {
  spawn: typeof Bun.spawn
  killed: () => boolean
} {
  let resolveExited: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  let killed = false
  const proc = {
    exited,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stdout drain failed'))
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    kill() {
      killed = true
      resolveExited(137)
    },
  }
  return { spawn: (() => proc) as unknown as typeof Bun.spawn, killed: () => killed }
}

describe('runBunInstall', () => {
  test('times out a hung install process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunInstall(cwd, { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun install timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('kills and reaps the child when a pipe drain rejects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-drain-'))
    try {
      await writeFile(join(cwd, 'package.json'), '{}\n')
      const { spawn, killed } = spawnRejectingDrain()

      const result = await runBunInstall(cwd, { timeoutMs: 10_000, spawn })

      expect(result).toEqual({ ok: false, reason: 'stdout drain failed' })
      expect(killed()).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('reports stderr (not stdout) in the failure reason on a non-zero exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-install-fail-'))
    try {
      await writeFile(join(cwd, 'package.json'), '{}\n')
      const spawnFailing: typeof Bun.spawn = () =>
        Bun.spawn({
          cmd: [
            'bun',
            '-e',
            'process.stdout.write("STDOUT_MARKER"); process.stderr.write("STDERR_MARKER"); process.exit(3)',
          ],
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        })

      const result = await runBunInstall(cwd, { timeoutMs: 10_000, spawn: spawnFailing })

      expect(result.ok).toBe(false)
      const reason = result.ok ? '' : result.reason
      expect(reason).toContain('STDERR_MARKER')
      expect(reason).not.toContain('STDOUT_MARKER')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('runBunUpdate', () => {
  test('times out a hung update process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-bun-update-timeout-'))
    try {
      const spawnHungProcess: typeof Bun.spawn = () =>
        Bun.spawn({ cmd: ['bun', '-e', 'setInterval(() => {}, 1000)'], cwd, stdout: 'pipe', stderr: 'pipe' })
      await writeFile(join(cwd, 'package.json'), '{}\n')

      const result = await runBunUpdate(cwd, 'typeclaw', { timeoutMs: 50, spawn: spawnHungProcess })

      expect(result).toEqual({ ok: false, reason: 'bun update typeclaw timed out after 0.05s' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
