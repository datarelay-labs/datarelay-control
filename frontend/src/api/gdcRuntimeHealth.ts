import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCacheByKeyPrefix } from './requestCache'
import type {
  DestinationHealthListResponse,
  HealthOverviewResponse,
  RouteHealthDetailResponse,
  RouteHealthListResponse,
  StreamHealthDetailResponse,
  StreamHealthListResponse,
} from './types/gdcApi'

const BASE = `${GDC_API_PREFIX}/runtime/health`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const HEALTH_READ_CACHE_TTL_MS = 15_000

export type HealthWindowToken = '15m' | '1h' | '6h' | '24h' | '7d' | '30d'

export type HealthScoringMode = 'current_runtime' | 'historical_analytics'

export type HealthQueryParams = {
  window?: HealthWindowToken
  since?: string
  stream_id?: number
  route_id?: number
  destination_id?: number
  /** Default API value is current_runtime (live posture). */
  scoring_mode?: HealthScoringMode
  snapshot_id?: string
}

function buildSearchParams(p: HealthQueryParams): URLSearchParams {
  const q = new URLSearchParams()
  if (p.window != null) q.set('window', p.window)
  if (p.since != null && p.since.trim() !== '') q.set('since', p.since.trim())
  if (p.stream_id != null && Number.isFinite(p.stream_id)) q.set('stream_id', String(p.stream_id))
  if (p.route_id != null && Number.isFinite(p.route_id)) q.set('route_id', String(p.route_id))
  if (p.destination_id != null && Number.isFinite(p.destination_id)) {
    q.set('destination_id', String(p.destination_id))
  }
  if (p.scoring_mode != null) q.set('scoring_mode', p.scoring_mode)
  if (p.snapshot_id != null && p.snapshot_id.trim() !== '') q.set('snapshot_id', p.snapshot_id.trim())
  return q
}

export async function fetchHealthOverview(
  params: HealthQueryParams & { worst_limit?: number },
  options?: GdcSignalOptions,
): Promise<HealthOverviewResponse | null> {
  const q = buildSearchParams(params)
  if (params.worst_limit != null && Number.isFinite(params.worst_limit)) {
    q.set('worst_limit', String(params.worst_limit))
  }
  return safeRequestJson<HealthOverviewResponse>(
    `${BASE}/overview?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function fetchStreamHealthList(
  params: HealthQueryParams,
): Promise<StreamHealthListResponse | null> {
  const q = buildSearchParams(params)
  return safeRequestJson<StreamHealthListResponse>(`${BASE}/streams?${q.toString()}`, readJsonOpts)
}

export function fetchRouteHealthList(
  params: HealthQueryParams,
): Promise<RouteHealthListResponse | null> {
  const q = buildSearchParams(params)
  const key = `routes:${q.toString()}`
  return cachedRequest(
    'runtime-health',
    key,
    () => safeRequestJson<RouteHealthListResponse>(`${BASE}/routes?${q.toString()}`, readJsonOpts),
    { ttlMs: HEALTH_READ_CACHE_TTL_MS },
  )
}

/** Clears destination health list entries only (does not wipe route/stream health keys). */
export function clearDestinationHealthCache(): void {
  clearSharedRequestCacheByKeyPrefix('runtime-health', 'destinations:')
}

export function fetchDestinationHealthList(
  params: HealthQueryParams,
): Promise<DestinationHealthListResponse | null> {
  const q = buildSearchParams(params)
  const key = `destinations:${q.toString()}`
  return cachedRequest(
    'runtime-health',
    key,
    () => safeRequestJson<DestinationHealthListResponse>(`${BASE}/destinations?${q.toString()}`, readJsonOpts),
    { ttlMs: HEALTH_READ_CACHE_TTL_MS },
  )
}

export async function fetchStreamHealthDetail(
  streamId: number,
  params: Omit<HealthQueryParams, 'stream_id'>,
): Promise<StreamHealthDetailResponse | null> {
  const q = buildSearchParams(params)
  return safeRequestJson<StreamHealthDetailResponse>(`${BASE}/streams/${streamId}?${q.toString()}`, readJsonOpts)
}

export function fetchRouteHealthDetail(
  routeId: number,
  params: Omit<HealthQueryParams, 'route_id'>,
): Promise<RouteHealthDetailResponse | null> {
  const q = buildSearchParams(params)
  const key = `route-detail:${routeId}:${q.toString()}`
  return cachedRequest(
    'runtime-health',
    key,
    () => safeRequestJson<RouteHealthDetailResponse>(`${BASE}/routes/${routeId}?${q.toString()}`, readJsonOpts),
    { ttlMs: HEALTH_READ_CACHE_TTL_MS },
  )
}
