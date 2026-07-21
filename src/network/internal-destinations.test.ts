import { describe, expect, test } from 'bun:test'

import {
  addressMatchesPolicy,
  buildInternalDestinationPolicyFromEnv,
  createInternalDestinationPolicy,
  extractEmbeddedIpv4Address,
  extractRfc6052Ipv4Addresses,
  getBootInternalDestinationPolicy,
  hostnameMatchesPolicy,
  MAX_MODEL_HTTP_POLICY_ENTRIES,
  MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV,
  MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV,
  normalizeExactHostname,
  normalizeIpCidr,
} from './internal-destinations'

describe('internal destination exceptions', () => {
  test('normalizes exact IDNA hostnames without accepting wildcard or suffix patterns', () => {
    expect(normalizeExactHostname('카메라.HOME.')).toBe('xn--oi2by7cuz0a.home')
    expect(normalizeExactHostname('*.home')).toBeUndefined()
    expect(normalizeExactHostname('.home')).toBeUndefined()
    expect(normalizeExactHostname('reports.corp\\ignored')).toBeUndefined()
    expect(normalizeExactHostname('reports.corp%5Cignored')).toBeUndefined()
    expect(
      hostnameMatchesPolicy(
        '카메라.home.',
        createInternalDestinationPolicy({
          allowInternalHosts: ['xn--oi2by7cuz0a.home'],
          allowInternalCidrs: [],
        }),
      ),
    ).toBe(true)
  })

  test('normalizes IPv4 and IPv6 CIDRs to their network address', () => {
    expect(normalizeIpCidr('10.20.255.9/16')).toBe('10.20.0.0/16')
    expect(normalizeIpCidr('FD12:3456:789A::9/48')).toBe('fd12:3456:789a::/48')
  })

  test('rejects scoped IPv6 CIDRs and addresses without explicit prefixes', () => {
    expect(normalizeIpCidr('fe80::1%eth0/64')).toBeUndefined()
    expect(normalizeIpCidr('10.20.1.7')).toBeUndefined()
    expect(normalizeIpCidr('fd12:3456::9')).toBeUndefined()
  })

  test('matches IPv4 and IPv6 boundaries and maps IPv4-mapped IPv6 into IPv4 CIDRs', () => {
    const policy = createInternalDestinationPolicy({
      allowInternalHosts: [],
      allowInternalCidrs: ['10.20.0.0/16', 'fd12:3456::/48'],
    })
    expect(addressMatchesPolicy('10.20.255.255', policy)).toBe(true)
    expect(addressMatchesPolicy('10.21.0.0', policy)).toBe(false)
    expect(addressMatchesPolicy('fd12:3456::ffff', policy)).toBe(true)
    expect(addressMatchesPolicy('fd12:3457::1', policy)).toBe(false)
    expect(addressMatchesPolicy('::ffff:10.20.1.7', policy)).toBe(true)
  })

  test.each([
    ['::ffff:0:169.254.169.254', '169.254.169.254'],
    ['2002:a9fe:a9fe::', '169.254.169.254'],
    ['::ffff:0:168.63.129.16', '168.63.129.16'],
    ['2002:a83f:8110::', '168.63.129.16'],
  ])('extracts standardized IPv4 translation form %s', (address, expected) => {
    expect(extractEmbeddedIpv4Address(address)).toBe(expected)
  })

  test.each([
    ['fd00:0:a9fe:a9fe::', '169.254.169.254'],
    ['fd00:0:a9:fea9:fe::', '169.254.169.254'],
    ['fd00:0:0:a9fe:a9:fe00::', '169.254.169.254'],
    ['fd00:0:0:a9:fe:a9fe::', '169.254.169.254'],
    ['fd00:0:0:0:a9:fea9:fe00:0', '169.254.169.254'],
    ['fd00::a9fe:a9fe', '169.254.169.254'],
  ])('extracts RFC 6052 network-specific layout %s', (address, expected) => {
    expect(extractRfc6052Ipv4Addresses(address)).toContain(expected)
  })

  test('requires the RFC 6052 reserved u octet to be zero', () => {
    expect(extractRfc6052Ipv4Addresses('fd00:0:a9fe:a9fe:100::')).toEqual([])
  })

  test.each(['64:ff9b:1::a9fe:a9fe', '64:ff9b:1:a9fe:0:a9fe::'])(
    'does not assume an IPv4 field location within RFC8215 local-use address %s',
    (address) => {
      expect(extractEmbeddedIpv4Address(address)).toBeUndefined()
    },
  )

  test('does not interpret arbitrary global IPv6 low bits as embedded IPv4', () => {
    expect(extractEmbeddedIpv4Address('2001:db8::a9fe:a9fe')).toBeUndefined()
  })

  test('parses strict comma-separated boot env values once with normalization', () => {
    const policy = buildInternalDestinationPolicyFromEnv({
      [MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]: 'SERVICE.CORP., 카메라.home',
      [MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV]: '10.20.255.9/16, FD12:3456:789A::9/48',
    })
    expect(policy.hostnames).toEqual(['service.corp', 'xn--oi2by7cuz0a.home'])
    expect(addressMatchesPolicy('10.20.1.7', policy)).toBe(true)
    expect(addressMatchesPolicy('fd12:3456:789a::20', policy)).toBe(true)
  })

  test('rejects invalid, empty, and over-bound env lists', () => {
    expect(() => buildInternalDestinationPolicyFromEnv({ [MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]: '*.corp' })).toThrow(
      MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV,
    )
    expect(() =>
      buildInternalDestinationPolicyFromEnv({ [MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]: 'reports.corp\\ignored' }),
    ).toThrow(MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV)
    expect(() =>
      buildInternalDestinationPolicyFromEnv({ [MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV]: '10.0.0.0/8,' }),
    ).toThrow(/empty comma-separated entry/)
    expect(() =>
      buildInternalDestinationPolicyFromEnv({
        [MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]: Array.from(
          { length: MAX_MODEL_HTTP_POLICY_ENTRIES + 1 },
          (_, index) => `service-${index}.corp`,
        ).join(','),
      }),
    ).toThrow(/maximum/)
  })

  test('deeply freezes parsed CIDR authorization records', () => {
    const policy = createInternalDestinationPolicy({ allowInternalCidrs: ['10.20.0.0/16'] })
    const cidr = policy.cidrs[0]
    if (cidr === undefined) throw new Error('expected parsed CIDR')
    expect(Object.isFrozen(cidr)).toBe(true)
    expect(Reflect.set(cidr, 'prefix', 0)).toBe(false)
    expect(policy.cidrs[0]?.prefix).toBe(16)
    expect(addressMatchesPolicy('10.21.0.1', policy)).toBe(false)
  })

  test('boot policy identity and values do not change when process.env changes after import', () => {
    const bootPolicy = getBootInternalDestinationPolicy()
    const previous = process.env[MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]
    process.env[MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV] = 'changed-after-boot.corp'
    try {
      expect(getBootInternalDestinationPolicy()).toBe(bootPolicy)
      expect(getBootInternalDestinationPolicy().hostnames).toEqual(bootPolicy.hostnames)
    } finally {
      if (previous === undefined) delete process.env[MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]
      else process.env[MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV] = previous
    }
  })

  test('web_fetch and look_at use the boot policy for initial URLs and redirects', async () => {
    const source = `
      import { fetchWithLimits } from './src/agent/tools/webfetch/fetch.ts'
      import { resolveImagesBounded } from './src/agent/multimodal/looker.ts'
      const connected = []
      const network = {
        resolveAddresses: async (hostname) => hostname.endsWith('.corp') || hostname.endsWith('.home')
          ? [{ address: '10.20.1.7', family: 4 }]
          : [{ address: 'fd12:3456::9', family: 6 }],
        request: async (options) => {
          const address = await new Promise((resolve, reject) => options.lookup(options.hostname, {}, (error, value, family) => {
            if (error) reject(error)
            else resolve({ address: Array.isArray(value) ? value[0].address : value, family })
          }))
          connected.push(address.address)
          const redirect = options.hostname.endsWith('.corp') || options.hostname.endsWith('.home')
          return {
            statusCode: redirect ? 302 : 200,
            headers: redirect
              ? { location: options.hostname.endsWith('.corp') ? 'https://report.example/final' : 'https://image.example/final.png' }
              : { 'content-type': options.path.endsWith('.png') ? 'image/png' : 'text/plain' },
            body: { async *[Symbol.asyncIterator]() { if (!redirect) yield new Uint8Array([1]) } },
            cancel() {},
          }
        },
      }
      await fetchWithLimits('https://reports.corp/start', 5, undefined, 'off', network)
      await resolveImagesBounded([{ kind: 'url', url: 'https://camera.home/start.png' }], undefined, network)
      process.stdout.write(JSON.stringify(connected))
    `
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [MODEL_HTTP_ALLOW_INTERNAL_HOSTS_ENV]: 'reports.corp,camera.home',
        [MODEL_HTTP_ALLOW_INTERNAL_CIDRS_ENV]: '10.20.0.0/16,fd12:3456::/48',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual(['10.20.1.7', 'fd12:3456::9', '10.20.1.7', 'fd12:3456::9'])
  })
})
