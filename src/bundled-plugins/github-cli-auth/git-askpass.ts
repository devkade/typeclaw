import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// A GIT_ASKPASS helper git invokes for username/password prompts. The token
// rides in TYPECLAW_GIT_TOKEN (env, via the bash env overlay), NEVER in argv or
// git config — so it cannot leak through process listings, logs, or .git/config.
// The script contents are constant and secret-free; only the env value is secret.
//
// Host-scoped: git's prompt is `Username for 'https://github.com': ` etc. We
// answer ONLY when the prompt names github.com; for any other host (e.g. one an
// `insteadOf`/`pushurl` rewrite redirected to) we exit non-zero WITHOUT printing
// the token, so a redirect can never exfiltrate it. The analyzer already blocks
// the known redirect vectors; this is defense-in-depth at the credential edge.
//
// Two prompt shapes must match, because git rewrites the host between the two
// prompts of a single clone/fetch: it first asks `Username for
// 'https://github.com': `, and AFTER we answer `x-access-token` it folds that
// userinfo into the host of the SECOND prompt — `Password for
// 'https://x-access-token@github.com': `. So we accept both bare-host
// (\`//github.com/\` or \`//github.com'\`) and userinfo-host
// (\`//<user>@github.com/\` or \`//<user>@github.com'\`). The anchor is the
// literal \`github.com\` immediately followed by \`/\` or the closing quote git
// wraps the URL in, so it cannot be fooled by \`evil-github.com\`,
// \`github.com.evil/\`, or \`x@github.com.evil/\`. Without the userinfo arm the
// password prompt falls through to \`exit 1\` and every HTTPS clone/fetch fails
// with "unable to read askpass response".
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *//github.com/*|*//github.com\\'*|*//*@github.com/*|*//*@github.com\\'*) : ;;
  *) exit 1 ;;
esac
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *) printf '%s\\n' "$TYPECLAW_GIT_TOKEN" ;;
esac
`

// The consumers that call this today (reviewer checkout, backup push) run git via
// Node `execFile`, NOT sandboxed bash, so the helper only needs to be runtime
// writable+readable — it does NOT need to sit under a sandbox-visible mount. The
// old default `/usr/local/bin` assumed a root-writable /usr and EACCES'd whenever
// the runtime ran as a non-root user, breaking the checkout with an opaque
// permission-denied. A process-private temp dir (mode 0700) under os.tmpdir() is
// always runtime-writable and keeps the helper out of any model-writable tree
// (agentDir / session /tmp), so a tool can't plant a script that captures a later
// runtime-issued token. TYPECLAW_GIT_ASKPASS_PATH still overrides for tests/CI or
// a future sandbox consumer that binds an exact path in; the override is used
// verbatim with NO fallback, so an unusable configured path surfaces loudly
// rather than silently degrading to a path the caller didn't ask for.
let defaultDirPromise: Promise<string> | null = null

function resolveDefaultDir(): Promise<string> {
  if (defaultDirPromise === null) defaultDirPromise = mkdtemp(join(tmpdir(), 'typeclaw-git-askpass-'))
  return defaultDirPromise.catch((err) => {
    defaultDirPromise = null
    throw err
  })
}

async function defaultPath(): Promise<string> {
  const override = process.env.TYPECLAW_GIT_ASKPASS_PATH
  if (override !== undefined && override !== '') return override
  return join(await resolveDefaultDir(), 'typeclaw-git-askpass')
}

// Keyed by resolved path: a single shared promise would let the first caller's
// path win even when a later caller explicitly asks for a different one (the
// reviewer and backup consumers can legitimately request distinct paths).
const ensurePromises = new Map<string, Promise<string>>()

export function resetGitAskPassHelperForTests(): void {
  ensurePromises.clear()
  defaultDirPromise = null
}

// Writes the helper once per path (idempotent, race-safe via the per-path
// promise) and returns its absolute path. The temp name is unpredictable and
// opened with `wx` (exclusive create, fails on an existing file/symlink) so a
// planted symlink cannot redirect the write; then atomically renamed so a
// concurrent reader never sees a partial file.
export async function ensureGitAskPassHelper(path?: string): Promise<string> {
  const resolved = path ?? (await defaultPath())
  const existing = ensurePromises.get(resolved)
  if (existing !== undefined) return existing
  const pending = (async () => {
    await mkdir(dirname(resolved), { recursive: true })
    const tmp = join(dirname(resolved), `.typeclaw-git-askpass.${randomBytes(8).toString('hex')}.tmp`)
    await writeFile(tmp, ASKPASS_SCRIPT, { mode: 0o755, flag: 'wx' })
    await chmod(tmp, 0o755)
    await rename(tmp, resolved)
    return resolved
  })().catch((err) => {
    ensurePromises.delete(resolved)
    throw err
  })
  ensurePromises.set(resolved, pending)
  return pending
}
