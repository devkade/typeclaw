import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { enforceAndPinToolFiles } from '@/agent/tool-file-safety'
import { checkPrivateSurfaceReadGuard } from '@/bundled-plugins/security/policies/private-surface-read'
import { defineTool } from '@/plugin/define'
import type { ContentPart, Tool, ToolFileOperands, ToolResult } from '@/plugin/types'
import type { HiddenPaths } from '@/sandbox'

import type { McpConnection, McpToolInfo } from './client'
import type { McpManager } from './manager'
import { namespaceToolName, parseNamespacedTool } from './manager'

export const MCP_DISPATCHER_TOOL_NAMES = ['mcp_list_tools', 'mcp_describe', 'mcp_call'] as const

export type McpListToolsArgs = { server: string }
export type McpDescribeArgs = { server: string; tool: string }
export type McpCallArgs = { server: string; tool: string; args?: Record<string, unknown> }
export type McpDispatcherTool = Tool<McpListToolsArgs> | Tool<McpDescribeArgs> | Tool<McpCallArgs>
export type McpDispatcherTools = [Tool<McpListToolsArgs>, Tool<McpDescribeArgs>, Tool<McpCallArgs>]

export function createMcpDispatcherTools(
  manager: McpManager,
  opts: { resolveHidden: () => HiddenPaths },
): McpDispatcherTools {
  return [createListToolsTool(manager), createDescribeTool(manager), createCallTool(manager, opts)]
}

// `wrapSystemTool` runs the security hooks — including the fail-closed
// private-surface-read scan — against the whole `{ server, tool, args }` envelope
// BEFORE the dispatcher body resolves the target, so without this preflight a
// target-declared free-text operand is scanned as an undeclared path and blocked
// for a restricted role.
//
// EVERY category is surfaced, not just `nonFile`. `nonFile` relaxes the scan, so
// alone it could only ever weaken the guard; the local categories are what let
// the guard scan a declared real-file operand that a prose-named key (`query`,
// `content`, ...) would otherwise exempt. Surfacing one without the other is the
// bypass. This is security metadata only: it is never forwarded to a pinning
// boundary, so pinning still happens exactly once, at the dispatcher's inner-args
// boundary below.
//
// The lookup is cache-only. Connecting here would spawn an MCP server before the
// security hooks have run; a cold catalog yields undefined, which keeps the
// existing fail-closed scan.
export function resolveMcpCallPreflightFileOperands(
  manager: McpManager,
  args: Record<string, unknown>,
): ToolFileOperands | undefined {
  if (typeof args.server !== 'string' || typeof args.tool !== 'string') return undefined
  const resolved = resolveToolArgs(args.server, args.tool)
  const declared = manager.getConnection(resolved.server)?.peekTools()
  const fileOperands = declared?.find((item) => item.name === resolved.tool)?.fileOperands
  if (fileOperands === undefined) return undefined
  const rebased: Record<string, readonly string[]> = {}
  for (const [category, paths] of Object.entries(fileOperands)) {
    if (paths === undefined || paths.length === 0) continue
    rebased[category] = paths.map((operandPath) => `args.${operandPath}`)
  }
  return Object.keys(rebased).length === 0 ? undefined : (rebased as ToolFileOperands)
}

function createListToolsTool(manager: McpManager): Tool<McpListToolsArgs> {
  return defineTool<McpListToolsArgs>({
    description: 'List the tools exposed by one connected MCP server. Returns namespaced tool ids and descriptions.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
    }),
    async execute(args) {
      const connection = await manager.ensureConnected(args.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, args.server))

      const tools = await safeListTools(connection)
      if (tools.length === 0) return textResult(`MCP server ${JSON.stringify(args.server)} exposes no tools.`)

      const lines = tools.map((tool) => {
        const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
        return `- ${namespaceToolName(args.server, tool.name)} — ${description}`
      })
      return textResult(`Tools for MCP server ${JSON.stringify(args.server)}:\n${lines.join('\n')}`)
    },
  })
}

function createDescribeTool(manager: McpManager): Tool<McpDescribeArgs> {
  return defineTool<McpDescribeArgs>({
    description: 'Describe one MCP tool. Returns its description and full input JSON Schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
    }),
    async execute(args) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = await manager.ensureConnected(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      const tools = await safeListTools(connection)
      const tool = tools.find((item) => item.name === resolved.tool)
      if (tool === undefined) {
        const available = tools.map((item) => namespaceToolName(resolved.server, item.name)).join(', ')
        return textResult(
          `Unknown MCP tool ${JSON.stringify(resolved.tool)} on server ${JSON.stringify(resolved.server)}. Available tools: ${available || 'none'}.`,
        )
      }

      const description = tool.description.trim() === '' ? 'no description' : tool.description.trim()
      return textResult(
        [
          `MCP tool ${namespaceToolName(resolved.server, tool.name)}`,
          `Description: ${description}`,
          '',
          'Input schema:',
          '```json',
          JSON.stringify(tool.inputSchema, null, 2),
          '```',
        ].join('\n'),
      )
    },
  })
}

