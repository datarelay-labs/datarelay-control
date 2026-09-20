import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache, clearSharedRequestCacheByKeyPrefix } from './requestCache'
import type {
  CheckpointHistoryResponse,
  CheckpointTraceResponse,
  DashboardSummaryResponse,
  ValidationOperationalSummaryResponse,
  MappingUIConfigResponse,
  RuntimeAlertSummaryResponse,
  RuntimeRouteEnabledSaveResponse,
  RuntimeLogSearchResponse,
  RuntimeLogsPageResponse,
  RuntimeLogsTotalsResponse,
  DeliveryLogReplayResponse,
  RuntimeStreamControlResponse,
  RuntimeStreamRunOnceResponse,
  RuntimeSystemResourcesResponse,
  StreamHealthResponse,
  StreamRuntimeMetricsResponse,
  StreamRuntimeStatsHealthBundleResponse,
  BulkStreamStatsHealthResponse,
  StreamRuntimeStatsResponse,
  WebhookIngestObservabilityResponse,
  RuntimeTimelineResponse,
  RuntimeTraceResponse,
  DashboardOutcomeTimeseriesResponse,
  RuntimeStatusResponse,
} from './types/gdcApi'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const RUNTIME_READ_CACHE_TTL_MS = 15_000
const RUNTIME_READ_CACHE_NS = 'runtime-read'

const DASHBOARD_ANALYTICS_CACHE_NS = 'runtime-dashboard'
const DASHBOARD_ANALYTICS_CACHE_TTL_MS = 30_000

export function invalidateStreamMappingUiConfigCache(streamId: number): void {
  clearSharedRequestCache(RUNTIME_READ_CACHE_NS, `mapping-ui:${streamId}`)
}

/** Clears per-stream metrics/stats-health reads so post-mutation refresh cannot reuse stale TTL entries. */
export function invalidateStreamRuntimeReadCache(streamId: number): void {
  clearSharedRequestCacheByKeyPrefix(RUNTIME_READ_CACHE_NS, `stats-health:${streamId}:`)
  clearSharedRequestCacheByKeyPrefix(RUNTIME_READ_CACHE_NS, `stream-metrics:${streamId}:`)
}

/** Clears outcome-timeseries and alerts-summary caches (call on manual refresh). */
export function invalidateDashboardAnalyticsCache(): void {
  clearSharedRequestCache(DASHBOARD_ANALYTICS_CACHE_NS)
}

export type MetricsWindow = '15m' | '1h' | '6h' | '24h'

const METRICS_WINDOW_SECONDS: Record<MetricsWindow, number> = {
  '15m': 15 * 60,
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
}

export function metricsWindowSeconds(window: MetricsWindow): number {
  return METRICS_WINDOW_SECONDS[window] ?? 3600
}

/** Extended runtime metrics windows supported by the backend (includes long ranges). */
export type ExtendedMetricsWindow = MetricsWindow | '7d' | '30d'

export type RuntimeSnapshotParams = {
  snapshot_id?: string
}

function snapshotKey(snapshotId: string | undefined): string {
  const trimmed = snapshotId?.trim()
  return trimmed && trimmed !== '' ? trimmed : 'latest'
}

