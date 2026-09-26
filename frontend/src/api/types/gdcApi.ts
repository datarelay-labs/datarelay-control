/**
 * Subset of backend `app/runtime/schemas.py` (JSON uses snake_case).
 */

export type MigrationIntegrityReportDto = {
  ok: boolean
  status: 'ok' | 'warn' | 'error'
  repo_heads: string[]
  db_revision: string | null
  db_revision_in_repo: boolean
  db_revision_is_head: boolean
  db_revision_is_known_orphan: boolean
  head_count: number
  errors: string[]
  warnings: string[]
  infos: string[]
  database_target: Record<string, unknown>
}

export type RuntimeStatusDatabaseDto = {
  dbname: string | null
  host: string | null
  port: number | null
  user: string | null
  url_source: string
}

export type RuntimeStatusResponse = {
  database: RuntimeStatusDatabaseDto
  alembic_revision: string | null
  schema_ready: boolean
  missing_tables: string[]
  scheduler_active: boolean
  degraded_reason: string | null
  connection_error: string | null
  migration_integrity?: MigrationIntegrityReportDto
}

export type MetricMeta = {
  metric_id: string
  label: string
  semantic_type: string
  source_table: string
  source_tables?: string[]
  source_stage_or_status: string
  aggregation_method: string
  aggregation_type?: string
  window_policy: string
  includes_lifecycle_rows?: boolean
  includes_retry_success?: boolean
  includes_retry_failed?: boolean
  retry_policy: string
  lifecycle_policy: string
  disabled_route_policy: string
  idle_route_policy: string
  display_unit?: string
  frontend_label?: string
  frontend_description?: string
  description: string
  window_start?: string
  window_end?: string
  generated_at?: string
}

export type MetricMetaMap = Record<string, MetricMeta>

export type VisualizationMeta = {
  metric_id: string
  chart_metric_id: string
  aggregation_type: string
  visualization_type: string
  normalization_rule: 'raw_count' | 'eps_bucket' | 'eps_window_avg' | 'ratio' | 'avg_ms' | 'percent' | string
  bucket_unit: string
  bucket_size_seconds?: number | null
  bucket_count?: number
  y_axis_semantics: string
  avg_vs_peak_semantics: string
  cumulative_semantics: string
  subset_semantics: string
  chart_window_semantics: string
  snapshot_alignment_required: boolean
  display_unit: string
  tooltip_template: string
  snapshot_id?: string | null
  generated_at?: string | null
  window_start?: string | null
  window_end?: string | null
  subset?: {
    subset_of_metric_id: string
    subset_total: number
    global_total: number
    subset_coverage_ratio: number
    display_unit: string
  }
}

export type VisualizationMetaMap = Record<string, VisualizationMeta>

export type DashboardSummaryNumbers = {
  total_streams: number
  running_streams: number
  paused_streams: number
  error_streams: number
  stopped_streams: number
  rate_limited_source_streams: number
  rate_limited_destination_streams: number
  total_routes: number
  enabled_routes: number
  disabled_routes: number
  total_destinations: number
  enabled_destinations: number
  disabled_destinations: number
  recent_logs: number
  recent_successes: number
  recent_failures: number
  recent_rate_limited: number
  processed_events: number
  delivery_outcome_events: number
  delivery_success_events?: number
  delivery_failure_events?: number
  current_runtime_streams_healthy?: number
  current_runtime_streams_degraded?: number
  current_runtime_streams_unhealthy?: number
  current_runtime_streams_critical?: number
}

export type ObservabilitySummaryTotals = {
  streams_total: number
  streams_running: number
  routes_total: number
  routes_enabled: number
  healthy_routes: number
  idle_routes: number
  unhealthy_routes: number
  critical_routes?: number
  delivery_success_events: number
  delivery_failed_events: number
  retry_success_events: number
  retry_failed_events: number
  runtime_telemetry_rows: number
  lifecycle_rows: number
  processed_events: number
  throughput_eps: number
  p95_latency_ms: number | null
}

export type ObservabilitySummaryResponse = {
  snapshot_id: string
  generated_at: string
  window: string
  window_start: string
  window_end: string
  metric_contract_version: string
  totals: ObservabilitySummaryTotals
  metric_contract: Record<string, unknown>
  metric_meta: MetricMetaMap
}

