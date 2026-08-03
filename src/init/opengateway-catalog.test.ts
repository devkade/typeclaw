import { describe, expect, test } from 'bun:test'

import { fetchOpenGatewayCatalog } from './opengateway-catalog'

const CATALOG_URL = 'https://apis.opengateway.ai/v1/models'
const PRICES_URL = 'https://opengateway.ai/api/model-prices'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fixtureFetch(fixtures: { catalog: Response | Error; prices: Response | Error }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const fixture = url === CATALOG_URL ? fixtures.catalog : url === PRICES_URL ? fixtures.prices : undefined
    if (fixture === undefined) throw new Error(`unexpected URL: ${url}`)
    if (fixture instanceof Error) throw fixture
    return fixture
  }) as unknown as typeof fetch
}

function catalogEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: 'model',
    owned_by: id.split('/')[0],
    status: 'active',
    modalities: { input: ['text', 'image'], output: ['text'] },
    endpoints: ['chat_completions'],
    ...overrides,
  }
}

describe('fetchOpenGatewayCatalog', () => {
  test('keeps only active text-output chat-completions models', async () => {
    const catalog = {
      object: 'list',
      data: [
        catalogEntry('openai/active'),
        catalogEntry('openai/deprecated', { status: 'deprecated' }),
        catalogEntry('openai/retired', { status: 'retired' }),
        catalogEntry('openai/responses-only', { endpoints: ['responses'] }),
        catalogEntry('openai/images-only', {
          modalities: { input: ['text'], output: ['image'] },
          endpoints: ['images_generations'],
        }),
      ],
    }

    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({ catalog: jsonResponse(catalog), prices: jsonResponse({}) }),
    })

    expect(result.models.map((model) => model.id)).toEqual(['openai/active'])
    expect(result.models[0]?.input).toEqual(['text', 'image'])
    expect(result.catalog).toBe('live')
  })

  test('converts exact-id price matches from per-token to per-million-token units', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({
        catalog: jsonResponse({ data: [catalogEntry('anthropic/claude-test')] }),
        prices: jsonResponse({
          'anthropic/claude-test': {
            inputCostPerToken: 0.000002,
            outputCostPerToken: 0.00001,
            cacheReadInputTokenCost: 0.0000002,
            cacheCreationInputTokenCost: 0.0000025,
          },
        }),
      }),
    })

    expect(result.models[0]?.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
    expect(result.prices).toBe('live')
  })

  test('uses null cost when a catalog model has no exact price match', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({
        catalog: jsonResponse({ data: [catalogEntry('openai/unpriced')] }),
        prices: jsonResponse({}),
      }),
    })

    expect(result.models[0]?.cost).toBeNull()
  })

  test('never invents a model that exists only in the price table', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({
        catalog: jsonResponse({ data: [catalogEntry('openai/catalog-model')] }),
        prices: jsonResponse({
          'openai/price-only': { inputCostPerToken: 1, outputCostPerToken: 1 },
        }),
      }),
    })

    expect(result.models.map((model) => model.id)).toEqual(['openai/catalog-model'])
  })

  test('degrades malformed JSON without throwing', async () => {
    const malformed = new Response('{', { status: 200 })
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({ catalog: malformed, prices: jsonResponse([]) }),
    })

    expect(result).toMatchObject({ models: [], catalog: 'unavailable', prices: 'unavailable' })
    expect(result.warnings).toHaveLength(2)
  })

  test('reports live prices when the catalog fails', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({ catalog: new Error('catalog down'), prices: jsonResponse({}) }),
    })

    expect(result).toMatchObject({ models: [], catalog: 'unavailable', prices: 'live' })
    expect(result.warnings.join(' ')).toContain('catalog down')
  })

  test('still returns catalog models with null cost when prices fail', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({
        catalog: jsonResponse({ data: [catalogEntry('openai/available')] }),
        prices: new Error('prices down'),
      }),
    })

    expect(result.models).toHaveLength(1)
    expect(result.models[0]?.cost).toBeNull()
    expect(result).toMatchObject({ catalog: 'live', prices: 'unavailable' })
  })

  test('reports both sources unavailable when both requests fail', async () => {
    const result = await fetchOpenGatewayCatalog({
      fetchImpl: fixtureFetch({ catalog: new Error('catalog down'), prices: new Error('prices down') }),
    })

    expect(result).toMatchObject({ models: [], catalog: 'unavailable', prices: 'unavailable' })
    expect(result.warnings).toHaveLength(2)
  })
})
