import { describe, expect, test } from 'bun:test'

import { createInternalDestinationPolicy } from '@/network/internal-destinations'

import { GUARD_SSRF, allowsInternalDestination, checkSsrfGuard, classifyIpAddress, classifyUrl } from './ssrf'

const TRANSLATED_CONTROL_PLANE_ADDRESSES = [
  '::ffff:0:169.254.169.254',
  '2002:a9fe:a9fe::',
  '::ffff:0:168.63.129.16',
  '2002:a83f:8110::',
  '2002:6464:64c8::',
]

const RFC8215_LOCAL_USE_ADDRESSES = [
  '64:ff9b:1::a9fe:a9fe',
  '64:ff9b:1:a9fe:0:a9fe::',
  '64:ff9b:1::808:808',
  '64:ff9b:1:808:0:808::',
  '64:ff9b:1:dead:beef:cafe:babe:1234',
]

const RFC6052_NETWORK_SPECIFIC_METADATA_ADDRESSES = [
  'fd00:0:a9fe:a9fe::',
  'fd00:0:a9:fea9:fe::',
  'fd00:0:0:a9fe:a9:fe00::',
  'fd00:0:0:a9:fe:a9fe::',
  'fd00:0:0:0:a9:fea9:fe00:0',
  'fd00::a9fe:a9fe',
]

