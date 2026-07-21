import type { Readability as ReadabilityClass } from '@mozilla/readability'
import type TurndownService from 'turndown'

// Perf: jsdom (+readability+turndown) costs ~40-60MB RSS at import time. Keep it
// lazy so idle agents that never call web_fetch don't pay for it. Do NOT hoist to
// a top-level import.
type ReadabilityDeps = {
  Readability: typeof ReadabilityClass
  JSDOM: typeof import('jsdom').JSDOM
  turndown: TurndownService
}

let depsPromise: Promise<ReadabilityDeps> | undefined

async function loadDeps(): Promise<ReadabilityDeps> {
  depsPromise ??= (async () => {
    const [{ Readability }, { JSDOM }, { default: TurndownCtor }] = await Promise.all([
      import('@mozilla/readability'),
      import('jsdom'),
      import('turndown'),
    ])
    const turndown = new TurndownCtor({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
      hr: '---',
    })
    turndown.remove(['script', 'style', 'meta', 'link', 'noscript', 'iframe'])
    return { Readability, JSDOM, turndown }
  })()
  return depsPromise
}

type ReadabilityDocument = ConstructorParameters<typeof ReadabilityClass>[0]

export async function applyReadability(html: string, url: string): Promise<string> {
  const { Readability, JSDOM, turndown } = await loadDeps()

  const dom = new JSDOM(html, { url })
  const document = dom.window.document.cloneNode(true) as unknown as ReadabilityDocument
  const article = new Readability(document).parse()

  const source = article?.content?.trim() ? article.content : html
  const markdown = turndown.turndown(source).trim()

  if (!markdown) return 'Readability extracted no content from this page.'

  if (article?.title) {
    return `# ${article.title}\n\n${markdown}`
  }
  return markdown
}
