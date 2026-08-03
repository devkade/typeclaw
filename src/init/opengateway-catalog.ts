import type { ModelOptionCost } from './models-dev'

const CATALOG_URL = 'https://apis.opengateway.ai/v1/models'
const PRICES_URL = 'https://opengateway.ai/api/model-prices'
const REQUEST_TIMEOUT_MS = 10_000
const PER_MILLION = 1_000_000

export type OpenGatewayModel = {
  id: string
  ownedBy: string
  input: string[]
  cost: ModelOptionCost | null
}

export type OpenGatewayCatalogResult = {
  models: OpenGatewayModel[]
  catalog: 'live' | 'unavailable'
  prices: 'live' | 'unavailable'
  warnings: string[]
}

type SourceResult<T> = { status: 'live'; value: T } | { status: 'unavailable'; warning: string }

export async function fetchOpenGatewayCatalog(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenGatewayCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const [catalogResult, pricesResult] = await Promise.all([
    fetchCatalog(fetchImpl, timeoutMs),
    fetchPrices(fetchImpl, timeoutMs),
  ])
  const warnings = [
    ...(catalogResult.status === 'unavailable' ? [catalogResult.warning] : []),
    ...(pricesResult.status === 'unavailable' ? [pricesResult.warning] : []),
  ]
  const prices = pricesResult.status === 'live' ? pricesResult.value : {}
  const models =
    catalogResult.status === 'live'
      ? catalogResult.value.map((model) => ({ ...model, cost: costForModel(prices[model.id]) }))
      : []

  return {
    models,
    catalog: catalogResult.status,
    prices: pricesResult.status,
    warnings,
  }
}

async function fetchCatalog(fetchImpl: typeof fetch, timeoutMs: number): Promise<SourceResult<OpenGatewayModel[]>> {
  try {
    const response = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return unavailable('catalog', `returned ${response.status}`)
    const value: unknown = await response.json()
    if (!isRecord(value) || !Array.isArray(value.data)) return unavailable('catalog', 'returned malformed JSON')
    return { status: 'live', value: value.data.flatMap(parseCatalogModel) }
  } catch (error) {
    return unavailable('catalog', reasonFrom(error))
  }
}

async function fetchPrices(fetchImpl: typeof fetch, timeoutMs: number): Promise<SourceResult<Record<string, unknown>>> {
  try {
    const response = await fetchImpl(PRICES_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return unavailable('prices', `returned ${response.status}`)
    const value: unknown = await response.json()
    if (!isRecord(value)) return unavailable('prices', 'returned malformed JSON')
    return { status: 'live', value }
  } catch (error) {
    return unavailable('prices', reasonFrom(error))
  }
}

function parseCatalogModel(value: unknown): OpenGatewayModel[] {
  if (!isRecord(value)) return []
  if (typeof value.id !== 'string' || value.id.length === 0) return []
  if (typeof value.owned_by !== 'string' || value.owned_by.length === 0) return []
  if (value.status !== 'active') return []
  if (!isRecord(value.modalities) || !stringArray(value.modalities.output).includes('text')) return []
  if (!stringArray(value.endpoints).includes('chat_completions')) return []
  const input = stringArray(value.modalities.input).filter((modality) => modality === 'text' || modality === 'image')
  return [{ id: value.id, ownedBy: value.owned_by, input, cost: null }]
}

function costForModel(value: unknown): ModelOptionCost | null {
  if (!isRecord(value)) return null
  const input = requiredRate(value.inputCostPerToken)
  const output = requiredRate(value.outputCostPerToken)
  const cacheRead = optionalRate(value.cacheReadInputTokenCost)
  const cacheWrite = optionalRate(value.cacheCreationInputTokenCost)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  return { input, output, cacheRead, cacheWrite }
}

function requiredRate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Number((value * PER_MILLION).toPrecision(15))
}

function optionalRate(value: unknown): number | null {
  if (value === null || value === undefined) return 0
  return requiredRate(value)
}

function unavailable<T>(source: 'catalog' | 'prices', reason: string): SourceResult<T> {
  return { status: 'unavailable', warning: `OpenGateway ${source} ${reason}` }
}

function reasonFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
