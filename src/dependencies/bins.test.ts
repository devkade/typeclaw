import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emptyRegistry } from '@/plugin/registry'

import { DEPENDENCY_BIN_DENYLIST, discoverDependencyBins, registerDependencyBinDoctorCheck } from './bins'

async function writeRootPackage(agentDir: string, dependencies: Record<string, string>): Promise<void> {
  await writeFile(join(agentDir, 'package.json'), JSON.stringify({ name: 'test-agent', dependencies }))
}

async function writePackage(agentDir: string, packageName: string, manifest: Record<string, unknown>): Promise<string> {
  const root = join(agentDir, 'node_modules', ...packageName.split('/'))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  return root
}

describe('discoverDependencyBins', () => {
  test('discovers bins from direct dependencies only, including workspace dependencies', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootPackage(agentDir, {
      'direct-package': '^1.0.0',
      '@acme/workspace-cli': 'workspace:*',
    })
    const directRoot = await writePackage(agentDir, 'direct-package', {
      name: 'direct-package',
      bin: { 'direct-cli': 'cli.js' },
    })
    await writeFile(join(directRoot, 'cli.js'), '')
    const workspaceRoot = join(agentDir, 'packages', 'workspace-cli')
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({
        name: '@acme/workspace-cli',
        bin: 'bin.js',
      }),
    )
    await writeFile(join(workspaceRoot, 'bin.js'), '')
    const workspaceLink = join(agentDir, 'node_modules', '@acme', 'workspace-cli')
    await mkdir(join(agentDir, 'node_modules', '@acme'), { recursive: true })
    await symlink(workspaceRoot, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir')
    const transitiveRoot = await writePackage(agentDir, 'transitive-package', {
      name: 'transitive-package',
      bin: { 'transitive-cli': 'cli.js' },
    })
    await writeFile(join(transitiveRoot, 'cli.js'), '')

    const discovery = await discoverDependencyBins(agentDir)

    expect(discovery.declarations).toEqual(
      expect.arrayContaining([
        { package: 'direct-package', bin: 'direct-cli', entry: 'cli.js' },
        { package: '@acme/workspace-cli', bin: 'workspace-cli', entry: 'bin.js', workspace: true },
      ]),
    )
    expect(discovery.declarations.some((entry) => entry.bin === 'transitive-cli')).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a workspace dependency symlink outside the agent root',
    async () => {
      const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
      const external = await mkdtemp(join(tmpdir(), 'typeclaw-external-workspace-'))
      await writeRootPackage(agentDir, { escaped: 'workspace:*' })
      await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'escaped', bin: 'cli.js' }))
      await writeFile(join(external, 'cli.js'), '')
      await mkdir(join(agentDir, 'node_modules'), { recursive: true })
      await symlink(external, join(agentDir, 'node_modules', 'escaped'))

      const discovery = await discoverDependencyBins(agentDir)

      expect(discovery.declarations).toEqual([])
      expect(discovery.issues).toContainEqual(
        expect.objectContaining({ package: 'escaped', message: expect.stringContaining('allowed agent path') }),
      )
    },
  )

  test('explicitly denies the typeclaw binary', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootPackage(agentDir, { typeclaw: '^1.0.0' })
    const packageRoot = await writePackage(agentDir, 'typeclaw', {
      name: 'typeclaw',
      bin: { typeclaw: 'cli.js', helper: 'helper.js' },
    })
    await writeFile(join(packageRoot, 'cli.js'), '')
    await writeFile(join(packageRoot, 'helper.js'), '')

    const discovery = await discoverDependencyBins(agentDir)

    expect(DEPENDENCY_BIN_DENYLIST.has('typeclaw')).toBe(true)
    expect(discovery.declarations.some((entry) => entry.bin === 'typeclaw')).toBe(false)
    expect(discovery.declarations).toContainEqual({ package: 'typeclaw', bin: 'helper', entry: 'helper.js' })
  })

  test('refuses ambiguous bin names exposed by multiple direct dependencies', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootPackage(agentDir, { alpha: '^1.0.0', beta: '^1.0.0' })
    const alpha = await writePackage(agentDir, 'alpha', { name: 'alpha', bin: { shared: 'cli.js' } })
    const beta = await writePackage(agentDir, 'beta', { name: 'beta', bin: { shared: 'cli.js' } })
    await writeFile(join(alpha, 'cli.js'), '')
    await writeFile(join(beta, 'cli.js'), '')

    const discovery = await discoverDependencyBins(agentDir)

    expect(discovery.declarations.some((entry) => entry.bin === 'shared')).toBe(false)
    expect(discovery.issues.map((issue) => issue.message).join('\n')).toContain(
      'direct dependencies alpha, beta expose duplicate bin shared',
    )
  })

  test('degrades gracefully for missing or malformed manifests, absent bins, and uninstalled dependencies', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await expect(discoverDependencyBins(missingRoot)).resolves.toMatchObject({ declarations: [] })

    const malformedRoot = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeFile(join(malformedRoot, 'package.json'), '{ invalid')
    await expect(discoverDependencyBins(malformedRoot)).resolves.toMatchObject({ declarations: [] })

    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootPackage(agentDir, {
      'library-only': '^1.0.0',
      missing: '^1.0.0',
      manifestless: '^1.0.0',
      malformed: '^1.0.0',
    })
    await writePackage(agentDir, 'library-only', { name: 'library-only' })
    await mkdir(join(agentDir, 'node_modules', 'manifestless'), { recursive: true })
    const malformedPackage = join(agentDir, 'node_modules', 'malformed')
    await mkdir(malformedPackage, { recursive: true })
    await writeFile(join(malformedPackage, 'package.json'), '{ invalid')

    const discovery = await discoverDependencyBins(agentDir)

    expect(discovery.declarations).toEqual([])
    expect(discovery.issues.map((issue) => issue.package)).toEqual(
      expect.arrayContaining(['missing', 'manifestless', 'malformed']),
    )
  })

  test('doctor reports a direct dependency bin whose entrypoint cannot resolve', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootPackage(agentDir, { broken: '^1.0.0' })
    await writePackage(agentDir, 'broken', { name: 'broken', bin: { 'broken-cli': 'missing.js' } })
    const registry = emptyRegistry()
    registerDependencyBinDoctorCheck(registry, agentDir, { info: () => {}, warn: () => {}, error: () => {} })

    const result = await registry.doctorChecks[0]?.check.run({
      pluginName: 'typeclaw',
      agentDir,
      config: undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result?.status).toBe('error')
    expect(result?.details?.join('\n')).toContain('broken-cli')
    expect(result?.details?.join('\n')).toContain('direct dependency broken')
  })
})
