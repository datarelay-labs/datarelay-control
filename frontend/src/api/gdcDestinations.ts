import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, GDC_AUTH_REQUIRED_MESSAGE, requestJson, safeRequestJson, safeRequestJsonResult, type GdcJsonResult } from '../api'
import { CATALOG_DESTINATIONS_LIST_KEY, CATALOG_LIST_CACHE_TTL_MS } from './catalogListCache'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache } from './requestCache'

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const DESTINATIONS_LIST_CACHE_NS = 'catalog-destinations'
const DESTINATION_BY_ID_CACHE_NS = 'catalog-destination-by-id'

function invalidateDestinationsCatalogCache(destinationId?: number): void {
  clearSharedRequestCache(DESTINATIONS_LIST_CACHE_NS, CATALOG_DESTINATIONS_LIST_KEY)
  if (destinationId != null) {
    clearSharedRequestCache(DESTINATION_BY_ID_CACHE_NS, String(destinationId))
  }
}

export function invalidateDestinationsListCache(): void {
  clearSharedRequestCache(DESTINATIONS_LIST_CACHE_NS, CATALOG_DESTINATIONS_LIST_KEY)
}

export type DestinationType = 'SYSLOG_UDP' | 'SYSLOG_TCP' | 'SYSLOG_TLS' | 'WEBHOOK_POST'

export type TlsVerifyMode = 'strict' | 'insecure_skip_verify'

export type DestinationRead = {
  id: number
  name: string
  destination_type: DestinationType
  config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
  enabled: boolean
  created_at?: string | null
  updated_at?: string | null
  last_connectivity_test_at?: string | null
  last_connectivity_test_success?: boolean | null
  last_connectivity_test_latency_ms?: number | null
  last_connectivity_test_message?: string | null
}

export type DestinationRouteUsage = {
  route_id: number
  stream_id: number
  stream_name: string
  route_enabled?: boolean
  route_status?: string
}

export type DestinationListItem = DestinationRead & {
  streams_using_count: number
  routes: DestinationRouteUsage[]
}

export type DestinationWritePayload = {
  name: string
  destination_type: DestinationRead['destination_type']
  config_json: Record<string, unknown>
  rate_limit_json?: Record<string, unknown>
  enabled?: boolean
  expected_updated_at?: string
}

export const DESTINATION_STALE_WRITE_CODE = 'DESTINATION_STALE_WRITE'

export function isDestinationStaleWriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes(`[${DESTINATION_STALE_WRITE_CODE}]`) ||
    err.message.includes(DESTINATION_STALE_WRITE_CODE) ||
    /DESTINATION_STALE_WRITE/i.test(err.message)
  )
}

function isDestinationListItem(row: unknown): row is DestinationListItem {
  if (!row || typeof row !== 'object') return false
  const o = row as Record<string, unknown>
  return (
    typeof o.id === 'number' &&
    typeof o.streams_using_count === 'number' &&
    Array.isArray(o.routes)
  )
}

async function fetchDestinationsListResultUncached(signal?: AbortSignal): Promise<GdcJsonResult<DestinationListItem[]>> {
  const result = await safeRequestJsonResult<unknown>(
    `${GDC_API_PREFIX}/destinations/`,
    readJsonWithSignal(readJsonOpts, signal),
  )
  if (result.ok === false) {
    return {
      ok: false,
      status: result.status,
      message: result.authRequired ? GDC_AUTH_REQUIRED_MESSAGE : result.message,
      authRequired: result.authRequired,
    }
  }
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      status: result.status,
      message: 'Destinations API returned an unexpected response. Check authentication and API base URL.',
      authRequired: false,
    }
  }
  const out: DestinationListItem[] = []
  for (const row of result.data) {
    if (isDestinationListItem(row)) {
      out.push(row)
    }
  }
  return { ok: true, data: out, status: result.status }
}

