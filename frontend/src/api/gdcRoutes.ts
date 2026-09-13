import { requestJson, safeRequestJson } from '../api'
import {
  canUseOperationalFixture,
  loadOperationalSnapshotFixture,
  routeReadsFromOperationalSnapshot,
} from '../lib/runtime-operational-fixture-mode'
import { CATALOG_LIST_CACHE_TTL_MS, CATALOG_ROUTES_LIST_KEY } from './catalogListCache'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { invalidateStreamMappingUiConfigCache } from './gdcRuntime'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache } from './requestCache'

const ROUTES_LIST_CACHE_NS = 'catalog-routes'
const ROUTE_BY_ID_CACHE_NS = 'catalog-route-by-id'

function invalidateRoutesCatalogCache(routeId?: number): void {
  clearSharedRequestCache(ROUTES_LIST_CACHE_NS, CATALOG_ROUTES_LIST_KEY)
  if (routeId != null) {
    clearSharedRequestCache(ROUTE_BY_ID_CACHE_NS, String(routeId))
  }
}

export type RouteRead = {
  id: number
  name?: string | null
  stream_id?: number | null
  destination_id?: number | null
  status?: string | null
  enabled?: boolean | null
  disable_reason?: string | null
  description?: string | null
  failure_policy?: string | null
  formatter_config_json?: Record<string, unknown> | null
  rate_limit_json?: Record<string, unknown> | null
  /** Server-managed optimistic-concurrency token (ISO timestamp). */
  updated_at?: string | null
  created_at?: string | null
}

export type RouteWritePayload = {
  name?: string | null
  stream_id?: number | null
  destination_id?: number | null
  status?: string | null
  enabled?: boolean | null
  description?: string | null
  failure_policy?: string | null
  formatter_config_json?: Record<string, unknown> | null
  rate_limit_json?: Record<string, unknown> | null
  /** Required on PUT — last known Route.updated_at from GET/save. */
  expected_updated_at?: string
}

export const ROUTE_STALE_WRITE_CODE = 'ROUTE_STALE_WRITE'

export function isRouteStaleWriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes(`[${ROUTE_STALE_WRITE_CODE}]`) ||
    err.message.includes(ROUTE_STALE_WRITE_CODE) ||
    /ROUTE_STALE_WRITE/i.test(err.message)
  )
}

async function fetchRouteByIdUncached(routeId: number, signal?: AbortSignal): Promise<RouteRead | null> {
  const raw = await safeRequestJson<unknown>(
    `${GDC_API_PREFIX}/routes/${routeId}`,
    readJsonWithSignal({}, signal),
  )
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') return null
  if (!('id' in raw) || typeof (raw as RouteRead).id !== 'number') return null
  return raw as RouteRead
}

export async function fetchRouteById(routeId: number, options?: GdcSignalOptions): Promise<RouteRead | null> {
  return cachedRequest(
    ROUTE_BY_ID_CACHE_NS,
    String(routeId),
    (signal) => fetchRouteByIdUncached(routeId, signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

/** Bypass catalog TTL so concurrency tokens and conflict refresh see the latest server row. */
export async function fetchRouteByIdFresh(routeId: number, options?: GdcSignalOptions): Promise<RouteRead | null> {
  clearSharedRequestCache(ROUTE_BY_ID_CACHE_NS, String(routeId))
  return fetchRouteById(routeId, options)
}

export async function createRoute(payload: RouteWritePayload): Promise<RouteRead> {
  const created = await requestJson<RouteRead>(`${GDC_API_PREFIX}/routes/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  invalidateRoutesCatalogCache(created.id)
  if (typeof payload.stream_id === 'number' && Number.isFinite(payload.stream_id)) {
    invalidateStreamMappingUiConfigCache(payload.stream_id)
  }
  return created
}

async function fetchRoutesListUncached(signal?: AbortSignal): Promise<RouteRead[] | null> {
  if (await canUseOperationalFixture()) {
    const snapshot = await loadOperationalSnapshotFixture()
    if (snapshot != null) return routeReadsFromOperationalSnapshot(snapshot)
  }
  const raw = await safeRequestJson<unknown>(`${GDC_API_PREFIX}/routes/`, readJsonWithSignal({}, signal))
  if (!Array.isArray(raw)) return null
  const out: RouteRead[] = []
  for (const row of raw) {
    if (row && typeof row === 'object' && 'id' in row && typeof (row as RouteRead).id === 'number') {
      out.push(row as RouteRead)
    }
  }
  return out.length ? out : null
}

export async function fetchRoutesList(options?: GdcSignalOptions): Promise<RouteRead[] | null> {
  return cachedRequest(
    ROUTES_LIST_CACHE_NS,
    CATALOG_ROUTES_LIST_KEY,
    (signal) => fetchRoutesListUncached(signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function updateRoute(routeId: number, payload: RouteWritePayload): Promise<RouteRead> {
  if (!payload.expected_updated_at) {
    throw new Error('expected_updated_at is required for route updates')
  }
  const updated = await requestJson<RouteRead>(`${GDC_API_PREFIX}/routes/${routeId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  invalidateRoutesCatalogCache(routeId)
  if (typeof payload.stream_id === 'number' && Number.isFinite(payload.stream_id)) {
    invalidateStreamMappingUiConfigCache(payload.stream_id)
  }
  return updated
}

/**
 * Fetch a fresh concurrency token then PUT. Used by surfaces that do not already
 * hold the Route.updated_at baseline from the route editor dirty-tracking path.
 */
export async function updateRouteWithFreshToken(
  routeId: number,
  payload: Omit<RouteWritePayload, 'expected_updated_at'>,
): Promise<RouteRead> {
  const current = await fetchRouteByIdFresh(routeId)
  const token = current?.updated_at
  if (typeof token !== 'string' || !token) {
    throw new Error('Route concurrency token unavailable')
  }
  return updateRoute(routeId, { ...payload, expected_updated_at: token })
}

export type DeleteRouteOptions = {
  streamId?: number
}

export async function deleteRoute(routeId: number, options?: DeleteRouteOptions): Promise<void> {
  await requestJson<unknown>(`${GDC_API_PREFIX}/routes/${routeId}`, {
    method: 'DELETE',
  })
  invalidateRoutesCatalogCache(routeId)
  if (options?.streamId != null && Number.isFinite(options.streamId)) {
    invalidateStreamMappingUiConfigCache(options.streamId)
  }
}