function createCallTool(manager: McpManager, opts: { resolveHidden: () => HiddenPaths }): Tool<McpCallArgs> {
  return defineTool<McpCallArgs>({
    description: 'Call an MCP tool on a connected server. Use mcp_describe first to learn the input schema.',
    parameters: z.object({
      server: z.string().describe('The MCP server name from the system prompt catalog.'),
      tool: z.string().describe('The bare tool name or namespaced server__tool id.'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments matching the tool input schema.'),
    }),
    async execute(args, ctx) {
      const resolved = resolveToolArgs(args.server, args.tool)
      const connection = await manager.ensureConnected(resolved.server)
      if (connection === undefined) return textResult(unknownServerMessage(manager, resolved.server))

      const toolArgs = args.args ?? {}
      const targetFileOperands = await declaredFileOperands(connection, resolved.tool)
      // Scoped to targets that actually declare operands. The cold-catalog gap
      // this closes requires a declaration by definition: without one the outer
      // envelope guard already scanned these values under the same role, and the
      // generic fail-closed scan below stays the authority on undeclared ones —
      // including its more precise "ambiguous local file operand" rejection.
      if (targetFileOperands !== undefined) {
        const blocked = checkPrivateSurfaceReadGuard({
          tool: 'mcp_call',
          args: toolArgs,
          agentDir: ctx.agentDir,
          hidden: opts.resolveHidden(),
          fileOperands: targetFileOperands,
        })
        if (blocked !== undefined) throw new Error(`blocked: ${blocked.reason}`)
      }
      const pinned = await enforceAndPinToolFiles({
        tool: 'mcp_call',
        args: toolArgs,
        agentDir: ctx.agentDir,
        genericInputs: true,
        ...(targetFileOperands === undefined ? {} : { fileOperands: targetFileOperands }),
        logger: ctx.logger,
        signal: ctx.signal,
      })
      try {
        const result = await safeCallTool(connection, resolved.tool, toolArgs)
        return pinned.restoreResult(mapCallToolResult(resolved.server, resolved.tool, result))
      } finally {
        await pinned.cleanup()
      }
    },
  })
}

function resolveToolArgs(server: string, tool: string): { server: string; tool: string } {
  const parsed = parseNamespacedTool(tool)
  return parsed ?? { server, tool }
}

function unknownServerMessage(manager: McpManager, server: string): string {
  // List every configured server, not just connected ones: under lazy connect a
  // valid server is reached only when ensureConnected returns undefined for a
  // name that isn't configured at all, so filtering by `connected` here would
  // report "none" while servers exist.
  const available = manager
    .listServers()
    .map((entry) => entry.name)
    .join(', ')
  return `Unknown MCP server ${JSON.stringify(server)}. Available servers: ${available || 'none'}.`
}

// Operand paths here are relative to the target's own schema, matching the inner
// `args.args` scan; a catalog failure degrades to the fail-closed generic scan
// rather than aborting, and safeCallTool surfaces the real transport error.
async function declaredFileOperands(connection: McpConnection, tool: string): Promise<ToolFileOperands | undefined> {
  try {
    return (await connection.listTools()).find((item) => item.name === tool)?.fileOperands
  } catch {
    return undefined
  }
}

async function safeListTools(connection: McpConnection): Promise<McpToolInfo[]> {
  try {
    return await connection.listTools()
  } catch (cause) {
    throw new Error(`MCP list tools failed: ${sanitizeMcpError(errorMessage(cause))}`)
  }
}

async function safeCallTool(
  connection: McpConnection,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return await connection.callTool(tool, args)
  } catch (cause) {
    throw new Error(`MCP call failed: ${sanitizeMcpError(errorMessage(cause))}`)
  }
}

function mapCallToolResult(server: string, tool: string, result: CallToolResult): ToolResult {
  const content = result.content.map(mapMcpContentPart)
  if (result.isError === true) {
    return {
      content: content.map((part) =>
        part.type === 'text' ? { type: 'text' as const, text: `MCP tool error: ${sanitizeMcpError(part.text)}` } : part,
      ),
      details: { server, tool, isError: true },
    }
  }
  return { content, details: { server, tool, isError: false } }
}

function mapMcpContentPart(part: CallToolResult['content'][number]): ContentPart {
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
  if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
    return { type: 'image', mimeType: part.mimeType, data: part.data }
  }
  return { type: 'text', text: summarizeUnsupportedPart(part) }
}

function summarizeUnsupportedPart(part: CallToolResult['content'][number]): string {
  const type = typeof part.type === 'string' ? part.type : 'unknown'
  const uri = readNestedString(part, 'resource', 'uri') ?? readString(part, 'uri')
  if (uri !== undefined) return `[mcp:${type} ${uri}]`
  const mimeType = readNestedString(part, 'resource', 'mimeType') ?? readString(part, 'mimeType')
  if (mimeType !== undefined) return `[mcp:${type} ${mimeType}]`
  return `[mcp:${type} omitted]`
}

export function sanitizeMcpError(raw: string): string {
  const scrubbed = raw
    .replace(/\b([A-Z_][A-Z0-9_]*)=\S+/g, '$1=<redacted>')
    .replace(/(?:\/[\w.-]+)+/g, '<path>')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '<path>')
  return scrubbed.length <= 500 ? scrubbed : `${scrubbed.slice(0, 497)}...`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

function readNestedString(value: unknown, key: string, nestedKey: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return readString((value as Record<string, unknown>)[key], nestedKey)
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