export type RecentProblemRouteItem = {
  stream_id: number
  route_id: number
  destination_id: number | null
  stage: string
  error_code: string | null
  message: string
  created_at: string
}

export type RecentRateLimitedRouteItem = {
  stream_id: number
  route_id: number
  destination_id: number | null
  stage: string
  error_code: string | null
  message: string
  created_at: string
}

export type RecentUnhealthyStreamItem = {
  stream_id: number
  stream_status: string
  last_problem_stage: string
  last_error_code: string | null
  last_error_message: string | null
  last_problem_at: string
}

export type ValidationAlertItem = {
  id: number
  validation_id: number
  validation_run_id: number | null
  severity: string
  alert_type: string
  status: string
  title: string
  message: string
  fingerprint: string
  triggered_at: string
  acknowledged_at: string | null
  resolved_at: string | null
  created_at: string
}

export type ValidationRecoveryItem = {
  id: number
  validation_id: number
  validation_run_id: number | null
  category: string
  title: string
  message: string
  created_at: string
}

export type ValidationOutcomeTrendBucket = {
  bucket_start: string
  pass_count: number
  fail_count: number
  warn_count: number
}

export type ValidationFailuresSummaryResponse = {
  failing_validations_count: number
  degraded_validations_count: number
  open_alerts_critical: number
  open_alerts_warning: number
  open_alerts_info: number
  open_auth_failure_alerts: number
  open_delivery_failure_alerts: number
  open_checkpoint_drift_alerts: number
  latest_open_alerts: ValidationAlertItem[]
}

export type ValidationOperationalSummaryResponse = {
  failing_validations_count: number
  degraded_validations_count: number
  open_alerts_critical: number
  open_alerts_warning: number
  open_alerts_info: number
  open_auth_failure_alerts: number
  open_delivery_failure_alerts: number
  open_checkpoint_drift_alerts: number
  latest_open_alerts: ValidationAlertItem[]
  latest_recoveries: ValidationRecoveryItem[]
  outcome_trend_24h: ValidationOutcomeTrendBucket[]
  scoring_mode?: string | null
  /** True when the API returned a zeroed fallback after aggregation failed. */
  degraded?: boolean
}

export type DashboardSummaryResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  summary: DashboardSummaryNumbers
  recent_problem_routes: RecentProblemRouteItem[]
  recent_rate_limited_routes: RecentRateLimitedRouteItem[]
  recent_unhealthy_streams: RecentUnhealthyStreamItem[]
  scheduler_started_at?: string | null
  scheduler_uptime_seconds?: number | null
  runtime_engine_status?: 'RUNNING' | 'STOPPED' | 'DEGRADED'
  active_worker_count?: number | null
  metrics_window_seconds?: number
  window_start?: string | null
  window_end?: string | null
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  validation_operational?: ValidationOperationalSummaryResponse | null
  /** Global OPEN StreamSchemaFieldDrift findings; null when unavailable. */
  open_schema_field_drift_count?: number | null
}

/** GET /runtime/dashboard/outcome-timeseries */
export type DashboardOutcomeBucket = {
  bucket_start: string
  success: number
  failed: number
  rate_limited: number
}

export type DashboardOutcomeTimeseriesResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  metrics_window_seconds: number
  window_start?: string | null
  window_end?: string | null
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  buckets: DashboardOutcomeBucket[]
}

export type DestinationDeliveryOutcomeRow = {
  destination_id: number
  success_events: number
  failure_events: number
}

export type DestinationDeliveryOutcomesResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  rows: DestinationDeliveryOutcomeRow[]
}

export type RuntimeAlertSummaryItem = {
  stream_id: number
  stream_name: string
  connector_name: string
  severity: 'WARN' | 'ERROR'
  count: number
  latest_occurrence: string
}

export type RuntimeAlertSummaryResponse = {
  metrics_window_seconds: number
  items: RuntimeAlertSummaryItem[]
}

