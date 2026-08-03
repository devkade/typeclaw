import type { Reloadable, ReloadContext, ReloadResult } from '@/reload'

import { describeError } from './describe-error'
import type { ChannelManager, ChannelReloadOptions } from './manager'
import { ADAPTER_IDS, type AdapterId } from './schema'

export type CreateChannelsReloadableOptions = {
  manager: Pick<ChannelManager, 'reload'>
}

export function createChannelsReloadable({ manager }: CreateChannelsReloadableOptions): Reloadable {
  return {
    scope: 'channels',
    description: 'channels adapters and live config',
    reload: async (context?: ReloadContext): Promise<ReloadResult> => {
      try {
        const diff = await manager.reload(toReloadOptions(context))
        const parts: string[] = []
        if (diff.started.length > 0) parts.push(`${diff.started.length} started`)
        if (diff.stopped.length > 0) parts.push(`${diff.stopped.length} stopped`)
        if (diff.restarted.length > 0) parts.push(`${diff.restarted.length} restarted`)
        if (diff.restartRequired.length > 0) parts.push(`${diff.restartRequired.length} restart-required`)
        const summary = parts.length === 0 ? 'no adapter changes' : parts.join(', ')
        return { scope: 'channels', ok: true, summary, details: diff }
      } catch (err) {
        const message = describeError(err)
        return { scope: 'channels', ok: false, reason: message }
      }
    },
  }
}

// The cause arrives off the wire, so the adapter name is an unvalidated string.
// Dropping an unrecognized one keeps reload non-destructive by default: the
// worst case is a rotation reported instead of applied, never a bounce of an
// adapter the caller did not name.
function toReloadOptions(context: ReloadContext | undefined): ChannelReloadOptions {
  const cause = context?.cause
  if (cause?.kind !== 'credential-rotation') return {}
  return isAdapterId(cause.adapter) ? { applyCredentialRotation: cause.adapter } : {}
}

function isAdapterId(value: string): value is AdapterId {
  return (ADAPTER_IDS as readonly string[]).includes(value)
}
