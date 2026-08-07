export type CompletionClaimDecision =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  | { kind: 'warn'; notice: string }

export type CompletionClaimInput = {
  text: string | undefined
  qualifyingWorkObserved: boolean
}

export type ToolResultEvidenceInput = {
  toolName: string
  isError: boolean
  details: unknown
}

export function checkCompletionClaim(input: CompletionClaimInput): CompletionClaimDecision {
  if (input.qualifyingWorkObserved) return { kind: 'allow' }
  const text = normalize(input.text ?? '')
  if (text === '') return { kind: 'allow' }

  if (matchesKoreanClaim(text) || hasAssertivePhrase(text, ALL_FIRST_PERSON_PHRASES)) {
    return { kind: 'block', reason: UNSUPPORTED_COMPLETION_REASON }
  }
  if (SOFT_PHRASES.some((phrase) => text.includes(phrase))) {
    return { kind: 'warn', notice: SOFT_NOTICE }
  }
  return { kind: 'allow' }
}

export function isQualifyingWorkResult(input: ToolResultEvidenceInput): boolean {
  if (input.isError) return false
  const details = isRecord(input.details) ? input.details : undefined
  if (details?.ok === false || details?.error === true) return false
  if (
    NON_WORK_TOOLS.has(input.toolName) ||
    input.toolName.startsWith('channel_') ||
    input.toolName.startsWith('todo_')
  ) {
    return false
  }
  if (input.toolName === 'spawn_subagent') return details?.mode === 'sync'
  if (input.toolName === 'subagent_output') return details?.status === 'completed'
  return true
}

function normalize(text: string): string {
  return maskQuotedAndCodeSpans(text)
    .toLocaleLowerCase()
    .replace(/[*_~]/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n+/gu, '\n')
    .trim()
}

function maskQuotedAndCodeSpans(text: string): string {
  return NON_ASSERTED_SPAN_PATTERNS.reduce(
    (masked, pattern) => masked.replace(pattern, (span) => span.replace(/[^\r\n]/gu, ' ')),
    text,
  )
}

function matchesKoreanClaim(text: string): boolean {
  for (const phrase of KO_PHRASES) {
    for (const index of phraseIndexes(text, phrase)) {
      if (claimIsQuestion(text, index) || claimHasPastOrAttributedContext(text, index)) continue
      const prefix = text.slice(Math.max(latestSentenceBoundary(text, index) + 1, index - 24), index)
      if (KOREAN_OTHER_SUBJECT.test(prefix) && !KOREAN_FIRST_PERSON_SUBJECT.test(prefix)) continue
      return true
    }
  }
  return false
}

function hasAssertivePhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => {
    return phraseIndexes(text, phrase).some(
      (index) => !claimIsQuestion(text, index) && !claimHasPastOrAttributedContext(text, index),
    )
  })
}

function phraseIndexes(text: string, phrase: string): number[] {
  const indexes: number[] = []
  let offset = 0
  while (offset < text.length) {
    const index = text.indexOf(phrase, offset)
    if (index < 0) break
    indexes.push(index)
    offset = index + phrase.length
  }
  return indexes
}

function claimIsQuestion(text: string, claimIndex: number): boolean {
  const nextQuestion = earliestIndex(text, QUESTION_TERMINATORS, claimIndex)
  if (nextQuestion < 0) return false
  const nextStatementEnd = earliestIndex(text, DECLARATIVE_TERMINATORS, claimIndex)
  if (nextStatementEnd < 0) return true
  return nextQuestion < nextStatementEnd
}

function earliestIndex(text: string, needles: readonly string[], offset: number): number {
  const indexes = needles.map((needle) => text.indexOf(needle, offset)).filter((index) => index >= 0)
  return indexes.length === 0 ? -1 : Math.min(...indexes)
}

