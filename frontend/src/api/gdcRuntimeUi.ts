import { requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const RT = `${GDC_API_PREFIX}/runtime`

/**
 * Runtime UI save endpoints.
 *
 * These wrap the existing backend runtime config-save APIs. They are scoped to
 * a numeric stream/route/destination id; no new backend endpoints are added.
 *
 * - `POST /runtime/streams/{id}/mapping-ui/save` — single-commit save for the
 *   stream Mapping UI (mapping + enrichment + route formatters).
 * - `POST /runtime/streams/{id}/ui/save` — stream-scoped UI bundle save.
 * - `POST /runtime/routes/{id}/ui/save` — route-scoped UI bundle save.
 *
 * These map directly to the request/response Pydantic schemas under
 * `app.runtime.schemas` (`MappingUISaveRequest`, `StreamUISaveRequest`,
 * `RouteUISaveRequest`).
 */

export type MappingUiSaveMappingPayload = {
  event_array_path?: string | null
  event_root_path?: string | null
  field_mappings: Record<string, unknown>
  raw_payload_mode?: string | null
}

export type MappingUiSaveEnrichmentPayload = {
  enabled?: boolean
  enrichment?: Record<string, unknown>
  override_policy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
}

export type MappingUiSaveRouteFormatter = {
  route_id: number
  formatter_config: Record<string, unknown>
}

export type MappingUiSaveRequest = {
  mapping?: MappingUiSaveMappingPayload | null
  enrichment?: MappingUiSaveEnrichmentPayload | null
  route_formatters?: MappingUiSaveRouteFormatter[]
}

export type MappingUiSaveResponse = {
  stream_id: number
  mapping_saved: boolean
  enrichment_saved: boolean
  route_formatter_saved_count: number
  route_formatter_route_ids: number[]
  message: string
}

/**
 * Strict (throws on HTTP error) variant — used when the UI must surface the
 * exact backend reason for failure.
 */
export async function saveStreamMappingUiConfigStrict(
  streamId: number,
  payload: MappingUiSaveRequest,
): Promise<MappingUiSaveResponse> {
  return requestJson<MappingUiSaveResponse>(
    `${RT}/streams/${streamId}/mapping-ui/save`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

/**
 * Best-effort variant — returns null on any error (mock fallback path).
 */
export async function saveStreamMappingUiConfig(
  streamId: number,
  payload: MappingUiSaveRequest,
): Promise<MappingUiSaveResponse | null> {
  return safeRequestJson<MappingUiSaveResponse>(
    `${RT}/streams/${streamId}/mapping-ui/save`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export type StreamDeduplicationConfig = {
  enabled: boolean
  key_field: string
  custom_jsonpath: string | null
  duplicate_handling: 'skip_duplicate' | 'keep_latest' | 'keep_first'
  scope: 'current_run' | 'checkpoint_window' | 'last_n_hours'
  window_hours: number | null
}

export const DEFAULT_STREAM_DEDUPLICATION_CONFIG: StreamDeduplicationConfig = {
  enabled: false,
  key_field: 'event_id',
  custom_jsonpath: null,
  duplicate_handling: 'skip_duplicate',
  scope: 'current_run',
  window_hours: null,
}

export function streamDeduplicationConfigWithKey(
  current: StreamDeduplicationConfig | null | undefined,
  rawKey: string,
): StreamDeduplicationConfig {
  const key = rawKey.trim()
  const custom = key.startsWith('$')
  const base = current ?? DEFAULT_STREAM_DEDUPLICATION_CONFIG
  return {
    enabled: key.length > 0,
    key_field: custom ? 'custom_jsonpath' : key || base.key_field || 'event_id',
    custom_jsonpath: custom ? key : null,
    duplicate_handling: base.duplicate_handling,
    scope: base.scope,
    window_hours: base.window_hours,
  }
}

export type StreamDedupRuntimeStatus = StreamDeduplicationConfig & {
  last_runtime_duplicate_count: number
  last_runtime_dedup_summary: Record<string, unknown> | null
  last_runtime_stats_degraded: boolean
}

export async function fetchStreamDeduplication(
  streamId: number,
): Promise<StreamDedupRuntimeStatus | null> {
  return safeRequestJson<StreamDedupRuntimeStatus>(`${RT}/streams/${streamId}/deduplication`)
}

export async function saveStreamDeduplication(
  streamId: number,
  payload: StreamDeduplicationConfig,
): Promise<StreamDeduplicationConfig> {
  return requestJson<StreamDeduplicationConfig>(`${RT}/streams/${streamId}/deduplication`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export type StreamUiSaveRequest = {
  name: string
  enabled: boolean
  polling_interval: number
  config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
}

export type StreamUiSaveResponse = {
  stream_id: number
  name: string
  enabled: boolean
  polling_interval: number
  config_json: Record<string, unknown>
  rate_limit_json: Record<string, unknown>
  message: string
}

export async function saveStreamUiConfig(
  streamId: number,
  payload: StreamUiSaveRequest,
): Promise<StreamUiSaveResponse | null> {
  return safeRequestJson<StreamUiSaveResponse>(
    `${RT}/streams/${streamId}/ui/save`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export type SourceUiSaveRequest = {
  enabled: boolean
  config_json: Record<string, unknown>
  auth_json: Record<string, unknown>
  source_type?: string | null
}

export type SourceUiSaveResponse = {
  source_id: number
  enabled: boolean
  config_json: Record<string, unknown>
  auth_json: Record<string, unknown>
  message: string
}

export async function saveSourceUiConfig(
  sourceId: number,
  payload: SourceUiSaveRequest,
): Promise<SourceUiSaveResponse | null> {
  return safeRequestJson<SourceUiSaveResponse>(
    `${RT}/sources/${sourceId}/ui/save`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export type RouteUiSaveRequest = {
  route_enabled?: boolean | null
  route_formatter_config?: Record<string, unknown> | null
  route_rate_limit?: Record<string, unknown> | null
  failure_policy?:
    | 'LOG_AND_CONTINUE'
    | 'PAUSE_STREAM_ON_FAILURE'
    | 'RETRY_AND_BACKOFF'
    | 'DISABLE_ROUTE_ON_FAILURE'
    | null
  destination_enabled?: boolean | null
}

export type RouteUiSaveResponse = {
  route_id: number
  destination_id: number
  route_enabled: boolean
  destination_enabled: boolean
  failure_policy: string
  formatter_config: Record<string, unknown>
  route_rate_limit: Record<string, unknown>
  message: string
}

export async function saveRouteUiConfig(
  routeId: number,
  payload: RouteUiSaveRequest,
): Promise<RouteUiSaveResponse | null> {
  return safeRequestJson<RouteUiSaveResponse>(
    `${RT}/routes/${routeId}/ui/save`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}
