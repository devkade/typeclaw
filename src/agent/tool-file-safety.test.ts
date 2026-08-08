import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { enforceCanonicalSecretDenial } from './tool-file-safety'

test('enforceCanonicalSecretDenial ignores non-file declarations for canonical credentials', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-denial-'))
  const options = {
    tool: 'mcp_call',
    args: { pattern: 'secrets.json' },
    agentDir,
    fileOperands: { nonFile: ['pattern'] },
  }

  try {
    expect(() => enforceCanonicalSecretDenial(options)).toThrow(/^blocked:/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
