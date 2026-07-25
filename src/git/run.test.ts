import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _internal, runGit } from './run'

const scratchCwd = mkdtempSync(join(tmpdir(), 'runGit-'))

describe('runGit', () => {
  test('captures stdout on success', async () => {
    const result = await runGit(Bun, scratchCwd, ['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('git version')
    expect(result.stderr).toBe('')
  })

  test('captures stderr and a nonzero exit on failure', async () => {
    const result = await runGit(Bun, scratchCwd, ['rev-parse', '--verify', 'refs/heads/does-not-exist'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  test(
    'captures large stdout and stderr output in full',
    async () => {
      const payloadBytes = 1_000_000
      const writer = `
        const chunk = 'x'.repeat(64 * 1024)
        let written = 0
        const target = ${payloadBytes}
        while (written < target) {
          const n = Math.min(chunk.length, target - written)
          process.stdout.write(chunk.slice(0, n))
          process.stderr.write(chunk.slice(0, n))
          written += n
        }
      `
      const floodBothStreams: { spawn: typeof Bun.spawn } = {
        spawn: ((_cmd: string[], _opts?: unknown) =>
          Bun.spawn([process.execPath, '-e', writer], { stdout: 'pipe', stderr: 'pipe' })) as typeof Bun.spawn,
      }
      const result = await runGit(floodBothStreams, scratchCwd, ['status'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBe(payloadBytes)
      expect(result.stderr.length).toBe(payloadBytes)
    },
    { timeout: 15_000 },
  )
})

describe('collectProcessOutput', () => {
  // The orchestration invariant, tested without depending on Bun subprocess
  // internals: each stream's `text()` resolves only AFTER the other stream's
  // `text()` has been CALLED, and `exited` resolves only once BOTH have been
  // called. An exit-first (`await exited` then read) or a serialized (await
  // stdout.text() fully, then stderr.text()) implementation deadlocks and hits
  // the timeout; only starting both reads before awaiting completes.
  test(
    'starts draining stdout and stderr before awaiting exit',
    async () => {
      const stdoutCalled = Promise.withResolvers<void>()
      const stderrCalled = Promise.withResolvers<void>()

      const proc = {
        stdout: {
          text: async () => {
            stdoutCalled.resolve()
            await stderrCalled.promise
            return 'out'
          },
        },
        stderr: {
          text: async () => {
            stderrCalled.resolve()
            await stdoutCalled.promise
            return 'err'
          },
        },
        exited: Promise.all([stdoutCalled.promise, stderrCalled.promise]).then(() => 0),
      }

      await expect(_internal.collectProcessOutput(proc)).resolves.toEqual({
        exitCode: 0,
        stdout: 'out',
        stderr: 'err',
      })
    },
    { timeout: 1_000 },
  )
})