export type RuntimeSystemResourcesResponse = {
  cpu_percent: number
  memory_percent: number
  memory_used_bytes: number
  memory_total_bytes: number
  disk_percent: number
  disk_used_bytes: number
  disk_total_bytes: number
  network_in_bytes_per_sec: number
  network_out_bytes_per_sec: number
}

export type StreamRuntimeSummary = {
  total_logs: number
  route_send_success: number
  route_send_failed: number
  route_retry_success: number
  route_retry_failed: number
  route_skip: number
  source_rate_limited: number
  destination_rate_limited: number
  route_unknown_failure_policy: number
  run_complete: number
  processed_events?: number
}

export type CheckpointStatsPayload = {
  type: string
  value: Record<string, unknown>
}

export type StreamRuntimeLastSeen = {
  success_at: string | null
  failure_at: string | null
  rate_limited_at: string | null
}

export type RecentDeliveryLogItem = {
  id: number
  stage: string
  level: string
  status: string | null
  message: string
  route_id: number | null
  destination_id: number | null
  error_code: string | null
  created_at: string
}

export type RouteRuntimeCounts = {
  route_send_success: number
  route_send_failed: number
  route_retry_success: number
  route_retry_failed: number
  destination_rate_limited: number
  route_skip: number
  route_unknown_failure_policy: number
}

export type RouteRuntimeStatsItem = {
  route_id: number
  destination_id: number
  destination_type: string
  enabled: boolean
  failure_policy: string
  status: string
  counts: RouteRuntimeCounts
  last_success_at: string | null
  last_failure_at: string | null
}

export type StreamRuntimeStatsResponse = {
  stream_id: number
  stream_status: string
  checkpoint: CheckpointStatsPayload | null
  summary: StreamRuntimeSummary
  last_seen: StreamRuntimeLastSeen
  routes: RouteRuntimeStatsItem[]
  recent_logs: RecentDeliveryLogItem[]
}

export type WebhookIngestRecentResult = {
  at: string | null
  outcome: 'success' | 'partial' | 'failed' | 'none'
  stage: string | null
  message: string | null
  run_id: string | null
}

/** GET /runtime/streams/{id}/webhook-ingest */
export type WebhookIngestObservabilityResponse = {
  stream_id: number
  stream_status: string
  source_enabled: boolean
  stream_enabled: boolean
  receiver_key: string | null
  receiver_path: string | null
  webhook_auth_mode: string
  window: string
  window_start: string
  window_end: string
  ingest_attempts: number
  successful_deliveries: number
  failed_deliveries: number
  auth_failures: number
  malformed_payload_count: number
  recent_ingest: WebhookIngestRecentResult
  recent_logs: RecentDeliveryLogItem[]
}

/** GET /runtime/streams/{id}/mapping-ui/config */
export type MappingUIConfigMapping = {
  exists: boolean
  event_array_path: string | null
  event_root_path: string | null
  field_mappings: Record<string, string>
  raw_payload_mode: string | null
}

export type MappingUIConfigEnrichment = {
  exists: boolean
  enabled: boolean
  enrichment: Record<string, unknown>
  override_policy: string | null
}

export type MappingUIConfigRouteItem = {
  route_id: number
  destination_id: number
  destination_name: string | null
  destination_type: string | null
  route_enabled: boolean
  destination_enabled: boolean
  formatter_config: Record<string, unknown>
  route_rate_limit: Record<string, unknown>
  failure_policy: string
}

export type MappingUIConfigResponse = {
  stream_id: number
  stream_name: string
  stream_enabled: boolean
  stream_status: string
  source_id: number
  source_type: string
  source_config: Record<string, unknown>
  mapping: MappingUIConfigMapping
  enrichment: MappingUIConfigEnrichment
  routes: MappingUIConfigRouteItem[]
  message: string
}

export type StreamHealthSummary = {
  total_routes: number
  healthy_routes: number
  degraded_routes: number
  unhealthy_routes: number
  disabled_routes: number
  idle_routes: number
}

/** Mirrors backend `RouteHealthState`. */
export type RouteHealthStateApi = 'DISABLED' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'IDLE'

