import { isSecretShapedToken } from '@/bundled-plugins/memory/secret-detector'

export type OperationalIncidentFact =
  | { kind: 'bash-command-not-found'; bin: string }
  | { kind: 'declared-skill-bin-unresolved'; bin: string }
  | { kind: 'sandbox-proc-unavailable' }

export type OperationalIncidentResolutionSignal = 'successful-bin' | 'successful-sandbox-real-proc'

export type OperationalIncidentSuccessInput = {
  tool: string
  args: Record<string, unknown>
  sandboxedRealProcSucceeded: boolean
}

export const OPERATIONAL_INCIDENT_RESOLUTION_SIGNAL_BY_KIND = {
  'bash-command-not-found': 'successful-bin',
  'declared-skill-bin-unresolved': 'successful-bin',
  'sandbox-proc-unavailable': 'successful-sandbox-real-proc',
} as const satisfies Record<OperationalIncidentFact['kind'], OperationalIncidentResolutionSignal>

export class DeclaredSkillBinUnresolvedError extends Error {
  override readonly name = 'DeclaredSkillBinUnresolvedError'

  constructor(readonly bin: string) {
    super(`declared skill bin could not be resolved: ${bin}`)
  }
}

const SAFE_BIN = '[A-Za-z0-9][A-Za-z0-9._+-]{0,127}'
const COMMAND_NOT_FOUND = new RegExp(
  `^(?:/bin/bash: |bash: line [1-9][0-9]{0,5}: )(${SAFE_BIN}): command not found\\n(?:\\n){1,2}Command exited with code 127$`,
)

export function classifyToolOutcome(input: { tool: string; error: unknown }): OperationalIncidentFact | null {
  if (input.error instanceof DeclaredSkillBinUnresolvedError && isSafeBin(input.error.bin)) {
    return { kind: 'declared-skill-bin-unresolved', bin: input.error.bin }
  }
  if (input.tool !== 'bash' || !(input.error instanceof Error)) return null
  if (input.error.name === 'SandboxDegradedProcError') return { kind: 'sandbox-proc-unavailable' }

  const match = COMMAND_NOT_FOUND.exec(input.error.message)
  const bin = match?.[1]
  return bin === undefined ? null : bashCommandNotFoundFact(bin)
}

export function deriveOperationalIncidentFactsForSuccess(
  input: OperationalIncidentSuccessInput,
): OperationalIncidentFact[] {
  if (input.tool !== 'bash') return []
  const command = input.args.command
  if (typeof command !== 'string') return []
  // False resolution hides a live defect; under-resolution only leaves a visible stale warning.
  // Accept only syntax where aggregate exit zero proves this exact invocation succeeded.
  const commandWord = parseSingleUnconditionalInvocation(command)
  if (commandWord === null) return []

  const facts = successfulBinFacts(commandWord)
  if (input.sandboxedRealProcSucceeded) facts.push({ kind: 'sandbox-proc-unavailable' })
  return facts
}

function bashCommandNotFoundFact(bin: string): OperationalIncidentFact | null {
  return isSafeBin(bin) ? { kind: 'bash-command-not-found', bin } : null
}

function successfulBinFacts(bin: string): OperationalIncidentFact[] {
  if (!isSafeBin(bin)) return []
  return [
    { kind: 'bash-command-not-found', bin },
    { kind: 'declared-skill-bin-unresolved', bin },
  ]
}

function isSafeBin(bin: string): boolean {
  return new RegExp(`^${SAFE_BIN}$`).test(bin) && !isSecretShapedToken(bin)
}

const SHELL_CONSTRUCTS = new Set([
  '!',
  'case',
  'coproc',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
])

function parseSingleUnconditionalInvocation(command: string): string | null {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let active = false
  const endWord = (): void => {
    if (!active) return
    words.push(word)
    word = ''
    active = false
  }

  for (let i = 0; i < command.length; i++) {
    const character = command[i]!
    if (quote !== null) {
      if (character === quote) {
        quote = null
      } else {
        if (quote === '"' && (character === '`' || (character === '$' && command[i + 1] === '('))) return null
        if (character === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
        else word += character
      }
      active = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      active = true
      continue
    }
    if (character === '\\') {
      if (i + 1 >= command.length) return null
      word += command[++i]
      active = true
      continue
    }
    if (';&|<>\n\r()'.includes(character) || character === '`' || (character === '$' && command[i + 1] === '('))
      return null
    if (character === '#' && !active) return null
    if (character === ' ' || character === '\t') {
      endWord()
      continue
    }
    word += character
    active = true
  }
  if (quote !== null) return null
  endWord()
  const commandWord = words.find((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate))
  if (commandWord === undefined || SHELL_CONSTRUCTS.has(commandWord)) return null
  return commandWord
}
