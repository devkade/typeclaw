import { isIP } from 'node:net'

export const MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV = 'TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS'
export const MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV = 'TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_CIDRS'
export const MAX_MODEL_HTTP_POLICY_ENTRIES = 64
const MAX_MODEL_HTTP_POLICY_VALUE_LENGTH = 8192

type ParsedAddress = { readonly family: 4 | 6; readonly value: bigint; readonly bits: 32 | 128 }
type ParsedCidr = ParsedAddress & { readonly prefix: number }

const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const

export type InternalDestinationPolicy = {
  readonly hostnames: readonly string[]
  readonly cidrs: readonly ParsedCidr[]
}

export type InternalDestinationPolicyInput = {
  allowInternalHosts?: readonly string[]
  allowInternalCidrs?: readonly string[]
}

export function createInternalDestinationPolicy(input: InternalDestinationPolicyInput): InternalDestinationPolicy {
  assertBounded(input.allowInternalHosts ?? [], MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV)
  assertBounded(input.allowInternalCidrs ?? [], MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV)
  const hostnames = (input.allowInternalHosts ?? []).map((value, index) => {
    const normalized = normalizeExactHostname(value)
    if (normalized === undefined) throw invalidEntry(MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV, index, value)
    return normalized
  })
  const cidrs = (input.allowInternalCidrs ?? []).map((value, index) => {
    const parsed = parseCidr(value)
    if (parsed === undefined) throw invalidEntry(MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV, index, value)
    return Object.freeze({ ...parsed, value: parsed.value & prefixMask(parsed.bits, parsed.prefix) })
  })
  return Object.freeze({ hostnames: Object.freeze([...new Set(hostnames)]), cidrs: Object.freeze(cidrs) })
}

export function buildInternalDestinationPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): InternalDestinationPolicy {
  return createInternalDestinationPolicy({
    allowInternalHosts: parseEnvList(env[MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV], MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV),
    allowInternalCidrs: parseEnvList(env[MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV], MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV),
  })
}

const BOOT_INTERNAL_DESTINATION_POLICY = buildInternalDestinationPolicyFromEnv(process.env)

export function getBootInternalDestinationPolicy(): InternalDestinationPolicy {
  return BOOT_INTERNAL_DESTINATION_POLICY
}

export function normalizeExactHostname(value: string): string | undefined {
  const candidate = value.trim().replace(/\.$/, '')
  if (candidate === '' || candidate.includes('[') || candidate.includes(']') || /[\s*:/\\@?#]/.test(candidate)) {
    return undefined
  }
  let hostname: string
  try {
    hostname = new URL(`http://${candidate}/`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return undefined
  }
  if (hostname === '' || isIP(hostname) !== 0 || hostname.length > 253) return undefined
  const labels = hostname.split('.')
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-'),
    )
  ) {
    return undefined
  }
  return hostname
}

export function normalizeIpCidr(value: string): string | undefined {
  if (value.includes('%')) return undefined
  const parsed = parseCidr(value)
  if (parsed === undefined) return undefined
  const network = parsed.value & prefixMask(parsed.bits, parsed.prefix)
  return `${formatAddress({ family: parsed.family, bits: parsed.bits, value: network })}/${parsed.prefix}`
}

export function hostnameMatchesPolicy(hostname: string, policy: InternalDestinationPolicy): boolean {
  const normalized = normalizeExactHostname(hostname)
  return normalized !== undefined && policy.hostnames.includes(normalized)
}

export function addressMatchesPolicy(address: string, policy: InternalDestinationPolicy): boolean {
  const parsed = parseAddress(address)
  if (parsed === undefined) return false
  for (const cidr of policy.cidrs) {
    if (matchesCidr(parsed, cidr)) return true
    const embeddedIpv4 = ipv4FromEmbeddedIpv6(parsed)
    if (embeddedIpv4 !== undefined && matchesCidr(embeddedIpv4, cidr)) return true
  }
  return false
}

export function extractEmbeddedIpv4Address(address: string): string | undefined {
  const parsed = parseAddress(address)
  if (parsed === undefined || parsed.family !== 6) return undefined
  const ipv4 = ipv4FromEmbeddedIpv6(parsed)
  return ipv4 === undefined ? undefined : formatAddress(ipv4)
}

export function extractRfc6052Ipv4Addresses(address: string): readonly string[] {
  const parsed = parseAddress(address)
  if (parsed === undefined || parsed.family !== 6 || extractAddressBits(parsed.value, 64, 8) !== 0n) return []
  const candidates = RFC6052_PREFIX_LENGTHS.map((prefix) => {
    if (prefix === 96) return extractAddressBits(parsed.value, 96, 32)
    const leadingIpv4Bits = 64 - prefix
    const trailingIpv4Bits = 32 - leadingIpv4Bits
    return (
      (extractAddressBits(parsed.value, prefix, leadingIpv4Bits) << BigInt(trailingIpv4Bits)) |
      extractAddressBits(parsed.value, 72, trailingIpv4Bits)
    )
  })
  return [...new Set(candidates.map((value) => formatAddress({ family: 4, bits: 32, value })))]
}