/** Mirrors backend `RouteHealthItem` (delivery_logs window). */
export type RouteHealthItem = {
  route_id: number
  destination_id: number
  destination_type: string
  route_enabled: boolean
  destination_enabled: boolean
  failure_policy: string
  route_status: string
  health: RouteHealthStateApi
  success_count: number
  failure_count: number
  rate_limited_count: number
  consecutive_failure_count: number
  last_success_at?: string | null
  last_failure_at?: string | null
  last_rate_limited_at?: string | null
  last_error_code?: string | null
  last_error_message?: string | null
}

export type StreamHealthResponse = {
  stream_id: number
  stream_status: string
  health: string
  limit: number
  summary: StreamHealthSummary
  routes: RouteHealthItem[]
}

/** GET /runtime/streams/{id}/stats-health */
export type StreamRuntimeStatsHealthBundleResponse = {
  stats: StreamRuntimeStatsResponse
  health: StreamHealthResponse
}

/** GET /runtime/streams/stats-health/bulk */
export type StreamStatsHealthBulkEntry = {
  events_per_second: number
  events_1h: number
  events_24h?: number | null
  health: string
  last_event_at?: string | null
  issue?: string | null
  stats: StreamRuntimeStatsResponse
  health_detail: StreamHealthResponse
}

export type BulkStreamStatsHealthResponse = {
  window: string
  snapshot_id?: string | null
  streams: Record<string, StreamStatsHealthBulkEntry>
}

/** GET /runtime/streams/{id}/metrics */
export type StreamMetricsCheckpoint = {
  type: string
  value: Record<string, unknown>
}

export type StreamMetricsStreamBlock = {
  id: number
  name: string
  status: string
  last_run_at: string | null
  last_success_at: string | null
  last_error_at: string | null
  last_checkpoint: StreamMetricsCheckpoint | null
}

export type StreamRuntimeKpis = {
  events_last_hour: number
  delivered_last_hour: number
  failed_last_hour: number
  delivery_success_rate: number | null
  avg_latency_ms: number
  max_latency_ms: number
  error_rate: number
  metric_meta?: MetricMetaMap
}

export type StreamMetricsTimeBucket = {
  timestamp: string
  events: number
  delivered: number
  failed: number
}

export type StreamMetricsRouteHealthRow = {
  route_id: number
  destination_name: string
  destination_type: string
  enabled: boolean
  success_count: number
  failed_count: number
  last_success_at: string | null
  last_failure_at: string | null
  avg_latency_ms: number
  failure_policy: string
  last_error_message: string | null
}

export type StreamMetricsCheckpointHistoryItem = {
  updated_at: string
  checkpoint_preview: string
}

export type StreamMetricsRecentRun = {
  run_id: string
  started_at: string
  duration_ms: number
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NO_EVENTS'
  events: number
  delivered: number
  failed: number
}

export type RouteRuntimeConnectivityState = 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'DISABLED'

export type RouteRuntimeLatencyTrendPoint = {
  timestamp: string
  avg_latency_ms: number
}

export type RouteRuntimeSuccessRateTrendPoint = {
  timestamp: string
  success_rate: number
}

export type RouteRuntimeMetricsRow = {
  route_id: number
  destination_id: number
  destination_name: string
  destination_type: string
  enabled: boolean
  route_status: string
  success_rate: number
  events_last_hour: number
  delivered_last_hour: number
  failed_last_hour: number
  avg_latency_ms: number
  p95_latency_ms: number
  max_latency_ms: number
  eps_current: number
  retry_count_last_hour: number
  last_success_at: string | null
  last_failure_at: string | null
  last_error_message: string | null
  last_error_code: string | null
  failure_policy: string
  connectivity_state: RouteRuntimeConnectivityState
  disable_reason: string | null
  latency_trend: RouteRuntimeLatencyTrendPoint[]
  success_rate_trend: RouteRuntimeSuccessRateTrendPoint[]
}

export type RecentRouteErrorItem = {
  created_at: string
  route_id: number
  destination_id: number | null
  destination_name: string
  error_code: string | null
  message: string
}

export type ThroughputTimePoint = {
  timestamp: string
  events_per_sec: number
}

export type LatencyTimePoint = {
  timestamp: string
  avg_latency_ms: number
}

export type StreamRuntimeMetricsResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  stream: StreamMetricsStreamBlock
  kpis: StreamRuntimeKpis
  metrics_window_seconds?: number
  window_start?: string | null
  window_end?: string | null
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  events_over_time: StreamMetricsTimeBucket[]
  throughput_over_time?: ThroughputTimePoint[]
  latency_over_time?: LatencyTimePoint[]
  route_health: StreamMetricsRouteHealthRow[]
  checkpoint_history: StreamMetricsCheckpointHistoryItem[]
  recent_runs: StreamMetricsRecentRun[]
  route_runtime?: RouteRuntimeMetricsRow[]
  recent_route_errors?: RecentRouteErrorItem[]
}

export type RuntimeTimelineItem = {
  id: number
  created_at: string
  stream_id: number | null
  route_id: number | null
  destination_id: number | null
  run_id: string | null
  stage: string
  level: string
  status: string | null
  message: string
  error_code: string | null
  retry_count: number
  http_status: number | null
  latency_ms: number | null
}

export type RuntimeTimelineResponse = {
  stream_id: number
  total: number
  items: RuntimeTimelineItem[]
}

export type RuntimeLogSearchItem = {
  id: number
  connector_id: number | null
  stream_id: number | null
  route_id: number | null
  destination_id: number | null
  run_id: string | null
  stage: string
  level: string
  status: string | null
  message: string
  retry_count: number
  http_status: number | null
  latency_ms: number | null
  error_code: string | null
  created_at: string
}

export type RuntimeLogSearchResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  metrics_window_seconds?: number | null
  window_start?: string | null
  window_end?: string | null
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  total_returned: number
  filters: Record<string, unknown>
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  logs: RuntimeLogSearchItem[]
}

export type RuntimeLogsPageItem = RuntimeLogSearchItem

export type RuntimeLogsPageResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  metrics_window_seconds?: number | null
  window_start?: string | null
  window_end?: string | null
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  total_returned: number
  has_next: boolean
  next_cursor_created_at: string | null
  next_cursor_id: number | null
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  items: RuntimeLogsPageItem[]
}

export type DeliveryLogReplayResponse = {
  log_id: number
  dry_run: boolean
  outcome: 'dry_run_ok' | 'delivered' | 'failed'
  message: string
  event_count: number
  route_id: number | null
  destination_id: number | null
  stream_id: number | null
  replay_run_id: string
  preview_message_count?: number | null
  preview_messages?: unknown[] | null
  error_type?: string | null
}

export type RuntimeLogsTotalsResponse = {
  snapshot_id?: string | null
  generated_at?: string | null
  metrics_window_seconds: number
  window_start: string
  window_end: string
  total_rows: number
  error_rows: number
  warning_rows: number
  info_rows: number
  debug_rows: number
  metric_meta?: MetricMetaMap
}

export type RuntimeTraceTimelineEntry = {
  id: number
  created_at: string
  stage: string
  level: string
  status: string | null
  message: string
  route_id: number | null
  destination_id: number | null
  latency_ms: number | null
  retry_count: number
  http_status: number | null
  error_code: string | null
}

export type RuntimeTraceCheckpointPayload = {
  checkpoint_type: string | null
  message: string | null
  checkpoint_before?: Record<string, unknown> | null
  checkpoint_after?: Record<string, unknown> | null
  processed_events?: number | null
  delivered_events?: number | null
  failed_events?: number | null
  partial_success?: boolean | null
  update_reason?: string | null
  correlated_route_failures?: Array<Record<string, unknown>>
}

export type RuntimeTraceResponse = {
  run_id: string | null
  anchor_log_id: number | null
  stream_id: number | null
  connector: { id: number; name: string } | null
  stream: { id: number; name: string } | null
  routes: { id: number; destination_id: number | null; label: string }[]
  destinations: { id: number; name: string }[]
  timeline: RuntimeTraceTimelineEntry[]
  checkpoint: RuntimeTraceCheckpointPayload | null
}

export type CheckpointTraceRouteFailureRef = {
  route_id: number
  destination_id: number | null
  stage: string
  message: string
  error_code: string | null
  created_at: string
}