function claimHasPastOrAttributedContext(text: string, claimIndex: number): boolean {
  const sentenceStart = latestSentenceBoundary(text, claimIndex)
  const prefix = text.slice(sentenceStart + 1, claimIndex)
  return HISTORICAL_MARKERS.some((marker) => prefix.includes(marker)) || ATTRIBUTION_END.test(prefix)
}

function latestSentenceBoundary(text: string, offset: number): number {
  return Math.max(...SENTENCE_TERMINATORS.map((terminator) => text.lastIndexOf(terminator, offset)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Every block phrase is first-person and perfective. Bare verbs stay in the
// warning tier so descriptions of another actor are never hard-denied.
const EN_PHRASES: readonly string[] = [
  'i saved it',
  "i've saved it",
  'i have saved it',
  'i wrote it',
  "i've written it",
  'i recorded it',
  'i applied it',
  'i updated it',
  "i've updated it",
  'i fixed it',
  "i've fixed it",
  'i deployed it',
  'i committed it',
  'i removed it',
  'i deleted it',
  'i saved the ',
  "i've saved the ",
  'i wrote the ',
  "i've written the ",
  'i recorded the ',
  'i applied the ',
  'i updated the ',
  "i've updated the ",
  'i fixed the ',
  "i've fixed the ",
  'i deployed the ',
  'i committed the ',
  'i removed the ',
  'i deleted the ',
  'i saved your ',
  'i updated your ',
  'i fixed your ',
]

// Korean commonly drops the subject. The perfective endings below are safe for
// a bare assistant ack; an explicit nearby third-person 은/는/이/가 subject
// demotes the match, while 내가/제가 keeps the first-person reading.
const KO_PHRASES: readonly string[] = [
  '저장했어',
  '저장했습니다',
  '기록했어',
  '기록했습니다',
  '반영했어',
  '반영했습니다',
  '고쳤어',
  '고쳤습니다',
  '수정했어',
  '수정했습니다',
  '커밋했어',
  '커밋했습니다',
  '삭제했어',
  '삭제했습니다',
]

const ES_PHRASES: readonly string[] = ['lo guardé', 'lo escribí', 'lo actualicé', 'lo corregí', 'lo eliminé']
const FR_PHRASES: readonly string[] = [
  "je l'ai enregistré",
  "je l'ai écrit",
  "je l'ai mis à jour",
  "je l'ai corrigé",
  "je l'ai supprimé",
]
const IT_PHRASES: readonly string[] = [
  "l'ho salvato",
  "l'ho scritto",
  "l'ho aggiornato",
  "l'ho corretto",
  "l'ho eliminato",
]
const PT_PHRASES: readonly string[] = ['eu salvei', 'eu escrevi', 'eu atualizei', 'eu corrigi', 'eu removi']
const DE_PHRASES: readonly string[] = [
  'ich habe es gespeichert',
  'ich habe es geschrieben',
  'ich habe es aktualisiert',
  'ich habe es korrigiert',
  'ich habe es gelöscht',
]
const RU_PHRASES: readonly string[] = ['я сохранил', 'я записал', 'я обновил', 'я исправил', 'я удалил']
const ZH_PHRASES: readonly string[] = ['我已经保存了', '我已经写好了', '我已经更新了', '我已经修好了', '我已经删除了']
const JA_PHRASES: readonly string[] = [
  '私は保存しておきました',
  '私は書いておきました',
  '私は更新しておきました',
  '私は修正しておきました',
  '私は削除しておきました',
]
const AR_PHRASES: readonly string[] = ['أنا حفظته', 'أنا كتبته', 'أنا حدّثته', 'أنا أصلحته', 'أنا حذفته']
const HI_PHRASES: readonly string[] = [
  'मैंने इसे सहेज दिया',
  'मैंने इसे लिख दिया',
  'मैंने इसे अपडेट कर दिया',
  'मैंने इसे ठीक कर दिया',
  'मैंने इसे हटा दिया',
]
const TR_PHRASES: readonly string[] = ['kaydettim', 'yazdım', 'güncelledim', 'düzelttim', 'sildim']
const VI_PHRASES: readonly string[] = ['tôi đã lưu', 'tôi đã viết', 'tôi đã cập nhật', 'tôi đã sửa', 'tôi đã xóa']
const ID_PHRASES: readonly string[] = [
  'saya sudah menyimpan',
  'saya sudah menulis',
  'saya sudah memperbarui',
  'saya sudah memperbaiki',
  'saya sudah menghapus',
]

const ALL_FIRST_PERSON_PHRASES: readonly string[] = [
  ...EN_PHRASES,
  ...ES_PHRASES,
  ...FR_PHRASES,
  ...IT_PHRASES,
  ...PT_PHRASES,
  ...DE_PHRASES,
  ...RU_PHRASES,
  ...ZH_PHRASES,
  ...JA_PHRASES,
  ...AR_PHRASES,
  ...HI_PHRASES,
  ...TR_PHRASES,
  ...VI_PHRASES,
  ...ID_PHRASES,
]

const KOREAN_OTHER_SUBJECT = /(?:^|[\s,])[^\s,]{1,16}(?:은|는|이|가)(?:\s+\S+){0,3}\s*$/u
const KOREAN_FIRST_PERSON_SUBJECT = /(?:내가|제가|나는|저는)(?:\s+\S+){0,3}\s*$/u
const ATTRIBUTION_END =
  /(?:said|wrote|reported|dijo|a dit|ha detto|disse|sagte|сказал[аи]?|说|言いました|قال|कहा|dedi|nói|berkata|말했어|말했습니다|썼어|썼습니다)\s*[:"“']?\s*$/u
const QUESTION_TERMINATORS: readonly string[] = ['?', '？', '﹖']
const DECLARATIVE_TERMINATORS: readonly string[] = ['.', '!', '。', '！', '｡', '．', '﹒', '﹗', '\n']
const SENTENCE_TERMINATORS: readonly string[] = [...QUESTION_TERMINATORS, ...DECLARATIVE_TERMINATORS]
const NON_ASSERTED_SPAN_PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/gu,
  /`[^`\r\n]*`/gu,
  /"[^"\r\n]*"/gu,
  /(?<![\p{L}\p{N}])'[^'\r\n]+'(?![\p{L}\p{N}])/gu,
  /“[^”\r\n]*”/gu,
  /‘[^’\r\n]*’/gu,
  /「[^」\r\n]*」/gu,
  /『[^』\r\n]*』/gu,
]
const HISTORICAL_MARKERS: readonly string[] = [
  'yesterday',
  'earlier',
  'previously',
  'i thought',
  'i think',
  'last week',
  'last month',
  'for another project',
  'ayer',
  'hier',
  'ieri',
  'ontem',
  'gestern',
  'вчера',
  '昨天',
  '昨日',
  'أمس',
  'कल',
  'dün',
  'hôm qua',
  'kemarin',
  '어제',
  '라고',
  '줄 알았',
  '전에',
  '이전에',
  '지난주',
  '지난달',
]

const SOFT_PHRASES: readonly string[] = ['saved and ready', 'updated and ready', '반영 완료', '수정 완료']

const NON_WORK_TOOLS = new Set(['skip_response', 'restart', 'grant_role', 'subagent_cancel'])

const UNSUPPORTED_COMPLETION_REASON =
  'This reply claims you already completed durable work, but this logical turn has no successful non-communication work result to support it. ' +
  'Actually perform the work with the appropriate tool, confirm that it succeeds, and then reply with the completion claim. ' +
  'If no durable change was intended, reword the reply without claiming it was saved, applied, updated, fixed, or otherwise completed.'

const SOFT_NOTICE =
  'This reply sounds completion-shaped, but no successful non-communication work was observed this turn. ' +
  'Only claim a durable result after the relevant tool succeeds; otherwise describe what remains to be done.'
