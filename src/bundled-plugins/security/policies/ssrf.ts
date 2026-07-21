import { isIP } from 'node:net'

import {
  addressMatchesPolicy,
  extractEmbeddedIpv4Address,
  extractRfc6052Ipv4Addresses,
  getBootInternalDestinationPolicy,
  hostnameMatchesPolicy,
  type InternalDestinationPolicy,
} from '@/network/internal-destinations'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'

export const GUARD_SSRF = 'ssrf'
// Classified `medium` (silent-attack axis): bypass lets `curl
// http://169.254.169.254/...` return cloud-metadata IAM credentials into
// model context. Silent — no channel side effect at the moment of fetch.
// Catastrophic on follow-up because the model now has live cloud creds.
export const GUARD_SSRF_SEVERITY: SecuritySeverity = 'medium'

const ALWAYS_BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

const CLOUD_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata',
  'metadata.aws.internal',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
])

const ALWAYS_BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.lan', '.intranet', '.corp', '.home']

export type SsrfClassification = {
  blocked: boolean
  category?:
    | 'loopback'
    | 'private_ipv4'
    | 'link_local'
    | 'cloud_metadata'
    | 'ipv6_internal'
    | 'unspecified'
    | 'shared_cgnat'
    | 'reserved_internal_host'
    | 'unsupported_scheme'
  reason?: string
}

export function classifyUrl(rawUrl: string, internalDestinationPolicy?: InternalDestinationPolicy): SsrfClassification {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { blocked: false }
  }

  if (
    parsed.protocol === 'file:' ||
    parsed.protocol === 'gopher:' ||
    parsed.protocol === 'ftp:' ||
    parsed.protocol === 'data:' ||
    parsed.protocol === 'jar:' ||
    parsed.protocol === 'php:' ||
    parsed.protocol === 'dict:'
  ) {
    return {
      blocked: true,
      category: 'unsupported_scheme',
      reason: `${parsed.protocol} URL is not allowed for outbound fetch`,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: false }
  }

  const host = parsed.hostname.toLowerCase()
  const decoded = decodeBracketedIpv6(host).replace(/\.$/, '')

  if (isCloudMetadataHostname(decoded)) {
    return {
      blocked: true,
      category: 'cloud_metadata',
      reason: `cloud metadata hostname "${decoded}" is never allowed`,
    }
  }

  if (ALWAYS_BLOCKED_HOSTS.has(decoded)) {
    const classification: SsrfClassification = {
      blocked: true,
      category: 'reserved_internal_host',
      reason: `host "${decoded}" resolves to internal/loopback infrastructure`,
    }
    return internalDestinationPolicy !== undefined &&
      allowsInternalDestination(decoded, undefined, internalDestinationPolicy)
      ? { blocked: false }
      : classification
  }
  for (const suffix of ALWAYS_BLOCKED_HOST_SUFFIXES) {
    if (decoded.endsWith(suffix)) {
      const classification: SsrfClassification = {
        blocked: true,
        category: 'reserved_internal_host',
        reason: `host suffix "${suffix}" is reserved for internal networks`,
      }
      return internalDestinationPolicy !== undefined &&
        allowsInternalDestination(decoded, undefined, internalDestinationPolicy)
        ? { blocked: false }
        : classification
    }
  }

  const addressClassification = classifyIpAddress(decoded)
  if (addressClassification.blocked) {
    return internalDestinationPolicy !== undefined &&
      allowsInternalDestination(decoded, decoded, internalDestinationPolicy)
      ? { blocked: false }
      : addressClassification
  }

  return { blocked: false }
}

