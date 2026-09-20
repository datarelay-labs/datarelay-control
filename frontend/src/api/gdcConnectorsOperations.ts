import {
  GDC_DEFAULT_READ_JSON_TIMEOUT_MS,
  requestJson,
  safeRequestJson,
} from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest } from './requestCache'

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const OPERATIONS_SUMMARY_CACHE_TTL_MS = 15_000
const OPERATIONS_SUMMARY_CACHE_NAMESPACE = 'connectors-operations-summary'

export function connectorOperationsSummaryRequestKey(window = '1h'): string {
  return window
}

export type AuthHealthCheckInterval = 'disabled' | '15m' | '1h' | '6h' | '24h'

export type ConnectorStreamOpsSummary = {
  stream_id: number
  stream_name: string
  status: string
  enabled: boolean
  health: 'healthy' | 'warning' | 'critical' | 'stopped'
  primary_issue: string | null
  events_1h: number
  last_success_at: string | null
  destination_count: number
}

export type ConnectorOperationsRow = {
  connector_id: number
  stream_count: number
  destination_count: number
  affected_stream_count: number
  affected_destination_count: number
  streams: ConnectorStreamOpsSummary[]
  streams_healthy_count: number
  streams_warning_count: number
  streams_critical_count: number
  streams_stopped_count: number
  stale_stream_count: number
  last_event_at: string | null
  last_event_at_active: string | null
  events_1h: number
  events_24h: number
  events_last_1h: number
  events_previous_1h: number
  event_trend_percent: number | null
  eps: number
  auth_health_check_interval: AuthHealthCheckInterval
  last_auth_check_at: string | null
  last_auth_check_status: 'success' | 'failed' | null
  last_auth_error: string | null
}

export type ConnectorOperationsSummaryResponse = {
  window: string
  generated_at: string | null
  connectors: ConnectorOperationsRow[]
}

export type ConnectorAuthCheckResponse = {
  success: boolean
  status_code: number | null
  message: string | null
  error_code: string | null
  last_auth_check_at: string
  last_auth_check_status: 'success' | 'failed'
  last_auth_error: string | null
  response_time_ms: number | null
}

async function fetchConnectorOperationsSummaryUncached(
  window = '1h',
  signal?: AbortSignal,
): Promise<ConnectorOperationsSummaryResponse | null> {
  const q = new URLSearchParams({ window })
  return safeRequestJson<ConnectorOperationsSummaryResponse>(
    `${GDC_API_PREFIX}/connectors/operations-summary?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, signal),
  )
}

export function fetchConnectorOperationsSummary(
  window = '1h',
  options?: GdcSignalOptions,
): Promise<ConnectorOperationsSummaryResponse | null> {
  const key = connectorOperationsSummaryRequestKey(window)
  return cachedRequest(
    OPERATIONS_SUMMARY_CACHE_NAMESPACE,
    key,
    (signal) => fetchConnectorOperationsSummaryUncached(window, signal),
    { ttlMs: OPERATIONS_SUMMARY_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function runConnectorAuthCheck(connectorId: number): Promise<ConnectorAuthCheckResponse> {
  return requestJson<ConnectorAuthCheckResponse>(`${GDC_API_PREFIX}/connectors/${connectorId}/auth-check`, {
    method: 'POST',
  })
}

export async function runConnectorQueryTest(connectorId: number): Promise<{ response_time_ms: number; message: string }> {
  const res = await runConnectorAuthCheck(connectorId)
  return {
    response_time_ms: res.response_time_ms ?? 0,
    message: res.success
      ? `Success${res.response_time_ms != null ? ` (${res.response_time_ms}ms)` : ''}`
      : res.last_auth_error ?? res.message ?? 'Query test failed',
  }
}