function parseEnvList(raw: string | undefined, name: string): string[] {
  if (raw === undefined || raw === '') return []
  if (raw.length > MAX_MODEL_HTTP_POLICY_VALUE_LENGTH) {
    throw new Error(`${name} exceeds the ${MAX_MODEL_HTTP_POLICY_VALUE_LENGTH}-character limit`)
  }
  const entries = raw.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => entry === '')) throw new Error(`${name} contains an empty comma-separated entry`)
  assertBounded(entries, name)
  return entries
}

function assertBounded(entries: readonly string[], name: string): void {
  if (entries.length > MAX_MODEL_HTTP_POLICY_ENTRIES) {
    throw new Error(`${name} contains ${entries.length} entries; maximum is ${MAX_MODEL_HTTP_POLICY_ENTRIES}`)
  }
}

function invalidEntry(name: string, index: number, value: string): Error {
  const expected =
    name === MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV
      ? 'an exact hostname without wildcards, a URL, or an IP literal'
      : 'an IPv4 or IPv6 CIDR with an explicit prefix'
  return new Error(`${name} entry ${index + 1} (${JSON.stringify(value)}) must be ${expected}`)
}

function parseCidr(value: string): ParsedCidr | undefined {
  if (value.includes('%')) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash !== value.lastIndexOf('/')) return undefined
  const address = parseAddress(value.slice(0, slash))
  const prefixText = value.slice(slash + 1)
  if (address === undefined || !/^\d{1,3}$/.test(prefixText)) return undefined
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) return undefined
  return { ...address, prefix }
}

function parseAddress(rawAddress: string): ParsedAddress | undefined {
  const address = rawAddress.toLowerCase().split('%')[0] ?? ''
  const family = isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(Number)
    if (octets.length !== 4) return undefined
    const value = octets.reduce((total, octet) => (total << 8n) | BigInt(octet), 0n)
    return { family: 4, value, bits: 32 }
  }
  if (family !== 6) return undefined
  const hextets = expandIpv6(address)
  if (hextets === undefined) return undefined
  const value = hextets.reduce((total, hextet) => (total << 16n) | BigInt(hextet), 0n)
  return { family: 6, value, bits: 128 }
}

function expandIpv6(address: string): number[] | undefined {
  let normalized = address
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (dottedTail !== undefined) {
    const ipv4 = parseAddress(dottedTail)
    if (ipv4 === undefined || ipv4.family !== 4) return undefined
    const hi = Number((ipv4.value >> 16n) & 0xffffn).toString(16)
    const lo = Number(ipv4.value & 0xffffn).toString(16)
    normalized = `${normalized.slice(0, -dottedTail.length)}${hi}:${lo}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':')
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array(missing).fill(0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ]
}

function prefixMask(bits: 32 | 128, prefix: number): bigint {
  if (prefix === 0) return 0n
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix)
}

function extractAddressBits(value: bigint, start: number, length: number): bigint {
  if (length === 0) return 0n
  return (value >> BigInt(128 - start - length)) & ((1n << BigInt(length)) - 1n)
}

function matchesCidr(address: ParsedAddress, cidr: ParsedCidr): boolean {
  if (address.family !== cidr.family) return false
  const mask = prefixMask(cidr.bits, cidr.prefix)
  return (address.value & mask) === cidr.value
}

function ipv4FromEmbeddedIpv6(address: ParsedAddress): ParsedAddress | undefined {
  if (address.family !== 6) return undefined
  const high96 = address.value >> 32n
  const isMapped = high96 === 0xffffn
  const isTranslated = high96 === 0xffff0000n
  const isCompatible = high96 === 0n && address.value > 1n
  const nat64Prefix = 0x64ff9b0000000000000000n
  const isWellKnownNat64 = high96 === nat64Prefix
  if (isMapped || isTranslated || isCompatible || isWellKnownNat64) {
    return { family: 4, bits: 32, value: address.value & 0xffffffffn }
  }
  const is6to4 = address.value >> 112n === 0x2002n
  if (is6to4) return { family: 4, bits: 32, value: (address.value >> 80n) & 0xffffffffn }
  return undefined
}

function formatAddress(address: ParsedAddress): string {
  if (address.family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => Number((address.value >> shift) & 0xffn)).join('.')
  }
  const hextets = Array.from({ length: 8 }, (_, index) => Number((address.value >> BigInt((7 - index) * 16)) & 0xffffn))
  let bestStart = -1
  let bestLength = 0
  for (let start = 0; start < hextets.length; ) {
    if (hextets[start] !== 0) {
      start++
      continue
    }
    let end = start
    while (end < hextets.length && hextets[end] === 0) end++
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start
      bestLength = end - start
    }
    start = end
  }
  if (bestStart === -1) return hextets.map((part) => part.toString(16)).join(':')
  const left = hextets
    .slice(0, bestStart)
    .map((part) => part.toString(16))
    .join(':')
  const right = hextets
    .slice(bestStart + bestLength)
    .map((part) => part.toString(16))
    .join(':')
  return `${left}::${right}`
}
