import { describe, expect, test } from 'bun:test'

import { checkCompletionClaim, isQualifyingWorkResult } from './completion-claim'

describe('checkCompletionClaim', () => {
  test.each(['I saved it', "I've updated it", 'I fixed it', 'I committed it', 'I updated the file', 'I fixed the bug'])(
    'blocks unsupported English completion claim: %s',
    (text) => {
      expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('block')
    },
  )

  test.each(['반영했어', '저장했어요', '수정했어', '커밋했어요'])(
    'blocks unsupported Korean completion claim: %s',
    (text) => {
      expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('block')
    },
  )

  test('allows the identical claim after qualifying work', () => {
    expect(checkCompletionClaim({ text: '반영했어', qualifyingWorkObserved: true }).kind).toBe('allow')
    expect(checkCompletionClaim({ text: 'I saved it', qualifyingWorkObserved: true }).kind).toBe('allow')
  })

  test.each([
    'the upstream fixed it',
    'A teammate already updated it',
    '상류 시스템이 반영했어',
    '반영했어?',
    'I did not save it',
    'Yesterday I saved it for another project',
    'A teammate said: I saved it',
    'I thought I saved it, but the write failed',
    '어제 반영했어',
    '상류 시스템이 이미 반영했어',
  ])('allows descriptive, third-party, question, or negated prose: %s', (text) => {
    expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('allow')
  })

  test('warns rather than blocks on an unanchored completion-shaped phrase', () => {
    expect(checkCompletionClaim({ text: 'updated and ready', qualifyingWorkObserved: false }).kind).toBe('warn')
  })

  test('does not let a later question hide a declarative completion claim', () => {
    expect(checkCompletionClaim({ text: 'I saved it. Anything else?', qualifyingWorkObserved: false }).kind).toBe(
      'block',
    )
    expect(checkCompletionClaim({ text: 'I saved it\nAnything else?', qualifyingWorkObserved: false }).kind).toBe(
      'block',
    )
  })

  test('recognizes non-ASCII question punctuation without hiding an earlier assertion', () => {
    expect(checkCompletionClaim({ text: '私は保存しておきました？', qualifyingWorkObserved: false }).kind).toBe('allow')
    expect(
      checkCompletionClaim({ text: '私は保存しておきました。ほかにありますか？', qualifyingWorkObserved: false }).kind,
    ).toBe('block')
  })

  test.each([
    '昨天没有操作。现在我已经保存了',
    '昨天没有操作！现在我已经保存了',
    '昨天有操作吗？现在我已经保存了',
    '昨天没有操作\n现在我已经保存了',
    '昨日は操作していません。今、私は保存しておきました',
    '昨日は操作していません！今、私は保存しておきました',
    '昨日は操作しましたか？今、私は保存しておきました',
    '昨日は操作していません\n今、私は保存しておきました',
  ])('does not carry historical context across a CJK sentence boundary: %s', (text) => {
    expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('block')
  })

  test.each([
    'The warning "I fixed it" is inaccurate.',
    "The warning 'I fixed it' is inaccurate.",
    'The warning “I fixed it” is inaccurate.',
    'The warning 「I fixed it」 is inaccurate.',
    'The warning 『I fixed it』 is inaccurate.',
    '警告「我已经修好了」は不正確です。',
    'The warning `I fixed it` is inaccurate.',
  ])('allows completion-shaped text inside quotation or code spans: %s', (text) => {
    expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('allow')
  })

  test.each(["I've fixed it", "je l'ai enregistré", "l'ho salvato"])(
    'does not mistake a contraction apostrophe for a quotation span: %s',
    (text) => {
      expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('block')
    },
  )

  test.each(['상류 시스템이 끝냈어. 반영했어', '상류 시스템이 끝냈어。반영했어', '상류 시스템이 끝냈어\n반영했어'])(
    'does not carry a Korean third-person subject across a sentence boundary: %s',
    (text) => {
      expect(checkCompletionClaim({ text, qualifyingWorkObserved: false }).kind).toBe('block')
    },
  )
})

describe('isQualifyingWorkResult', () => {
  test.each(['read', 'write', 'edit', 'bash'])('counts a successful %s result as qualifying work', (toolName) => {
    expect(isQualifyingWorkResult({ toolName, isError: false, details: { ok: true } })).toBe(true)
  })

  test.each(['channel_reply', 'channel_send', 'channel_react', 'todo_write', 'skip_response'])(
    'does not count successful communication/control tool %s',
    (toolName) => {
      expect(isQualifyingWorkResult({ toolName, isError: false, details: { ok: true } })).toBe(false)
    },
  )

  test('requires success and completed subagent work', () => {
    expect(isQualifyingWorkResult({ toolName: 'write', isError: true, details: { ok: true } })).toBe(false)
    expect(isQualifyingWorkResult({ toolName: 'write', isError: false, details: { ok: false } })).toBe(false)
    expect(
      isQualifyingWorkResult({ toolName: 'spawn_subagent', isError: false, details: { mode: 'background' } }),
    ).toBe(false)
    expect(isQualifyingWorkResult({ toolName: 'spawn_subagent', isError: false, details: { mode: 'sync' } })).toBe(true)
    expect(
      isQualifyingWorkResult({ toolName: 'subagent_output', isError: false, details: { status: 'completed' } }),
    ).toBe(true)
  })

  test.each(['web_fetch', 'web_search'])('does not count a normally returned %s failure', (toolName) => {
    expect(isQualifyingWorkResult({ toolName, isError: false, details: { error: true } })).toBe(false)
  })
})