export function classifyIpAddress(address: string): SsrfClassification {
  const decoded = decodeBracketedIpv6(address.toLowerCase().split('%')[0] ?? '')
  const ipv4 = parseIpv4Loose(decoded)
  if (ipv4) {
    const cls = classifyIpv4(ipv4)
    if (cls) return { blocked: true, category: cls.category, reason: cls.reason }
    return { blocked: false }
  }
  const normalizedIpv6 = normalizeIpv6(decoded)
  if (normalizedIpv6 !== undefined) {
    const cls = classifyIpv6(normalizedIpv6)
    if (cls) return { blocked: true, category: cls.category, reason: cls.reason }
  }
  return { blocked: false }
}

export function allowsInternalDestination(
  hostname: string,
  address: string | undefined,
  policy: InternalDestinationPolicy,
): boolean {
  const normalizedHostname = decodeBracketedIpv6(hostname.toLowerCase()).replace(/\.$/, '')
  if (isCloudMetadataHostname(normalizedHostname)) return false
  if (address !== undefined && isCloudMetadataAddress(address)) return false
  return (
    hostnameMatchesPolicy(normalizedHostname, policy) ||
    (address !== undefined && addressMatchesPolicy(address, policy))
  )
}

function normalizeIpv6(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined
  try {
    return decodeBracketedIpv6(new URL(`http://[${address}]/`).hostname).toLowerCase()
  } catch {
    return undefined
  }
}

export function checkSsrfGuard(options: {
  tool: string
  args: Record<string, unknown>
  internalDestinationPolicy?: InternalDestinationPolicy
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'web_fetch') return undefined
  const url = args.url
  if (typeof url !== 'string') return undefined

  const result = classifyUrl(url, options.internalDestinationPolicy ?? getBootInternalDestinationPolicy())
  if (!result.blocked) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_SSRF}\` blocked web_fetch to a non-public destination (${result.category ?? 'unknown'}): ${result.reason ?? 'classified as internal'}.`,
      'This protects against SSRF, cloud metadata exfiltration, and accidental fetches against internal services.',
      'Intentional internal destinations must be configured by the operator through the boot-only model HTTP environment policy; model-authored acknowledgements cannot bypass this guard.',
    ].join(' '),
  }
}