export type CheckpointTraceTimelineNode = {
  kind: string
  title: string
  detail: string | null
  tone: 'success' | 'warning' | 'error' | 'neutral'
  created_at: string | null
  log_id: number | null
}

export type CheckpointTraceResponse = {
  run_id: string
  stream_id: number | null
  stream_name: string | null
  connector_name: string | null
  checkpoint_type: string | null
  checkpoint_before: Record<string, unknown> | null
  checkpoint_after: Record<string, unknown> | null
  processed_events: number | null
  delivered_events: number | null
  failed_events: number | null
  partial_success: boolean | null
  update_reason: string | null
  retry_pending: boolean | null
  correlated_route_failures: CheckpointTraceRouteFailureRef[]
  timeline_events: CheckpointTraceTimelineNode[]
}

export type CheckpointHistoryItem = {
  log_id: number
  run_id: string | null
  created_at: string
  checkpoint_type: string | null
  update_reason: string | null
  partial_success: boolean | null
  checkpoint_after_preview: string | null
}

export type CheckpointHistoryResponse = {
  stream_id: number
  items: CheckpointHistoryItem[]
}

export type RuntimeStreamControlResponse = {
  stream_id: number
  enabled: boolean
  status: string
  action: 'start' | 'stop'
  message: string
}

/**
 * POST /runtime/streams/{id}/run-once.
 * Lock contention is HTTP 409, not a 2xx `skipped_lock` outcome.
 */
export type RuntimeStreamRunOnceResponse = {
  stream_id: number
  outcome: 'completed' | 'no_events'
  message: string | null
  extracted_event_count: number | null
  mapped_event_count: number | null
  enriched_event_count: number | null
  delivered_batch_event_count: number | null
  route_delivery_success_count?: number | null
  route_delivery_failure_count?: number | null
  checkpoint_updated: boolean
  transaction_committed: boolean
  runtime_run_id?: string | null
}

export type RuntimeRouteEnabledSaveResponse = {
  route_id: number
  stream_id: number
  destination_id: number
  enabled: boolean
  message: string
}

export type StreamRead = {
  id: number
  name: string | null
  connector_id: number | null
  source_id: number | null
  stream_type?: string | null
  source_type?: string | null
  config_json?: Record<string, unknown> | null
  polling_interval?: number | null
  enabled?: boolean | null
  status: string | null
  rate_limit_json?: Record<string, unknown> | null
  created_at?: string | null
  updated_at?: string | null
}

/** GET /runtime/analytics/* */
export type AnalyticsTimeWindow = {
  window: string
  since: string
  until: string
  window_start?: string | null
  window_end?: string | null
  snapshot_id?: string | null
  generated_at?: string | null
}

export type AnalyticsScopeFilters = {
  stream_id: number | null
  route_id: number | null
  destination_id: number | null
}

export type FailureTotals = {
  failure_events: number
  success_events: number
  overall_failure_rate: number
}

export type RouteOutcomeRow = {
  route_id: number
  stream_id: number | null
  destination_id: number | null
  failure_count: number
  success_count: number
  failure_rate: number
  last_failure_at: string | null
  last_success_at: string | null
}

export type DimensionCount = {
  id: number | null
  failure_count: number
}

export type FailureTrendBucket = {
  bucket_start: string
  failure_count: number
}

export type CodeCount = {
  error_code: string | null
  count: number
}

export type StageCount = {
  stage: string
  count: number
}

export type UnstableRouteCandidate = {
  route_id: number
  stream_id: number | null
  destination_id: number | null
  failure_count: number
  success_count: number
  failure_rate: number
  sample_total: number
}

export type RouteFailuresAnalyticsResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  totals: FailureTotals
  latency_ms_avg: number | null
  latency_ms_p95: number | null
  last_failure_at: string | null
  last_success_at: string | null
  outcomes_by_route: RouteOutcomeRow[]
  failures_by_destination: DimensionCount[]
  failures_by_stream: DimensionCount[]
  failure_trend: FailureTrendBucket[]
  top_error_codes: CodeCount[]
  top_failed_stages: StageCount[]
  unstable_routes: UnstableRouteCandidate[]
}