describe('SSRF classifier', () => {
  test('blocks AWS IMDS metadata endpoint', () => {
    expect(classifyUrl('http://169.254.169.254/latest/meta-data/iam/').blocked).toBe(true)
    expect(classifyUrl('http://169.254.169.254/').category).toBe('cloud_metadata')
  })

  test('blocks GCP metadata endpoint by hostname', () => {
    expect(classifyUrl('http://metadata.google.internal/computeMetadata/v1/').blocked).toBe(true)
    expect(classifyUrl('http://metadata.google.internal./computeMetadata/v1/').category).toBe('cloud_metadata')
  })

  test('keeps IPv6 and IPv4-mapped metadata endpoints unconditionally blocked', () => {
    const policy = createInternalDestinationPolicy({
      allowInternalHosts: ['metadata.google.internal'],
      allowInternalCidrs: ['::/0'],
    })
    expect(classifyUrl('http://[fd00:ec2::254]/latest/meta-data/', policy).category).toBe('cloud_metadata')
    expect(classifyUrl('http://[::ffff:169.254.169.254]/latest/meta-data/', policy).category).toBe('cloud_metadata')
  })

  test.each(['168.63.129.16', '::ffff:168.63.129.16', '::168.63.129.16', '64:ff9b::a83f:8110'])(
    'blocks Azure WireServer and its mapped/NAT64 form %s',
    (address) => {
      expect(classifyIpAddress(address).category).toBe('cloud_metadata')
      const policy = createInternalDestinationPolicy({ allowInternalCidrs: ['0.0.0.0/0', '::/0'] })
      const host = address.includes(':') ? `[${address}]` : address
      expect(classifyUrl(`http://${host}/`, policy).category).toBe('cloud_metadata')
    },
  )

  test.each(TRANSLATED_CONTROL_PLANE_ADDRESSES)(
    'keeps standardized translated metadata/control-plane address %s below the allowlist floor',
    (address) => {
      const policy = createInternalDestinationPolicy({ allowInternalCidrs: ['::/0', '0.0.0.0/0'] })
      expect(classifyIpAddress(address).category).toBe('cloud_metadata')
      expect(classifyUrl(`http://[${address}]/`, policy).category).toBe('cloud_metadata')
      expect(allowsInternalDestination('public.example', address, policy)).toBe(false)
    },
  )

  test.each(RFC6052_NETWORK_SPECIFIC_METADATA_ADDRESSES)(
    'keeps RFC 6052 network-specific metadata address %s below the internal exception floor',
    (address) => {
      const policy = createInternalDestinationPolicy({ allowInternalCidrs: ['fd00::/8'] })
      expect(classifyIpAddress(address).category).toBe('cloud_metadata')
      expect(classifyUrl(`http://[${address}]/latest/meta-data/`, policy).category).toBe('cloud_metadata')
      expect(allowsInternalDestination(address, address, policy)).toBe(false)
    },
  )

  test.each(RFC8215_LOCAL_USE_ADDRESSES)(
    'keeps RFC8215 local-use translation address %s below hostname and CIDR allowlists',
    (address) => {
      const policy = createInternalDestinationPolicy({
        allowInternalHosts: ['public.example'],
        allowInternalCidrs: ['::/0', '0.0.0.0/0'],
      })
      expect(classifyIpAddress(address).category).toBe('cloud_metadata')
      expect(classifyUrl(`http://[${address}]/`, policy).category).toBe('cloud_metadata')
      expect(allowsInternalDestination('public.example', address, policy)).toBe(false)
    },
  )

  test('bounds the RFC8215 floor to 64:ff9b:1::/48', () => {
    expect(classifyIpAddress('64:ff9b:0:ffff:ffff:ffff:ffff:ffff')).toEqual({ blocked: false })
    expect(classifyIpAddress('64:ff9b:2::')).toEqual({ blocked: false })
  })

  test('does not classify arbitrary global IPv6 by private-looking low bits', () => {
    expect(classifyIpAddress('2001:db8::a9fe:a9fe')).toEqual({ blocked: false })
  })

  test('blocks IPv4 loopback', () => {
    expect(classifyUrl('http://127.0.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://127.0.0.1:8080/admin').blocked).toBe(true)
    expect(classifyUrl('http://127.99.99.99/').blocked).toBe(true)
  })

  test('blocks localhost hostname', () => {
    expect(classifyUrl('http://localhost/').blocked).toBe(true)
    expect(classifyUrl('https://LOCALHOST:3000/').blocked).toBe(true)
  })

  test('blocks RFC1918 private IPv4', () => {
    expect(classifyUrl('http://10.0.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://10.255.255.255/').blocked).toBe(true)
    expect(classifyUrl('http://172.16.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://172.31.255.1/').blocked).toBe(true)
    expect(classifyUrl('http://192.168.1.1/').blocked).toBe(true)
  })

  test('does not block 172.32.x.y (outside RFC1918)', () => {
    expect(classifyUrl('http://172.32.0.1/').blocked).toBe(false)
  })

  test('does not block 11.x.x.x (outside RFC1918)', () => {
    expect(classifyUrl('http://11.0.0.1/').blocked).toBe(false)
  })

  test('blocks 0.0.0.0', () => {
    expect(classifyUrl('http://0.0.0.0/').blocked).toBe(true)
  })

  test('blocks CGNAT 100.64.x.x', () => {
    expect(classifyUrl('http://100.64.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://100.127.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://100.63.0.1/').blocked).toBe(false)
    expect(classifyUrl('http://100.128.0.1/').blocked).toBe(false)
  })

  test('blocks the full 198.18.0.0/15 benchmarking range', () => {
    expect(classifyUrl('http://198.18.0.1/').blocked).toBe(true)
    expect(classifyUrl('http://198.19.42.7/internal').blocked).toBe(true)
    expect(classifyUrl('http://198.19.255.255/').blocked).toBe(true)
    expect(classifyUrl('http://198.17.255.255/').blocked).toBe(false)
    expect(classifyUrl('http://198.20.0.0/').blocked).toBe(false)
  })

  test('blocks decimal-encoded loopback (127.0.0.1 = 2130706433)', () => {
    expect(classifyUrl('http://2130706433/').blocked).toBe(true)
  })

  test('blocks hex-encoded loopback', () => {
    expect(classifyUrl('http://0x7f000001/').blocked).toBe(true)
  })

  test('blocks IPv6 loopback', () => {
    expect(classifyUrl('http://[::1]/').blocked).toBe(true)
  })

  test('blocks IPv6 link-local', () => {
    expect(classifyUrl('http://[fe80::1]/').blocked).toBe(true)
  })

  test('blocks IPv6 unique-local', () => {
    expect(classifyUrl('http://[fd12:3456:789a::1]/').blocked).toBe(true)
    expect(classifyUrl('http://[fc00::1]/').blocked).toBe(true)
  })

  test('blocks IPv4-mapped IPv6 loopback', () => {
    expect(classifyUrl('http://[::ffff:127.0.0.1]/').blocked).toBe(true)
  })

  test.each([
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0::ffff:7f00:1',
    '0000:0000:0000:0000:0000:ffff:7f00:0001',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
  ])('blocks semantically equivalent IPv4-mapped IPv6 loopback %s', (address) => {
    expect(classifyIpAddress(address)).toEqual({
      blocked: true,
      category: 'loopback',
      reason: 'IPv4-embedded IPv6: IPv4 loopback (127.0.0.1)',
    })
  })

  test('allows an IPv4-mapped public address', () => {
    expect(classifyIpAddress('0:0:0:0:0:ffff:808:808')).toEqual({ blocked: false })
  })

  test('blocks .internal / .local / .corp / .home suffixes', () => {
    expect(classifyUrl('http://service.internal/').blocked).toBe(true)
    expect(classifyUrl('http://printer.local/').blocked).toBe(true)
    expect(classifyUrl('http://admin.corp/').blocked).toBe(true)
    expect(classifyUrl('http://nas.home/').blocked).toBe(true)
  })

  test('blocks file:// and other dangerous schemes', () => {
    expect(classifyUrl('file:///etc/passwd').blocked).toBe(true)
    expect(classifyUrl('gopher://127.0.0.1:25/').blocked).toBe(true)
    expect(classifyUrl('ftp://internal/').blocked).toBe(true)
    expect(classifyUrl('dict://127.0.0.1:11211/').blocked).toBe(true)
  })

  test('allows public URLs', () => {
    expect(classifyUrl('https://example.com/').blocked).toBe(false)
    expect(classifyUrl('https://api.github.com/').blocked).toBe(false)
    expect(classifyUrl('https://news.ycombinator.com/').blocked).toBe(false)
    expect(classifyUrl('http://1.1.1.1/').blocked).toBe(false)
    expect(classifyUrl('http://8.8.8.8/').blocked).toBe(false)
  })

  test('does not block bogus / unparseable URL (left to web_fetch tool to reject)', () => {
    expect(classifyUrl('not-a-url').blocked).toBe(false)
  })
})

