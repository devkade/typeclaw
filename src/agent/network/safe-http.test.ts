import { describe, expect, test } from 'bun:test'
import type { LookupAddress } from 'node:dns'

import { createInternalDestinationPolicy } from '@/network/internal-destinations'

import { createPublicSocketLookup } from './safe-http'

const TRANSLATED_CONTROL_PLANE_ADDRESSES = [
  '::ffff:0:169.254.169.254',
  '2002:a9fe:a9fe::',
  '64:ff9b:1::a9fe:a9fe',
  '64:ff9b:1:a9fe:0:a9fe::',
  '64:ff9b:1::808:808',
  '64:ff9b:1:808:0:808::',
  '::ffff:0:168.63.129.16',
  '2002:a83f:8110::',
  '64:ff9b:1::a83f:8110',
  '2002:6464:64c8::',
  'fd00:0:a9fe:a9fe::',
  'fd00:0:a9:fea9:fe::',
  'fd00:0:0:a9fe:a9:fe00::',
  'fd00:0:0:a9:fe:a9fe::',
  'fd00:0:0:0:a9:fea9:fe00:0',
  'fd00::a9fe:a9fe',
]

describe('createPublicSocketLookup translated-address floor', () => {
  test.each(TRANSLATED_CONTROL_PLANE_ADDRESSES)(
    'rejects DNS answer %s before a broad allowlist can apply',
    async (address) => {
      const lookup = createPublicSocketLookup(
        async () => [{ address, family: 6 }],
        createInternalDestinationPolicy({ allowInternalCidrs: ['::/0', '0.0.0.0/0'] }),
      )
      await expect(socketAddress(lookup)).rejects.toThrow(/metadata|non-public|control-plane/i)
    },
  )

  test('does not reject an arbitrary global IPv6 answer because its low bits resemble metadata IPv4', async () => {
    const lookup = createPublicSocketLookup(
      async () => [{ address: '2001:db8::a9fe:a9fe', family: 6 }],
      createInternalDestinationPolicy({}),
    )
    await expect(socketAddress(lookup)).resolves.toEqual({ address: '2001:db8::a9fe:a9fe', family: 6 })
  })
})

async function socketAddress(
  lookup: ReturnType<typeof createPublicSocketLookup>,
): Promise<{ address: string; family: number }> {
  return await new Promise((resolve, reject) => {
    lookup('public.example', {}, (error, address, family) => {
      if (error !== null) return reject(error)
      if (Array.isArray(address)) {
        const first = address[0] as LookupAddress | undefined
        if (first === undefined) return reject(new Error('no address'))
        resolve(first)
        return
      }
      resolve({ address, family: family ?? 0 })
    })
  })
}