export type RouteFailuresScopedResponse = {
  route_id: number
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  bucket_size_seconds?: number | null
  bucket_count?: number | null
  bucket_alignment?: string | null
  bucket_timezone?: string | null
  bucket_mode?: string | null
  totals: FailureTotals
  latency_ms_avg: number | null
  latency_ms_p95: number | null
  last_failure_at: string | null
  last_success_at: string | null
  failures_by_destination: DimensionCount[]
  failure_trend: FailureTrendBucket[]
  top_error_codes: CodeCount[]
  top_failed_stages: StageCount[]
}

export type StreamRetryRow = {
  stream_id: number
  retry_event_count: number
  retry_column_sum: number
}

export type RouteRetryRow = {
  route_id: number
  retry_event_count: number
  retry_column_sum: number
}

export type StreamRetriesAnalyticsResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  retry_heavy_streams: StreamRetryRow[]
  retry_heavy_routes: RouteRetryRow[]
}

export type RetrySummaryResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  metric_meta?: MetricMetaMap
  visualization_meta?: VisualizationMetaMap
  retry_success_events: number
  retry_failed_events: number
  total_retry_outcome_events: number
  retry_column_sum: number
}

/** GET /runtime/health/* — deterministic operational health scoring. */
export type HealthLevel = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'CRITICAL'

export type HealthFactor = {
  code: string
  label: string
  delta: number
  detail: string | null
}

export type HealthScoringMode = 'current_runtime' | 'historical_analytics'

export type HealthMetrics = {
  failure_count: number
  success_count: number
  retry_event_count: number
  retry_count_sum: number
  failure_rate: number
  retry_rate: number
  latency_ms_avg: number | null
  latency_ms_p95: number | null
  last_failure_at: string | null
  last_success_at: string | null
  historical_failure_count: number
  historical_delivery_failure_rate: number
  live_delivery_failure_rate: number
  recent_success_ratio: number
  health_recovery_score: number
  recent_failure_count: number
  recent_success_count: number
  recent_failure_rate: number
  recent_window_since: string | null
  recent_window_until: string | null
  current_runtime_health: HealthLevel | null
}

export type HealthScore = {
  score: number
  level: HealthLevel
  factors: HealthFactor[]
  metrics: HealthMetrics
  scoring_mode: HealthScoringMode
}

export type StreamHealthRow = {
  stream_id: number
  stream_name: string | null
  connector_id: number | null
  score: number
  level: HealthLevel
  factors: HealthFactor[]
  metrics: HealthMetrics
}

export type RouteHealthRow = {
  route_id: number
  stream_id: number | null
  destination_id: number | null
  score: number
  level: HealthLevel
  factors: HealthFactor[]
  metrics: HealthMetrics
}

export type DestinationHealthRow = {
  destination_id: number
  destination_name: string | null
  destination_type: string | null
  score: number
  level: HealthLevel
  factors: HealthFactor[]
  metrics: HealthMetrics
}

export type HealthLevelBreakdown = {
  healthy: number
  degraded: number
  unhealthy: number
  critical: number
  idle?: number
  disabled?: number
  scored?: number
  total?: number
  excluded_no_outcome?: number
  scoring_exclusion_reason?: string | null
}

export type HealthOverviewResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  scoring_mode: HealthScoringMode
  metric_meta?: MetricMetaMap
  streams: HealthLevelBreakdown
  routes: HealthLevelBreakdown
  destinations: HealthLevelBreakdown
  average_stream_score: number | null
  average_route_score: number | null
  average_destination_score: number | null
  worst_routes: RouteHealthRow[]
  worst_streams: StreamHealthRow[]
  worst_destinations: DestinationHealthRow[]
}

export type StreamHealthListResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  scoring_mode: HealthScoringMode
  metric_meta?: MetricMetaMap
  rows: StreamHealthRow[]
}

export type RouteHealthListResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  scoring_mode: HealthScoringMode
  metric_meta?: MetricMetaMap
  rows: RouteHealthRow[]
}

export type DestinationHealthListResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  scoring_mode: HealthScoringMode
  metric_meta?: MetricMetaMap
  rows: DestinationHealthRow[]
}

