import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { resolveDependencyBin } from './bin-resolver'

describe('resolveDependencyBin', () => {
  test('prefers the trusted agent-browser executable over its package entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-bin-resolver-'))
    const baseline = join(root, 'baseline')
    const packageRoot = join(root, 'node_modules', 'agent-browser')
    await mkdir(packageRoot, { recursive: true })
    await mkdir(baseline)
    await writeFile(join(packageRoot, 'cli.js'), '')
    await writeFile(join(baseline, 'agent-browser'), '#!/bin/sh\n')
    await chmod(join(baseline, 'agent-browser'), 0o755)

    const resolved = await resolveDependencyBin(
      root,
      { package: 'agent-browser', bin: 'agent-browser', entry: 'cli.js' },
      [baseline],
    )

    expect(resolved).toEqual({
      kind: 'baseline',
      declaration: { package: 'agent-browser', bin: 'agent-browser', entry: 'cli.js' },
      executable: join(baseline, 'agent-browser'),
    })
  })

  test('resolves a package entrypoint at its sandbox-visible absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-bin-resolver-'))
    const packageRoot = join(root, 'node_modules', '@acme', 'cli')
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'dist/cli.js'), '')

    const resolved = await resolveDependencyBin(root, { package: '@acme/cli', bin: 'acme', entry: './dist/cli.js' }, [])

    expect(resolved.kind).toBe('package')
    if (resolved.kind === 'package') {
      expect(resolved.containerEntrypoint).toBe((await realpath(join(packageRoot, 'dist/cli.js'))).split(sep).join('/'))
    }
  })

  test('denies the typeclaw bin before baseline or package resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-bin-resolver-'))

    const resolved = await resolveDependencyBin(
      root,
      { package: 'typeclaw', bin: 'typeclaw', entry: 'src/cli/index.ts' },
      [],
    )

    expect(resolved.kind).toBe('denied')
  })

  test.skipIf(process.platform === 'win32')('rejects a package root symlink that escapes node_modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-bin-resolver-'))
    const external = await mkdtemp(join(tmpdir(), 'typeclaw-external-package-'))
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await writeFile(join(external, 'cli.js'), '')
    await symlink(external, join(root, 'node_modules', 'escaped'))

    const resolved = await resolveDependencyBin(root, { package: 'escaped', bin: 'escaped', entry: 'cli.js' }, [])

    expect(resolved.kind).toBe('unavailable')
  })

  test.skipIf(process.platform === 'win32')('rejects a bin symlink that escapes its package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-bin-resolver-'))
    const external = await mkdtemp(join(tmpdir(), 'typeclaw-external-entry-'))
    const packageRoot = join(root, 'node_modules', 'escaped-entry')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(external, 'cli.js'), '')
    await symlink(join(external, 'cli.js'), join(packageRoot, 'cli.js'))

    const resolved = await resolveDependencyBin(
      root,
      { package: 'escaped-entry', bin: 'escaped-entry', entry: 'cli.js' },
      [],
    )

    expect(resolved.kind).toBe('unavailable')
  })
})
