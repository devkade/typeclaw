import { describe, expect, test } from 'bun:test'

import {
  classifyToolOutcome,
  DeclaredSkillBinUnresolvedError,
  deriveOperationalIncidentFactsForSuccess,
  OPERATIONAL_INCIDENT_RESOLUTION_SIGNAL_BY_KIND,
} from './classify-tool-outcome'

describe('classifyToolOutcome', () => {
  test.each([
    '/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127',
    'bash: line 1: opensoma: command not found\n\nCommand exited with code 127',
    'bash: line 27: opensoma: command not found\n\nCommand exited with code 127',
  ])('classifies an exact bash command-not-found result', (message) => {
    expect(classifyToolOutcome({ tool: 'bash', error: new Error(message) })).toEqual({
      kind: 'bash-command-not-found',
      bin: 'opensoma',
    })
  })

  test('classifies a declared skill bin that failed deterministic resolution', () => {
    expect(classifyToolOutcome({ tool: 'bash', error: new DeclaredSkillBinUnresolvedError('opensoma') })).toEqual({
      kind: 'declared-skill-bin-unresolved',
      bin: 'opensoma',
    })
  })

  test('derives a successful single invocation through the classifier-owned safe-bin gate', () => {
    const credentialShaped = 's' + 'k-' + 'X'.repeat(32)

    expect(
      deriveOperationalIncidentFactsForSuccess({
        tool: 'bash',
        args: { command: 'MODE=test OpenSoma --version' },
        sandboxedRealProcSucceeded: false,
      }),
    ).toEqual([
      { kind: 'bash-command-not-found', bin: 'OpenSoma' },
      { kind: 'declared-skill-bin-unresolved', bin: 'OpenSoma' },
    ])
    expect(
      deriveOperationalIncidentFactsForSuccess({
        tool: 'bash',
        args: { command: credentialShaped },
        sandboxedRealProcSucceeded: false,
      }),
    ).toEqual([])
    expect(
      deriveOperationalIncidentFactsForSuccess({
        tool: 'read',
        args: { command: 'opensoma' },
        sandboxedRealProcSucceeded: false,
      }),
    ).toEqual([])
  })

  test.each([
    'opensoma --version || true',
    'a && opensoma',
    'opensoma | tee out',
    'if ! opensoma; then echo skip; fi',
    'opensoma; true',
    'opensoma &',
    'true\nopensoma',
    '(opensoma)',
    'echo $(opensoma)',
    'echo `opensoma`',
    'opensoma >out',
    'while opensoma; do true; done',
    'for item in opensoma; do true; done',
    'case value in opensoma) true;; esac',
    'function opensoma { true; }',
  ])('derives no success evidence from ambiguous shell command %s', (command) => {
    expect(
      deriveOperationalIncidentFactsForSuccess({
        tool: 'bash',
        args: { command },
        sandboxedRealProcSucceeded: true,
      }),
    ).toEqual([])
  })

  test('maps every incident fact kind to a mechanical resolution signal', () => {
    expect(OPERATIONAL_INCIDENT_RESOLUTION_SIGNAL_BY_KIND).toEqual({
      'bash-command-not-found': 'successful-bin',
      'declared-skill-bin-unresolved': 'successful-bin',
      'sandbox-proc-unavailable': 'successful-sandbox-real-proc',
    })
  })

  test.each([
    's' + 'k-' + 'X'.repeat(32),
    'gh' + 'p_' + 'X'.repeat(36),
    'xo' + 'xb-' + '1234567890-1234567890-' + 'X'.repeat(16),
    `eyJ${'A'.repeat(20)}.eyJ${'B'.repeat(20)}.${'C'.repeat(40)}`,
    'deadbeef'.repeat(8),
    'Ab3_'.repeat(16),
  ])('does not classify credential-shaped executable token %s', (bin) => {
    const message = `/bin/bash: ${bin}: command not found\n\n\nCommand exited with code 127`

    expect(classifyToolOutcome({ tool: 'bash', error: new Error(message) })).toBeNull()
    expect(classifyToolOutcome({ tool: 'bash', error: new DeclaredSkillBinUnresolvedError(bin) })).toBeNull()
  })

  test.each([
    { tool: 'read', message: '/bin/bash: opensoma: command not found\n\n\nCommand exited with code 127' },
    { tool: 'bash', message: '/bin/bash: opensoma: command not found\n\n\nCommand exited with code 126' },
    { tool: 'bash', message: 'documentation says opensoma: command not found\nCommand exited with code 127' },
    { tool: 'bash', message: '/bin/bash: /tmp/opensoma: command not found\n\n\nCommand exited with code 127' },
    { tool: 'bash', message: '/bin/bash: TOKEN=value: command not found\n\n\nCommand exited with code 127' },
    { tool: 'bash', message: 'bash: line 0: opensoma: command not found\n\nCommand exited with code 127' },
    { tool: 'bash', message: 'bash: line 0002: opensoma: command not found\n\nCommand exited with code 127' },
    { tool: 'bash', message: 'bash: line 1234567: opensoma: command not found\n\nCommand exited with code 127' },
  ])('does not classify near-match $tool / $message', ({ tool, message }) => {
    expect(classifyToolOutcome({ tool, error: new Error(message) })).toBeNull()
  })
})