export type StreamHealthDetailResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  stream_id: number
  stream_name: string | null
  connector_id: number | null
  score: HealthScore
}

export type RouteHealthDetailResponse = {
  time: AnalyticsTimeWindow
  filters: AnalyticsScopeFilters
  route_id: number
  stream_id: number | null
  destination_id: number | null
  score: HealthScore
}

export type TopologySummary = {
  connector_count: number
  source_count: number
  stream_count: number
  route_count: number
  destination_count: number
  streams_with_mapping: number
  streams_with_enrichment: number
  enabled_streams: number
  disabled_streams: number
  enabled_routes: number
  disabled_routes: number
}

export type TopologyConnectorNode = {
  id: number
  name: string
  status: string
  source_count: number
  stream_count: number
}

export type TopologySourceNode = {
  id: number
  connector_id: number
  source_type: string
  enabled: boolean
  stream_count: number
}

export type TopologyStreamNode = {
  stream_id: number
  stream_name: string
  connector_id: number
  source_id: number
  stream_type: string
  enabled: boolean
  status: string
  has_mapping: boolean
  has_enrichment: boolean
  enrichment_enabled: boolean
  route_count: number
  health_level: HealthLevel | null
  health_score: number | null
  last_success_at: string | null
  last_failure_at: string | null
}

export type TopologyRouteNode = {
  route_id: number
  stream_id: number
  destination_id: number
  enabled: boolean
  status: string
  failure_policy: string
  destination_name: string | null
  destination_type: string | null
  destination_enabled: boolean
  health_level: HealthLevel | null
  health_score: number | null
  last_success_at: string | null
  last_failure_at: string | null
}

export type TopologyDestinationNode = {
  destination_id: number
  name: string
  destination_type: string
  enabled: boolean
  route_count: number
  health_level: HealthLevel | null
  health_score: number | null
  last_success_at: string | null
  last_failure_at: string | null
}

export type RuntimeTopologyResponse = {
  time: AnalyticsTimeWindow
  scoring_mode: HealthScoringMode
  summary: TopologySummary
  connectors: TopologyConnectorNode[]
  sources: TopologySourceNode[]
  streams: TopologyStreamNode[]
  routes: TopologyRouteNode[]
  destinations: TopologyDestinationNode[]
}

/** GET /templates/ */
export type TemplateSummaryRead = {
  template_id: string
  name: string
  category: string
  description: string
  source_type: string
  auth_type: string
  tags: string[]
  included_components: string[]
  recommended_destinations: string[]
}

/** GET /templates/{template_id} — full static template document */
export type TemplateDetailRead = Record<string, unknown>

export type TemplateInstantiatePayload = {
  connector_name: string
  host?: string | null
  description?: string | null
  stream_name?: string | null
  credentials: Record<string, unknown>
  destination_id?: number | null
  create_route?: boolean
  redirect_to?: 'stream_runtime' | 'connector_detail'
}

export type TemplateInstantiateResponse = {
  template_id: string
  connector_id: number
  source_id: number
  stream_id: number
  mapping_id: number
  enrichment_id: number
  checkpoint_id: number
  route_id: number | null
  redirect_path: string
}

/** GET /retention/preview */
export type RetentionPreviewTableRow = {
  table: string
  rows_eligible: number
  oldest_row_timestamp: string | null
  retention_days: number
  cutoff_utc: string
  notes: Record<string, unknown>
}

export type RetentionPreviewResponse = {
  generated_at_utc: string
  policies: Record<string, number>
  tables: RetentionPreviewTableRow[]
}

/** GET /retention/status */
export type RetentionStatusResponse = {
  policies: Record<string, number>
  supplement_next_after_utc: string | null
  last_operational_retention_at: string | null
  last_audit: Record<string, unknown> | null
}

/** POST /retention/run */
export type RetentionRunOutcomeItem = {
  table: string
  status: string
  matched_count: number
  deleted_count: number
  retention_days: number
  cutoff_utc: string
  duration_ms: number
  message: string
  notes: Record<string, unknown>
}

export type RetentionRunResponse = {
  dry_run: boolean
  started_at_utc: string
  outcomes: RetentionRunOutcomeItem[]
}
