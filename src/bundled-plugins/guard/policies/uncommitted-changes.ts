import { resolveAgentGit } from '@/git/resolve-agent-git'
import { runGit } from '@/git/run'
import type { ContentPart, ToolResult } from '@/plugin'

export const GUARD_UNCOMMITTED_CHANGES = 'uncommittedChanges'

const FILE_TOUCHING_TOOLS = new Set(['write', 'edit', 'bash'])

const RUNTIME_OWNED_PREFIXES = ['sessions/', 'memory/']

const WARNING_TEXT =
  '\n\n[guard:uncommittedChanges] The worktree has uncommitted changes. Commit (or stash) them when this task is done — leaving stale changes around between turns risks losing work and confusing future commits.'

export type UncommittedChangesDeps = {
  readStatus: (agentDir: string, gitArgs: readonly string[]) => Promise<readonly string[] | null>
}

export async function checkUncommittedChangesAdvice(options: {
  tool: string
  agentDir: string
  result: ToolResult
  deps?: UncommittedChangesDeps
}): Promise<void> {
  const { tool, agentDir, result } = options
  if (!FILE_TOUCHING_TOOLS.has(tool)) return
  const repo = resolveAgentGit(agentDir)
  if (!repo) return

  const deps = options.deps ?? defaultDeps
  const status = await deps.readStatus(agentDir, repo.gitArgs)
  if (status === null) return

  const dirty = status.filter((p) => !RUNTIME_OWNED_PREFIXES.some((prefix) => p.startsWith(prefix)))
  if (dirty.length === 0) return

  appendAdviceToContent(result.content, WARNING_TEXT)
}

export function parsePorcelain(stdout: string): string[] {
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue
    const rest = raw.slice(3)
    const arrowIdx = rest.indexOf(' -> ')
    out.push(arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4))
  }
  return out
}

function appendAdviceToContent(content: ContentPart[], advice: string): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part && part.type === 'text') {
      content[i] = { ...part, text: `${part.text}${advice}` }
      return
    }
  }
  content.push({ type: 'text', text: advice.trimStart() })
}

const defaultDeps: UncommittedChangesDeps = {
  async readStatus(agentDir, gitArgs) {
    const bun = getBun()
    if (!bun) return null
    try {
      const { exitCode, stdout } = await runGit(bun, agentDir, [...gitArgs, 'status', '--porcelain=v1'])
      if (exitCode !== 0) return null
      return parsePorcelain(stdout)
    } catch {
      return null
    }
  },
}

function getBun(): typeof Bun | null {
  const g = globalThis as { Bun?: typeof Bun }
  return g.Bun ?? null
}
