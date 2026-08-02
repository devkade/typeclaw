import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const TRUSTED_BASELINE_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'] as const
export const DEPENDENCY_BIN_DENYLIST: ReadonlySet<string> = new Set(['typeclaw'])

export type DependencyBinDeclaration = {
  package: string
  bin: string
  entry: string
  workspace?: boolean
}

export type ResolvedDependencyBin =
  | { kind: 'baseline'; declaration: DependencyBinDeclaration; executable: string }
  | { kind: 'package'; declaration: DependencyBinDeclaration; entrypoint: string; containerEntrypoint: string }
  | { kind: 'unavailable'; declaration: DependencyBinDeclaration; reason: string }
  | { kind: 'denied'; declaration: DependencyBinDeclaration; reason: string }

export async function resolveDependencyBin(
  agentDir: string,
  declaration: DependencyBinDeclaration,
  baselineDirs: readonly string[] = TRUSTED_BASELINE_BIN_DIRS,
  deniedBins: ReadonlySet<string> = DEPENDENCY_BIN_DENYLIST,
): Promise<ResolvedDependencyBin> {
  if (deniedBins.has(declaration.bin)) {
    return { kind: 'denied', declaration, reason: 'bin is denied by runtime policy' }
  }
  for (const dir of baselineDirs) {
    const executable = join(dir, declaration.bin)
    if (await isExecutable(executable)) return { kind: 'baseline', declaration, executable }
  }

  const agentRoot = await realpath(agentDir).catch(() => undefined)
  const nodeModulesRoot = await realpath(join(agentDir, 'node_modules')).catch(() => undefined)
  const packageRoot = join(agentDir, 'node_modules', ...declaration.package.split('/'))
  const resolvedRoot = await realpath(packageRoot).catch(() => undefined)
  if (agentRoot === undefined || nodeModulesRoot === undefined || resolvedRoot === undefined) {
    return {
      kind: 'unavailable',
      declaration,
      reason: `direct dependency ${declaration.package} is not installed`,
    }
  }
  const resolvedEntry = await realpath(resolve(resolvedRoot, declaration.entry)).catch(() => undefined)
  const packageRootAllowed =
    isInside(nodeModulesRoot, resolvedRoot) || (declaration.workspace === true && isInside(agentRoot, resolvedRoot))
  if (resolvedEntry === undefined || !packageRootAllowed || !isInside(resolvedRoot, resolvedEntry)) {
    return {
      kind: 'unavailable',
      declaration,
      reason: `direct dependency ${declaration.package} bin entry is missing or escapes its package`,
    }
  }
  return {
    kind: 'package',
    declaration,
    entrypoint: resolvedEntry,
    // The agent directory is bound into bwrap at its original absolute path.
    // /bin/sh consumes this path, so keep POSIX separators even in Windows tests;
    // production sandbox execution itself is Linux-only.
    containerEntrypoint: resolvedEntry.split(sep).join('/'),
  }
}

export async function resolveDependencyBins(
  agentDir: string,
  declarations: readonly DependencyBinDeclaration[],
  baselineDirs: readonly string[] = TRUSTED_BASELINE_BIN_DIRS,
  deniedBins: ReadonlySet<string> = DEPENDENCY_BIN_DENYLIST,
): Promise<ResolvedDependencyBin[]> {
  return Promise.all(
    declarations.map((declaration) => resolveDependencyBin(agentDir, declaration, baselineDirs, deniedBins)),
  )
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