export async function fetchDestinationsListResult(
  options?: GdcSignalOptions,
): Promise<GdcJsonResult<DestinationListItem[]>> {
  return cachedRequest(
    DESTINATIONS_LIST_CACHE_NS,
    CATALOG_DESTINATIONS_LIST_KEY,
    (signal) => fetchDestinationsListResultUncached(signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

/** Returns destination rows, or null on auth/HTTP/parse failure (empty list is `[]`, not null). */
export async function fetchDestinationsList(options?: GdcSignalOptions): Promise<DestinationListItem[] | null> {
  const result = await fetchDestinationsListResult(options)
  return result.ok ? result.data : null
}

async function fetchDestinationByIdUncached(
  destinationId: number,
  signal?: AbortSignal,
): Promise<DestinationRead | null> {
  const raw = await safeRequestJson<unknown>(
    `${GDC_API_PREFIX}/destinations/${destinationId}`,
    readJsonWithSignal(readJsonOpts, signal),
  )
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') return null
  if (!('id' in raw) || typeof (raw as DestinationRead).id !== 'number') return null
  return raw as DestinationRead
}

export async function fetchDestinationById(
  destinationId: number,
  options?: GdcSignalOptions,
): Promise<DestinationRead | null> {
  return cachedRequest(
    DESTINATION_BY_ID_CACHE_NS,
    String(destinationId),
    (signal) => fetchDestinationByIdUncached(destinationId, signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function createDestination(payload: DestinationWritePayload): Promise<DestinationRead> {
  const created = await requestJson<DestinationRead>(`${GDC_API_PREFIX}/destinations/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  invalidateDestinationsCatalogCache(created.id)
  return created
}

export async function updateDestination(
  destinationId: number,
  payload: Partial<DestinationWritePayload> & { expected_updated_at: string },
): Promise<DestinationRead> {
  if (!payload.expected_updated_at) {
    throw new Error('expected_updated_at is required for destination updates')
  }
  const updated = await requestJson<DestinationRead>(`${GDC_API_PREFIX}/destinations/${destinationId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  invalidateDestinationsCatalogCache(destinationId)
  return updated
}

/** Fetch the latest concurrency token then apply a partial destination update. */
export async function updateDestinationWithFreshToken(
  destinationId: number,
  payload: Omit<Partial<DestinationWritePayload>, 'expected_updated_at'>,
): Promise<DestinationRead> {
  const current = await fetchDestinationById(destinationId)
  const token = current?.updated_at
  if (!token) {
    throw new Error('Could not load destination updated_at for optimistic concurrency')
  }
  return updateDestination(destinationId, { ...payload, expected_updated_at: token })
}

export async function deleteDestination(destinationId: number): Promise<void> {
  await requestJson<unknown>(`${GDC_API_PREFIX}/destinations/${destinationId}`, {
    method: 'DELETE',
  })
  invalidateDestinationsCatalogCache(destinationId)
}

export type DestinationTestResult = {
  success: boolean
  latency_ms: number
  message: string
  tested_at: string
  detail?: Record<string, unknown> | null
}

export async function testDestination(destinationId: number): Promise<DestinationTestResult> {
  const result = await requestJson<DestinationTestResult>(`${GDC_API_PREFIX}/destinations/${destinationId}/test`, {
    method: 'POST',
  })
  // Connectivity test persists last_* columns on the destination row.
  invalidateDestinationsCatalogCache(destinationId)
  return result
}

/** Connectivity probe using unsaved form values (does not write destination test columns until saved row test). */
export async function previewTestDestination(payload: DestinationWritePayload & { name: string }): Promise<DestinationTestResult> {
  return requestJson<DestinationTestResult>(`${GDC_API_PREFIX}/destinations/preview-test`, {
    method: 'POST',
    body: JSON.stringify({
      name: payload.name,
      destination_type: payload.destination_type,
      config_json: payload.config_json,
    }),
  })
}
