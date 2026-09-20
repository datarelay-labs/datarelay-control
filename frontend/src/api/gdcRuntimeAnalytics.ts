import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest } from './requestCache'
import type {
  DestinationDeliveryOutcomesResponse,
  RetrySummaryResponse,
  RouteFailuresAnalyticsResponse,
  RouteFailuresScopedResponse,
  StreamRetriesAnalyticsResponse,
} from './types/gdcApi'

const BASE = `${GDC_API_PREFIX}/runtime/analytics`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const ANALYTICS_READ_CACHE_TTL_MS = 15_000

export type AnalyticsWindowToken = '15m' | '1h' | '6h' | '24h'

export type AnalyticsQueryParams = {
  window?: AnalyticsWindowToken
  since?: string
  stream_id?: number
  route_id?: number
  destination_id?: number
  snapshot_id?: string
}

function buildSearchParams(p: AnalyticsQueryParams): URLSearchParams {
  const q = new URLSearchParams()
  if (p.window != null) q.set('window', p.window)
  if (p.since != null && p.since.trim() !== '') q.set('since', p.since.trim())
  if (p.stream_id != null && Number.isFinite(p.stream_id)) q.set('stream_id', String(p.stream_id))
  if (p.route_id != null && Number.isFinite(p.route_id)) q.set('route_id', String(p.route_id))
  if (p.destination_id != null && Number.isFinite(p.destination_id)) {
    q.set('destination_id', String(p.destination_id))
  }
  if (p.snapshot_id != null && p.snapshot_id.trim() !== '') q.set('snapshot_id', p.snapshot_id.trim())
  return q
}

export async function fetchRouteFailuresAnalytics(
  params: AnalyticsQueryParams,
): Promise<RouteFailuresAnalyticsResponse | null> {
  const q = buildSearchParams(params)
  return safeRequestJson<RouteFailuresAnalyticsResponse>(`${BASE}/routes/failures?${q.toString()}`, readJsonOpts)
}

export async function fetchRouteFailuresForRoute(
  routeId: number,
  params: Omit<AnalyticsQueryParams, 'route_id'>,
): Promise<RouteFailuresScopedResponse | null> {
  const q = buildSearchParams(params)
  return safeRequestJson<RouteFailuresScopedResponse>(`${BASE}/routes/${routeId}/failures?${q.toString()}`, readJsonOpts)
}

export function fetchDeliveryOutcomesByDestination(
  params: Pick<AnalyticsQueryParams, 'window' | 'since' | 'snapshot_id'>,
): Promise<DestinationDeliveryOutcomesResponse | null> {
  const q = buildSearchParams(params)
  const key = `delivery-outcomes-destinations:${q.toString()}`
  return cachedRequest(
    'runtime-analytics',
    key,
    () => safeRequestJson<DestinationDeliveryOutcomesResponse>(`${BASE}/delivery-outcomes/destinations?${q.toString()}`, readJsonOpts),
    { ttlMs: ANALYTICS_READ_CACHE_TTL_MS },
  )
}

export async function fetchStreamRetriesAnalytics(
  params: AnalyticsQueryParams & { limit?: number },
): Promise<StreamRetriesAnalyticsResponse | null> {
  const q = buildSearchParams(params)
  if (params.limit != null && Number.isFinite(params.limit)) {
    q.set('limit', String(params.limit))
  }
  return safeRequestJson<StreamRetriesAnalyticsResponse>(`${BASE}/streams/retries?${q.toString()}`, readJsonOpts)
}

export async function fetchRetriesSummary(
  params: AnalyticsQueryParams,
  options?: GdcSignalOptions,
): Promise<RetrySummaryResponse | null> {
  const q = buildSearchParams(params)
  return safeRequestJson<RetrySummaryResponse>(
    `${BASE}/retries/summary?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}