describe('checkSsrfGuard', () => {
  test('blocks SSRF on web_fetch', () => {
    const result = checkSsrfGuard({ tool: 'web_fetch', args: { url: 'http://169.254.169.254/' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('cloud_metadata')
  })

  test('allows public URL', () => {
    expect(checkSsrfGuard({ tool: 'web_fetch', args: { url: 'https://example.com/' } })).toBeUndefined()
  })

  test('does not let model-authored acknowledgement bypass SSRF', () => {
    const result = checkSsrfGuard({
      tool: 'web_fetch',
      args: { url: 'http://127.0.0.1:3000/dev', acknowledgeGuards: { ssrf: true } },
    })
    expect(result?.block).toBe(true)
  })

  test('allows an exact operator-configured internal hostname', () => {
    expect(
      checkSsrfGuard({
        tool: 'web_fetch',
        args: { url: 'http://서비스.corp/status' },
        internalDestinationPolicy: createInternalDestinationPolicy({
          allowInternalHosts: ['xn--9w3b15cw7a.corp'],
          allowInternalCidrs: [],
        }),
      }),
    ).toBeUndefined()
  })

  test('never allows cloud metadata through hostname or CIDR exceptions', () => {
    const internalDestinationPolicy = createInternalDestinationPolicy({
      allowInternalHosts: ['metadata.google.internal'],
      allowInternalCidrs: ['0.0.0.0/0', '::/0'],
    })
    expect(
      checkSsrfGuard({
        tool: 'web_fetch',
        args: { url: 'http://metadata.google.internal/computeMetadata/v1/' },
        internalDestinationPolicy,
      })?.block,
    ).toBe(true)
    expect(
      checkSsrfGuard({
        tool: 'web_fetch',
        args: { url: 'http://169.254.169.254/latest/meta-data/' },
        internalDestinationPolicy,
      })?.block,
    ).toBe(true)
  })

  test('does not apply to non-web_fetch tools', () => {
    expect(checkSsrfGuard({ tool: 'bash', args: { url: 'http://127.0.0.1/' } })).toBeUndefined()
  })

  test('handles non-string url gracefully', () => {
    expect(checkSsrfGuard({ tool: 'web_fetch', args: { url: 42 } })).toBeUndefined()
    expect(checkSsrfGuard({ tool: 'web_fetch', args: {} })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SSRF).toBe('ssrf')
  })
})
