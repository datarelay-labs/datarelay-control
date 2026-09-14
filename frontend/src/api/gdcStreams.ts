import {
  GDC_DEFAULT_READ_JSON_TIMEOUT_MS,
  GDC_AUTH_REQUIRED_MESSAGE,
  requestJson,
  safeRequestJson,
  safeRequestJsonResult,
  type GdcJsonResult,
} from '../api'
import { CATALOG_LIST_CACHE_TTL_MS, CATALOG_STREAMS_LIST_KEY } from './catalogListCache'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache } from './requestCache'
import type { StreamRead } from './types/gdcApi'

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const STREAMS_LIST_CACHE_NS = 'catalog-streams'
const STREAM_BY_ID_CACHE_NS = 'catalog-stream-by-id'

function invalidateStreamCatalogCache(streamId?: number): void {
  clearSharedRequestCache(STREAMS_LIST_CACHE_NS, CATALOG_STREAMS_LIST_KEY)
  if (streamId != null) {
    clearSharedRequestCache(STREAM_BY_ID_CACHE_NS, String(streamId))
  }
}

/** Legacy placeholder shape from `app/streams/router` before DB-backed list. */
export function isStreamsPlaceholderResponse(body: unknown): boolean {
  if (body === null || typeof body !== 'object') return true
  if (Array.isArray(body)) return false
  const o = body as Record<string, unknown>
  return typeof o.message === 'string' && !Array.isArray(o) && !('id' in o)
}

export { GDC_AUTH_REQUIRED_MESSAGE }

function parseStreamsListPayload(raw: unknown): StreamRead[] | null {
  if (raw === null) return null
  if (isStreamsPlaceholderResponse(raw)) return null
  if (!Array.isArray(raw)) return null
  const out: StreamRead[] = []
  for (const row of raw) {
    if (row && typeof row === 'object' && 'id' in row && typeof (row as StreamRead).id === 'number') {
      out.push(row as StreamRead)
    }
  }
  return out
}

async function fetchStreamsListResultUncached(signal?: AbortSignal): Promise<GdcJsonResult<StreamRead[]>> {
  const result = await safeRequestJsonResult<unknown>(
    `${GDC_API_PREFIX}/streams/`,
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
  const parsed = parseStreamsListPayload(result.data)
  if (parsed === null) {
    return {
      ok: false,
      status: result.status,
      message: 'Streams API returned an unexpected response. Check authentication and API base URL.',
      authRequired: false,
    }
  }
  return { ok: true, data: parsed, status: result.status }
}

export async function fetchStreamsListResult(options?: GdcSignalOptions): Promise<GdcJsonResult<StreamRead[]>> {
  return cachedRequest(
    STREAMS_LIST_CACHE_NS,
    CATALOG_STREAMS_LIST_KEY,
    (signal) => fetchStreamsListResultUncached(signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

/** Returns stream rows, or null on auth/HTTP/parse failure (empty list is `[]`, not null). */
export async function fetchStreamsList(options?: GdcSignalOptions): Promise<StreamRead[] | null> {
  const result = await fetchStreamsListResult(options)
  return result.ok ? result.data : null
}

export type StreamWritePayload = {
  name?: string | null
  connector_id?: number | null
  source_id?: number | null
  stream_type?: string | null
  config_json?: Record<string, unknown> | null
  polling_interval?: number | null
  enabled?: boolean | null
  rate_limit_json?: Record<string, unknown> | null
  expected_updated_at?: string
}

export const STREAM_STALE_WRITE_CODE = 'STREAM_STALE_WRITE'

export function isStreamStaleWriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes(`[${STREAM_STALE_WRITE_CODE}]`) ||
    err.message.includes(STREAM_STALE_WRITE_CODE) ||
    /STREAM_STALE_WRITE/i.test(err.message)
  )
}

async function fetchStreamByIdUncached(streamId: number, signal?: AbortSignal): Promise<StreamRead | null> {
  const raw = await safeRequestJson<unknown>(
    `${GDC_API_PREFIX}/streams/${streamId}`,
    readJsonWithSignal(readJsonOpts, signal),
  )
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') return null
  if (!('id' in raw) || typeof (raw as StreamRead).id !== 'number') return null
  return raw as StreamRead
}

export async function fetchStreamById(streamId: number, options?: GdcSignalOptions): Promise<StreamRead | null> {
  return cachedRequest(
    STREAM_BY_ID_CACHE_NS,
    String(streamId),
    (signal) => fetchStreamByIdUncached(streamId, signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function createStream(payload: StreamWritePayload): Promise<StreamRead> {
  const created = await requestJson<StreamRead>(`${GDC_API_PREFIX}/streams/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  invalidateStreamCatalogCache(created.id)
  return created
}

export async function updateStream(
  streamId: number,
  payload: StreamWritePayload & { expected_updated_at?: string },
): Promise<StreamRead> {
  let token = payload.expected_updated_at
  if (!token) {
    const current = await fetchStreamById(streamId)
    token = current?.updated_at ?? undefined
  }
  if (!token) {
    throw new Error('expected_updated_at is required for stream updates')
  }
  const updated = await requestJson<StreamRead>(`${GDC_API_PREFIX}/streams/${streamId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...payload, expected_updated_at: token }),
  })
  invalidateStreamCatalogCache(streamId)
  return updated
}

export async function deleteStream(streamId: number): Promise<void> {
  await requestJson<unknown>(`${GDC_API_PREFIX}/streams/${streamId}`, {
    method: 'DELETE',
  })
  invalidateStreamCatalogCache(streamId)
}

/**
 * Best-effort connector/source candidate discovered from existing streams.
 *
 * Backend `POST /streams/` requires existing `connector_id` and `source_id`,
 * and the connectors/sources HTTP routers currently return placeholders, so
 * the wizard reuses any (connector_id, source_id) pair from the streams list.
 * Returns null when nothing usable is available — callers must then fall back
 * to local/mock save.
 */
export async function findConnectorSourceCandidate(): Promise<{ connector_id: number; source_id: number } | null> {
  const list = await fetchStreamsList()
  if (!list?.length) return null
  for (const row of list) {
    if (typeof row.connector_id === 'number' && typeof row.source_id === 'number') {
      return { connector_id: row.connector_id, source_id: row.source_id }
    }
  }
  return null
}
