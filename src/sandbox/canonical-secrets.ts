import {
  AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
  LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
} from '@/agent-messenger/config-dir'

export const CANONICAL_AGENT_SECRET_DIRS = [
  'workspace/.config/gws',
  AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
  // Retained permanently for interrupted migrations, operator backups under
  // the old name, and older installs. This is not an active config location.
  LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR,
  '.typeclaw/home',
  '.typeclaw/logs',
] as const

export const CANONICAL_AGENT_SECRET_FILES = ['.env', 'secrets.json', 'auth.json'] as const

// Trusted runtime processes use this ephemeral container HOME. bwrap builds an
// empty root and never binds /home, so model bash cannot see it; non-bash tools
// run in-process and use this fixed path as an unconditional denial root in
// addition to os.homedir() (which resolves here in the container).
export const CONTAINER_RUNTIME_HOME = '/home/agent'

export const CANONICAL_HOME_SECRET_DIRS = [
  '.ssh',
  '.config/gh',
  '.config/gws',
  '.config/agent-messenger',
  '.agent-messenger',
  '.codex',
  '.claude',
] as const

export const CANONICAL_HOME_SECRET_FILES = ['.gitconfig', '.claude.json', '.netrc'] as const