function decodeBracketedIpv6(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

function parseIpv4Loose(host: string): [number, number, number, number] | undefined {
  const dotted = host.match(/^(\d{1,10})\.(\d{1,10})\.(\d{1,10})\.(\d{1,10})$/)
  if (dotted && dotted[1] && dotted[2] && dotted[3] && dotted[4]) {
    const parts = [dotted[1], dotted[2], dotted[3], dotted[4]].map((s) => parseInt(s, 10))
    if (parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return parts as [number, number, number, number]
    }
  }
  const decimal = host.match(/^(\d{6,12})$/)
  if (decimal && decimal[1]) {
    const n = Number(decimal[1])
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
  }
  const hex = host.match(/^0x([0-9a-f]{1,8})$/i)
  if (hex && hex[1]) {
    const n = parseInt(hex[1], 16)
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
  }
  return undefined
}

function classifyIpv4(
  ip: [number, number, number, number],
): { category: SsrfClassification['category']; reason: string } | undefined {
  const [a, b] = ip
  if (isCloudMetadataIpv4(ip))
    return { category: 'cloud_metadata', reason: `cloud metadata endpoint (${ip.join('.')})` }
  if (a === 127) return { category: 'loopback', reason: `IPv4 loopback (${ip.join('.')})` }
  if (a === 10) return { category: 'private_ipv4', reason: `private RFC1918 10.0.0.0/8 (${ip.join('.')})` }
  if (a === 172 && b >= 16 && b <= 31)
    return { category: 'private_ipv4', reason: `private RFC1918 172.16.0.0/12 (${ip.join('.')})` }
  if (a === 192 && b === 168)
    return { category: 'private_ipv4', reason: `private RFC1918 192.168.0.0/16 (${ip.join('.')})` }
  if (a === 169 && b === 254)
    return { category: 'link_local', reason: `IPv4 link-local 169.254.0.0/16 (${ip.join('.')})` }
  if (a === 100 && b >= 64 && b <= 127)
    return { category: 'shared_cgnat', reason: `CGNAT 100.64.0.0/10 (${ip.join('.')})` }
  if (a === 198 && (b === 18 || b === 19))
    return { category: 'private_ipv4', reason: `benchmarking-only 198.18.0.0/15 (${ip.join('.')})` }
  if (a === 0) return { category: 'unspecified', reason: `unspecified 0.0.0.0/8 (${ip.join('.')})` }
  if (a >= 224) return { category: 'private_ipv4', reason: `multicast/reserved (${ip.join('.')})` }
  return undefined
}

function classifyIpv6(host: string): { category: SsrfClassification['category']; reason: string } | undefined {
  const lower = host.toLowerCase()
  if (lower === 'fd00:ec2::254' || lower === 'fd20:ce::254') {
    return { category: 'cloud_metadata', reason: `cloud IPv6 metadata endpoint (${lower})` }
  }
  if (lower.startsWith('64:ff9b:1:')) {
    return {
      category: 'cloud_metadata',
      reason: `RFC8215 local-use translation prefix has no safely inferable IPv4 field (${lower})`,
    }
  }
  const internalClassification = classifyInternalIpv6(lower)
  if (internalClassification !== undefined) {
    const translatedMetadata = extractRfc6052Ipv4Addresses(lower).find((candidate) => {
      const ipv4 = parseIpv4Loose(candidate)
      return ipv4 !== undefined && isCloudMetadataIpv4(ipv4)
    })
    if (translatedMetadata !== undefined) {
      return {
        category: 'cloud_metadata',
        reason: `RFC6052 network-specific translation of cloud metadata endpoint (${translatedMetadata})`,
      }
    }
    return internalClassification
  }
  const embeddedIpv4 = extractEmbeddedIpv4Address(lower)
  if (embeddedIpv4 !== undefined) {
    const parsed = parseIpv4Loose(embeddedIpv4)
    const cls = parsed === undefined ? undefined : classifyIpv4(parsed)
    if (cls) return { category: cls.category, reason: `IPv4-embedded IPv6: ${cls.reason}` }
  }
  return undefined
}

function classifyInternalIpv6(lower: string): { category: SsrfClassification['category']; reason: string } | undefined {
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return { category: 'loopback', reason: 'IPv6 loopback ::1' }
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return { category: 'unspecified', reason: 'IPv6 unspecified ::' }
  const firstHextet = Number.parseInt(lower.split(':')[0] ?? '', 16)
  if (Number.isFinite(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
    return { category: 'link_local', reason: 'IPv6 link-local fe80::/10' }
  if (Number.isFinite(firstHextet) && firstHextet >= 0xfec0 && firstHextet <= 0xfeff)
    return { category: 'ipv6_internal', reason: 'IPv6 site-local fec0::/10' }
  if (lower.startsWith('fc') || lower.startsWith('fd'))
    return { category: 'ipv6_internal', reason: 'IPv6 unique-local fc00::/7' }
  if (lower.startsWith('ff')) return { category: 'ipv6_internal', reason: 'IPv6 multicast ff00::/8' }
  return undefined
}

function isCloudMetadataHostname(hostname: string): boolean {
  return CLOUD_METADATA_HOSTS.has(hostname) || hostname.endsWith('.metadata.google.internal')
}

function isCloudMetadataAddress(address: string): boolean {
  return classifyIpAddress(address).category === 'cloud_metadata'
}

function isCloudMetadataIpv4(ip: [number, number, number, number]): boolean {
  const value = ip.join('.')
  return (
    value === '169.254.169.254' ||
    value === '169.254.170.2' ||
    value === '169.254.170.23' ||
    value === '169.254.0.23' ||
    value === '169.254.0.24' ||
    value === '100.100.100.200' ||
    value === '192.0.0.192' ||
    value === '168.63.129.16'
  )
}