export function fetchRuntimeDashboardSummary(
  limit = 100,
  window: ExtendedMetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
  options?: GdcSignalOptions,
): Promise<DashboardSummaryResponse | null> {
  const q = new URLSearchParams({ limit: String(limit), window })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `dashboard-summary:${limit}:${window}:${snapshotKey(params.snapshot_id)}`
  return cachedRequest(
    'runtime-read',
    key,
    (signal) =>
      safeRequestJson<DashboardSummaryResponse>(
        `${RT}/dashboard/summary?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function fetchRuntimeStatus(): Promise<RuntimeStatusResponse | null> {
  return safeRequestJson<RuntimeStatusResponse>(`${RT}/status`, readJsonOpts)
}

export async function fetchRuntimeValidationOperationalSummary(): Promise<ValidationOperationalSummaryResponse | null> {
  return safeRequestJson<ValidationOperationalSummaryResponse>(`${RT}/validation/operational-summary`, readJsonOpts)
}

export function fetchRuntimeDashboardOutcomeTimeseries(
  window: ExtendedMetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
  options?: GdcSignalOptions,
): Promise<DashboardOutcomeTimeseriesResponse | null> {
  const q = new URLSearchParams({ window })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `outcome-timeseries:${q.toString()}`
  return cachedRequest(
    DASHBOARD_ANALYTICS_CACHE_NS,
    key,
    (signal) =>
      safeRequestJson<DashboardOutcomeTimeseriesResponse>(
        `${RT}/dashboard/outcome-timeseries?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: DASHBOARD_ANALYTICS_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function fetchRuntimeSystemResources(options?: GdcSignalOptions): Promise<RuntimeSystemResourcesResponse | null> {
  return safeRequestJson<RuntimeSystemResourcesResponse>(
    `${RT}/system/resources`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export function fetchRuntimeAlertSummary(
  window: ExtendedMetricsWindow = '1h',
  limit = 100,
  options?: GdcSignalOptions,
): Promise<RuntimeAlertSummaryResponse | null> {
  const q = new URLSearchParams({ window, limit: String(limit) })
  const key = `alerts-summary:${q.toString()}`
  return cachedRequest(
    DASHBOARD_ANALYTICS_CACHE_NS,
    key,
    (signal) =>
      safeRequestJson<RuntimeAlertSummaryResponse>(
        `${RT}/logs/alerts/summary?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: DASHBOARD_ANALYTICS_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function fetchStreamRuntimeStats(
  streamId: number,
  limit = 100,
  window?: MetricsWindow,
  params: RuntimeSnapshotParams = {},
): Promise<StreamRuntimeStatsResponse | null> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (window != null) q.set('window', window)
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  return safeRequestJson<StreamRuntimeStatsResponse>(`${RT}/stats/stream/${streamId}?${q.toString()}`, readJsonOpts)
}

export async function fetchStreamRuntimeHealth(
  streamId: number,
  limit = 100,
  window: MetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
): Promise<StreamHealthResponse | null> {
  const q = new URLSearchParams({ limit: String(limit), window })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  return safeRequestJson<StreamHealthResponse>(`${RT}/health/stream/${streamId}?${q.toString()}`, readJsonOpts)
}

/** One round-trip for stats + health (single delivery_logs scan server-side). */
export function fetchStreamRuntimeStatsHealth(
  streamId: number,
  limit = 100,
  window?: ExtendedMetricsWindow,
  params: RuntimeSnapshotParams = {},
  options?: GdcSignalOptions,
): Promise<StreamRuntimeStatsHealthBundleResponse | null> {
  const q = new URLSearchParams({ limit: String(limit) })
  if (window != null) q.set('window', window)
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `stats-health:${streamId}:${limit}:${window ?? 'default'}:${snapshotKey(params.snapshot_id)}`
  return cachedRequest(
    'runtime-read',
    key,
    (signal) =>
      safeRequestJson<StreamRuntimeStatsHealthBundleResponse>(
        `${RT}/streams/${streamId}/stats-health?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS, signal: options?.signal },
  )
}

/** Bulk stats + health for Streams Console (replaces per-stream N+1 stats-health calls). */
export function fetchBulkStreamStatsHealth(
  streamIds: readonly number[],
  limit = 100,
  window: ExtendedMetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
  options?: GdcSignalOptions,
): Promise<BulkStreamStatsHealthResponse | null> {
  const unique = [...new Set(streamIds.filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b)
  if (!unique.length) return Promise.resolve({ window, snapshot_id: params.snapshot_id ?? null, streams: {} })
  const q = new URLSearchParams({
    ids: unique.join(','),
    limit: String(limit),
    window,
  })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `stats-health-bulk:${unique.join(',')}:${limit}:${window}:${snapshotKey(params.snapshot_id)}`
  return cachedRequest(
    'runtime-read',
    key,
    (signal) =>
      safeRequestJson<BulkStreamStatsHealthResponse>(
        `${RT}/streams/stats-health/bulk?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS, signal: options?.signal },
  )
}

export function fetchStreamRuntimeMetrics(
  streamId: number,
  window: MetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
  options?: GdcSignalOptions,
): Promise<StreamRuntimeMetricsResponse | null> {
  const q = new URLSearchParams({ window })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `stream-metrics:${streamId}:${window}:${snapshotKey(params.snapshot_id)}`
  return cachedRequest(
    'runtime-read',
    key,
    (signal) =>
      safeRequestJson<StreamRuntimeMetricsResponse>(
        `${RT}/streams/${streamId}/metrics?${q.toString()}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS, signal: options?.signal },
  )
}

export function fetchStreamWebhookIngestObservability(
  streamId: number,
  window: MetricsWindow = '1h',
  params: RuntimeSnapshotParams = {},
  logLimit = 20,
): Promise<WebhookIngestObservabilityResponse | null> {
  const q = new URLSearchParams({ window, log_limit: String(logLimit) })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `webhook-ingest:${streamId}:${window}:${snapshotKey(params.snapshot_id)}:${logLimit}`
  return cachedRequest(
    'runtime-read',
    key,
    () =>
      safeRequestJson<WebhookIngestObservabilityResponse>(
        `${RT}/streams/${streamId}/webhook-ingest?${q.toString()}`,
        readJsonOpts,
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS },
  )
}

export function fetchStreamMappingUiConfig(
  streamId: number,
  options?: GdcSignalOptions & { fresh?: boolean },
): Promise<MappingUIConfigResponse | null> {
  if (options?.fresh) {
    invalidateStreamMappingUiConfigCache(streamId)
  }
  return cachedRequest(
    RUNTIME_READ_CACHE_NS,
    `mapping-ui:${streamId}`,
    (signal) =>
      safeRequestJson<MappingUIConfigResponse>(
        `${RT}/streams/${streamId}/mapping-ui/config`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function fetchStreamRuntimeTimeline(
  streamId: number,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<RuntimeTimelineResponse | null> {
  const limit = opts.limit ?? 100
  const q = new URLSearchParams({ limit: String(limit) })
  return safeRequestJson<RuntimeTimelineResponse>(
    `${RT}/timeline/stream/${streamId}?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, opts.signal),
  )
}

export type RuntimeLogSearchParams = {
  stream_id?: number
  route_id?: number
  destination_id?: number
  run_id?: string
  stage?: string
  level?: string
  status?: string
  error_code?: string
  partial_success?: boolean
  limit?: number
  window?: MetricsWindow
  snapshot_id?: string
}

export function searchRuntimeDeliveryLogs(params: RuntimeLogSearchParams): Promise<RuntimeLogSearchResponse | null> {
  const q = new URLSearchParams()
  if (params.stream_id != null) q.set('stream_id', String(params.stream_id))
  if (params.route_id != null) q.set('route_id', String(params.route_id))
  if (params.destination_id != null) q.set('destination_id', String(params.destination_id))
  if (params.run_id != null && params.run_id.trim() !== '') q.set('run_id', params.run_id.trim())
  if (params.stage != null) q.set('stage', params.stage)
  if (params.level != null) q.set('level', params.level)
  if (params.status != null) q.set('status', params.status)
  if (params.error_code != null) q.set('error_code', params.error_code)
  if (params.partial_success === true) q.set('partial_success', 'true')
  if (params.partial_success === false) q.set('partial_success', 'false')
  q.set('limit', String(params.limit ?? 200))
  q.set('window', params.window ?? '1h')
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const key = `logs-search:${q.toString()}`
  return cachedRequest(
    'runtime-read',
    key,
    () => safeRequestJson<RuntimeLogSearchResponse>(`${RT}/logs/search?${q.toString()}`, readJsonOpts),
    { ttlMs: RUNTIME_READ_CACHE_TTL_MS },
  )
}

export type RuntimeLogsPageParams = {
  limit?: number
  cursor_created_at?: string
  cursor_id?: number
  stream_id?: number
  route_id?: number
  destination_id?: number
  run_id?: string
  stage?: string
  level?: string
  status?: string
  error_code?: string
  partial_success?: boolean
  window?: MetricsWindow
  snapshot_id?: string
}

export async function fetchRuntimeLogsPage(
  params: RuntimeLogsPageParams = {},
  options?: GdcSignalOptions,
): Promise<RuntimeLogsPageResponse | null> {
  const q = new URLSearchParams()
  q.set('limit', String(params.limit ?? 100))
  if (params.cursor_created_at != null && params.cursor_id != null) {
    q.set('cursor_created_at', params.cursor_created_at)
    q.set('cursor_id', String(params.cursor_id))
  }
  if (params.stream_id != null) q.set('stream_id', String(params.stream_id))
  if (params.route_id != null) q.set('route_id', String(params.route_id))
  if (params.destination_id != null) q.set('destination_id', String(params.destination_id))
  if (params.run_id != null && params.run_id.trim() !== '') q.set('run_id', params.run_id.trim())
  if (params.stage != null) q.set('stage', params.stage)
  if (params.level != null) q.set('level', params.level)
  if (params.status != null) q.set('status', params.status)
  if (params.error_code != null) q.set('error_code', params.error_code)
  if (params.partial_success === true) q.set('partial_success', 'true')
  if (params.partial_success === false) q.set('partial_success', 'false')
  if (params.window != null) q.set('window', params.window)
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  return safeRequestJson<RuntimeLogsPageResponse>(
    `${RT}/logs/page?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function fetchRuntimeLogsTotals(params: RuntimeLogSearchParams): Promise<RuntimeLogsTotalsResponse | null> {
  const q = new URLSearchParams()
  if (params.stream_id != null) q.set('stream_id', String(params.stream_id))
  if (params.route_id != null) q.set('route_id', String(params.route_id))
  if (params.destination_id != null) q.set('destination_id', String(params.destination_id))
  if (params.run_id) q.set('run_id', params.run_id)
  if (params.stage) q.set('stage', params.stage)
  if (params.level) q.set('level', params.level)
  if (params.status) q.set('status', params.status)
  if (params.error_code) q.set('error_code', params.error_code)
  if (params.partial_success === true) q.set('partial_success', 'true')
  if (params.partial_success === false) q.set('partial_success', 'false')
  q.set('window', params.window ?? '1h')
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  const result = await safeRequestJson<RuntimeLogsTotalsResponse>(`${RT}/logs/totals?${q.toString()}`, readJsonOpts)
  if (import.meta.env.DEV) {
    const elapsedMs =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now() - startedAt
        : Date.now() - startedAt
    console.info('[observability] logs totals fetch ms', { elapsed_ms: Math.round(elapsedMs), window: params.window ?? '1h' })
  }
  return result
}

export async function fetchCheckpointTrace(runId: string): Promise<CheckpointTraceResponse | null> {
  const rid = runId.trim()
  if (!rid) return null
  const q = new URLSearchParams({ run_id: rid })
  return safeRequestJson<CheckpointTraceResponse>(`${RT}/checkpoints/trace?${q.toString()}`, readJsonOpts)
}

export async function fetchStreamCheckpointHistory(
  streamId: number,
  limit = 50,
  options?: GdcSignalOptions,
): Promise<CheckpointHistoryResponse | null> {
  const q = new URLSearchParams({ limit: String(limit) })
  return safeRequestJson<CheckpointHistoryResponse>(
    `${RT}/checkpoints/streams/${streamId}/history?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}

export async function fetchRuntimeLogTrace(logId: number): Promise<RuntimeTraceResponse | null> {
  return safeRequestJson<RuntimeTraceResponse>(`${RT}/logs/${logId}/trace`, readJsonOpts)
}

/** Replay a failed route delivery log (optional dry-run; does not advance checkpoints). */
export async function replayDeliveryLog(
  logId: number,
  options: { dry_run?: boolean } = {},
): Promise<DeliveryLogReplayResponse> {
  return requestJson<DeliveryLogReplayResponse>(`${RT}/replay/delivery-log/${logId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: Boolean(options.dry_run) }),
  })
}

export async function fetchRuntimeRunTrace(runId: string): Promise<RuntimeTraceResponse | null> {
  const rid = runId.trim()
  if (!rid) return null
  return safeRequestJson<RuntimeTraceResponse>(`${RT}/runs/${encodeURIComponent(rid)}/trace`, readJsonOpts)
}

export async function startRuntimeStream(streamId: number): Promise<RuntimeStreamControlResponse | null> {
  return safeRequestJson<RuntimeStreamControlResponse>(`${RT}/streams/${streamId}/start`, { method: 'POST' })
}

export async function stopRuntimeStream(streamId: number): Promise<RuntimeStreamControlResponse | null> {
  return safeRequestJson<RuntimeStreamControlResponse>(`${RT}/streams/${streamId}/stop`, { method: 'POST' })
}

/** Single StreamRunner cycle; throws on HTTP/network error with backend detail when available. */
export async function runStreamOnce(streamId: number): Promise<RuntimeStreamRunOnceResponse> {
  return requestJson<RuntimeStreamRunOnceResponse>(`${RT}/streams/${streamId}/run-once`, { method: 'POST' })
}

export async function saveRuntimeRouteEnabledState(
  routeId: number,
  enabled: boolean,
  options?: { disable_reason?: string | null },
): Promise<RuntimeRouteEnabledSaveResponse | null> {
  const body: Record<string, unknown> = { enabled }
  if (!enabled && options?.disable_reason != null && String(options.disable_reason).trim() !== '') {
    body.disable_reason = String(options.disable_reason).trim()
  }
  return safeRequestJson<RuntimeRouteEnabledSaveResponse>(`${RT}/routes/${routeId}/enabled/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type RuntimeRouteFailurePolicySaveResponse = {
  route_id: number
  stream_id: number
  destination_id: number
  failure_policy: string
  message: string
}

export async function saveRuntimeRouteFailurePolicy(
  routeId: number,
  failure_policy: string,
): Promise<RuntimeRouteFailurePolicySaveResponse | null> {
  return safeRequestJson<RuntimeRouteFailurePolicySaveResponse>(`${RT}/routes/${routeId}/failure-policy/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ failure_policy }),
  })
}
