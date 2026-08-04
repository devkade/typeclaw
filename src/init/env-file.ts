import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_FILE = '.env'

// Parse the agent's `.env` into a key-value map, mirroring Docker's
// `--env-file` parser (docker/cli `pkg/kvfile.parseKeyValueFile`): a UTF-8 BOM
// is stripped from the FIRST line only, every line is left-trimmed of Unicode
// whitespace BEFORE the blank/`#` check, and nothing is trimmed around or after
// `=` (no quote stripping, no shell expansion). Last value wins on duplicates.
//
// The normalization is load-bearing, not cosmetic: Docker accepts a BOM-prefixed
// or indented `KEY=value` and passes it to the container, so a parser that missed
// those would report an operator-declared variable as absent — which callers read
// as "TypeClaw may manage this", e.g. migrating a deliberately pinned directory.
export function readEnvFile(cwd: string): Map<string, string> {
  const out = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(join(cwd, ENV_FILE), 'utf8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return out
    throw err
  }
  const lines = raw.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const withoutBom = index === 0 ? rawLine.replace(/^\uFEFF/, '') : rawLine
    // \p{White_Space}, not \s: JS \s also matches U+FEFF (and misses U+0085),
    // so \s would strip a BOM on EVERY line while Go's unicode.IsSpace — which
    // Docker uses — strips it on line 1 only.
    const line = withoutBom.replace(/^\p{White_Space}+/u, '')
    if (line.length === 0) continue
    if (line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    // Docker rejects the whole file when a key contains a space or tab, so such
    // a line can never reach a container; skip it rather than inventing a key.
    if (/[ \t]/.test(key)) continue
    out.set(key, line.slice(eq + 1))
  }
  return out
}

export function hasEnvKey(cwd: string, key: string): boolean {
  const value = readEnvFile(cwd).get(key)
  return value !== undefined && value.length > 0
}

// Write `key=value` to the agent's `.env`. Idempotent: replaces an existing
// line for the same key in place (preserving order and surrounding comments),
// or appends if absent. Creates the file if missing. The value is written
// verbatim with no quoting because Docker's `--env-file` parser does not
// strip quotes (a wrapping `"..."` would land in `process.env` literally).
export function appendOrReplaceEnvKey(cwd: string, key: string, value: string): void {
  const path = join(cwd, ENV_FILE)
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'ENOENT') throw err
  }
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)
  // `"foo\n".split(/\r?\n/)` returns `["foo", ""]` — strip that phantom
  // trailing empty element so the rebuilt output ends in exactly one newline
  // regardless of replace-vs-append path.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let replaced = false
  const next = lines.map((line) => {
    if (line.startsWith('#')) return line
    const eq = line.indexOf('=')
    if (eq <= 0) return line
    if (line.slice(0, eq) !== key) return line
    replaced = true
    return `${key}=${value}`
  })
  if (!replaced) next.push(`${key}=${value}`)
  const out = `${next.join('\n')}\n`
  writeFileSync(path, out, 'utf8')
}
