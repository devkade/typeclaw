import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

import { readEnvFile } from '@/init/env-file'

export const AGENT_MESSENGER_CONFIG_RELATIVE_DIR = 'workspace/.config/agent-messenger'
export const LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR = 'workspace/.agent-messenger'

const CONTAINER_AGENT_DIR = '/agent'

// posix.join, not join: this path is baked into the Dockerfile ENV and the
// `docker run -e` override, so it must stay `/agent/...` even when the host
// stage runs on native Windows (where join would emit backslashes).
export const CONTAINER_AGENT_MESSENGER_CONFIG_DIR = posix.join(CONTAINER_AGENT_DIR, AGENT_MESSENGER_CONFIG_RELATIVE_DIR)

export type MigrationResult = { ok: true; migrated: boolean } | { ok: false; reason: string }

export type AgentMessengerConfigPolicy = {
  override: string | null
  containerDir: string
  migrate: boolean
}

export function agentMessengerConfigDir(agentDir: string): string {
  return join(agentDir, AGENT_MESSENGER_CONFIG_RELATIVE_DIR)
}

export function legacyAgentMessengerConfigDir(agentDir: string): string {
  return join(agentDir, LEGACY_AGENT_MESSENGER_CONFIG_RELATIVE_DIR)
}

export function resolveAgentMessengerConfigPolicy(agentDir: string): AgentMessengerConfigPolicy {
  const value = readEnvFile(agentDir).get('AGENT_MESSENGER_CONFIG_DIR')
  if (value === undefined || value.length === 0) {
    return { override: null, containerDir: CONTAINER_AGENT_MESSENGER_CONFIG_DIR, migrate: true }
  }

  const containerDir = posix.resolve(CONTAINER_AGENT_DIR, value)
  return {
    override: value,
    containerDir,
    migrate: containerDir === CONTAINER_AGENT_MESSENGER_CONFIG_DIR,
  }
}

export async function migrateAgentMessengerConfigDir(agentDir: string): Promise<MigrationResult> {
  const legacyDir = legacyAgentMessengerConfigDir(agentDir)
  const configDir = agentMessengerConfigDir(agentDir)

  const legacy = await inspectDirectory(legacyDir)
  const current = await inspectDirectory(configDir)
  if (legacy.exists && !legacy.directory) return invalidDirectoryResult(legacyDir, legacy.kind)
  if (current.exists && !current.directory) return invalidDirectoryResult(configDir, current.kind)
  if (!legacy.exists) return { ok: true, migrated: false }

  const configParent = await inspectDirectory(dirname(configDir))
  if (configParent.exists && !configParent.directory) {
    return invalidDirectoryResult(dirname(configDir), configParent.kind)
  }

  if (!current.exists) {
    await mkdir(dirname(configDir), { recursive: true })
    return renameForMigration(legacyDir, configDir)
  }

  if (legacy.empty) {
    await rmdir(legacyDir)
    return { ok: true, migrated: false }
  }
  if (current.empty) {
    await rmdir(configDir)
    return renameForMigration(legacyDir, configDir)
  }

  return {
    ok: false,
    reason: `Agent-messenger config exists in both ${legacyDir} and ${configDir}. Merge them manually, then remove the legacy directory before starting TypeClaw.`,
  }
}

type DirectoryInspection =
  | { exists: false }
  | { exists: true; directory: false; kind: 'symbolic link' | 'non-directory' }
  | { exists: true; directory: true; empty: boolean }

async function inspectDirectory(path: string): Promise<DirectoryInspection> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) return { exists: true, directory: false, kind: 'symbolic link' }
    if (!entry.isDirectory()) return { exists: true, directory: false, kind: 'non-directory' }
    return { exists: true, directory: true, empty: (await readdir(path)).length === 0 }
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { exists: false }
    throw error
  }
}

function invalidDirectoryResult(path: string, kind: 'symbolic link' | 'non-directory'): { ok: false; reason: string } {
  return {
    ok: false,
    reason: `Agent-messenger config path ${path} is a ${kind}; refusing to migrate. Resolve it manually before starting TypeClaw.`,
  }
}

async function renameForMigration(legacyDir: string, configDir: string): Promise<MigrationResult> {
  try {
    await rename(legacyDir, configDir)
    return { ok: true, migrated: true }
  } catch (error) {
    if (isErrorCode(error, 'EXDEV')) {
      return {
        ok: false,
        reason: `Cannot move agent-messenger config from ${legacyDir} to ${configDir} across filesystems. Move it manually before starting TypeClaw; TypeClaw will not copy credential data.`,
      }
    }
    return {
      ok: false,
      reason: `Could not move agent-messenger config from ${legacyDir} to ${configDir}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
