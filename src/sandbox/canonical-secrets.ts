export const CANONICAL_AGENT_SECRET_DIRS = [
  'workspace/.config/gws',
  'workspace/.agent-messenger',
  '.typeclaw/home',
] as const

export const CANONICAL_AGENT_SECRET_FILES = ['.env', 'secrets.json', 'auth.json'] as const

// Canonical files whose recovery from Git history is a real confidentiality bypass. `.env` is
// deliberately absent: per the expose-to-agent policy (PR #1244), every declared `.env` var is
// already inherited into model bash, so recovering `.env` bytes from history discloses nothing the
// operator did not already hand the agent — blocking all git/bash over a historical `.env` is pure
// disruption. `secrets.json`/`auth.json` are never inherited, so their history recovery IS a bypass
// and stays blocking. The live-file bwrap mask and non-bash denial still cover `.env` via
// CANONICAL_AGENT_SECRET_FILES; only the history scanner uses this narrower set.
export const CANONICAL_GIT_HISTORY_SECRET_FILES = ['secrets.json', 'auth.json'] as const

export const CANONICAL_HOME_SECRET_DIRS = [
  '.ssh',
  '.config/gh',
  '.config/gws',
  '.agent-messenger',
  '.codex',
  '.claude',
] as const

export const CANONICAL_HOME_SECRET_FILES = ['.gitconfig', '.claude.json', '.netrc'] as const
