import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'
import { normalizeGdcStreamSourceType } from './sourceTypePresentation'

export function resolveStreamEndpointPath(
  configJson: Record<string, unknown> | null | undefined,
  sourceConfig?: Record<string, unknown> | null,
): string {
  const cfg = configJson ?? {}
  const sc = sourceConfig ?? {}
  const direct = String(cfg.endpoint ?? cfg.endpoint_path ?? sc.endpoint_path ?? sc.endpoint ?? cfg.path ?? '').trim()
  if (direct) return direct
  const baseUrl = String(cfg.base_url ?? sc.base_url ?? '').trim()
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    try {
      const path = new URL(baseUrl).pathname
      if (path && path !== '/') return path
    } catch {
      /* ignore malformed URL */
    }
  }
  return ''
}

/**
 * DATABASE_QUERY sample `stream_config`: the saved SQL (and binds), never an HTTP request shape.
 * The backend sample fetch rejects a DATABASE_QUERY request without `query`.
 */
function buildStreamDatabaseConfigFromStreamRead(cfgj: Record<string, unknown>): Record<string, unknown> {
  const streamCfg: Record<string, unknown> = {
    query: typeof cfgj.query === 'string' ? cfgj.query.trim() : '',
  }
  const qp = cfgj.query_params
  if (qp && typeof qp === 'object') streamCfg.query_params = qp
  const qt = cfgj.query_timeout_seconds
  const timeout = typeof qt === 'number' ? qt : typeof qt === 'string' ? Number.parseInt(qt.trim(), 10) : NaN
  streamCfg.query_timeout_seconds = Number.isFinite(timeout) && timeout > 0 ? timeout : 30
  return streamCfg
}

/**
 * Build `stream_config` for `POST /runtime/api-test/http` from persisted stream + mapping-ui rows.
 * Mirrors {@link StreamApiTestPage} load logic so Mapping and API Test stay aligned.
 * DATABASE_QUERY streams get their saved SQL query instead of an HTTP request.
 */
export function buildStreamHttpConfigFromStreamRead(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
): Record<string, unknown> {
  const sc = cfg.source_config ?? {}
  const cfgj = (stream.config_json ?? {}) as Record<string, unknown>
  if (normalizeGdcStreamSourceType(cfg.source_type ?? stream.stream_type) === 'DATABASE_QUERY') {
    return buildStreamDatabaseConfigFromStreamRead(cfgj)
  }
  const ep = resolveStreamEndpointPath(cfgj, sc)
  const m = String(cfgj.method ?? cfgj.http_method ?? (sc as { http_method?: string }).http_method ?? 'GET').toUpperCase()
  const method = m === 'POST' ? 'POST' : 'GET'
  const params = (cfgj.params ?? {}) as Record<string, unknown>
  const hdrRaw = cfgj.headers
  const headers: Record<string, unknown> = {}
  if (hdrRaw && typeof hdrRaw === 'object' && !Array.isArray(hdrRaw)) {
    Object.assign(headers, hdrRaw as Record<string, unknown>)
  }
  const body = cfgj.body ?? cfgj.request_body
  const ts = cfgj.timeout_seconds ?? cfgj.timeout_sec ?? (sc as { timeout_sec?: unknown }).timeout_sec
  const timeoutSeconds =
    typeof ts === 'number' && Number.isFinite(ts)
      ? ts
      : typeof ts === 'string' && ts.trim()
        ? Number.parseInt(ts.trim(), 10) || 30
        : 30

  const streamCfg: Record<string, unknown> = {
    method,
    endpoint: ep,
    timeout_seconds: timeoutSeconds,
    params,
  }
  if (Object.keys(headers).length) streamCfg.headers = headers
  if (body !== undefined) streamCfg.body = body
  return streamCfg
}

export function connectorBaseUrlFromMappingUi(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
): string {
  const sc = cfg.source_config ?? {}
  const cfgj = (stream.config_json ?? {}) as Record<string, unknown>
  const baseFromSource = String((sc as { base_url?: string }).base_url ?? '').trim()
  const baseFromStream = String(cfgj.base_url ?? '').trim()
  return baseFromStream || baseFromSource
}
