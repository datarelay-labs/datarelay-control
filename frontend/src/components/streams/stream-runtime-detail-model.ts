/**
 * View-model types and empty shell for stream runtime inspector layout.
 * Live values are merged from runtime APIs when available.
 */

import type { StreamRuntimeStatus } from '../../api/streamRows'

export type RuntimeHistoryTab =
  | 'runHistory'
  | 'delivery'
  | 'checkpoint'
  | 'routes'
  | 'logs'
  | 'errors'
  | 'metrics'
  | 'configuration'

export type RunHistoryRow = {
  runId: string
  startedAt: string
  duration: string
  status: 'Success' | 'Failed' | 'Partial'
  events: number
  delivered: number
  failed: number
}

export type RecentLogLine = {
  at: string
  level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR'
  message: string
  /** Original pipeline message when operator label differs. */
  rawMessage?: string
  errorCode?: string | null
  stage?: string
  duration: string
}

export type RouteHealthRow = {
  routeId?: number
  destinationId?: number
  destination: string
  typeLabel: string
  status: 'Healthy' | 'Degraded' | 'Error' | 'Unknown'
  deliveryPct: number
  latencyP95Ms: number
  failed1h: number
  lastError: string | null
  latencyTrend: readonly number[]
}

export type EventsOverTimeBucket = {
  bucket: string
  ingested: number
  mapped: number
  delivered: number
  failed: number
}

export type EventsBreakdownSlice = {
  key: string
  label: string
  value: number
  color: string
}

export type StreamHealthSignal = {
  label: string
  value: string
  detail?: string
  tone?: 'ok' | 'warn' | 'err' | 'neutral'
  sparkline?: readonly number[]
}

export type StreamRuntimeDetailView = {
  streamId: string
  name: string
  connectorName: string
  sourceTypeLabel: string
  pollingIntervalSec: number
  status: StreamRuntimeStatus
  lastUpdatedRelative: string
  statusSinceDisplay: string
  statusUptimeLabel: string
  events1h: number
  eventsPerMinApprox: number
  deliveryPct: number
  deliveryLabel: string
  latencyP95Ms: number
  latencyP50Ms: number
  latencyP99Label: string
  latencyTrend: readonly number[]
  lastCheckpointDisplay: string
  lastCheckpointRelative: string
  checkpointLagLabel: string
  routesTotal: number
  routesOk: number
  routesWarn: number
  routesErr: number
  eventsOverTime: readonly EventsOverTimeBucket[]
  eventsBreakdown: readonly EventsBreakdownSlice[]
  streamHealthSignals: readonly StreamHealthSignal[]
  runHistory: readonly RunHistoryRow[]
  recentLogs: readonly RecentLogLine[]
  routeHealth: readonly RouteHealthRow[]
}

const FLAT_LATENCY = [0, 0, 0, 0, 0, 0, 0] as const

/** Labels align with mergeStreamHealthSignals in runtimeHealthAdapter. */
const NEUTRAL_HEALTH_SIGNALS: readonly StreamHealthSignal[] = [
  { label: 'Source Connectivity', value: '—', tone: 'neutral' },
  { label: 'Polling', value: '—', tone: 'neutral' },
  { label: 'Rate Limit', value: '—', tone: 'neutral' },
  { label: 'Error Rate (1h)', value: '—', tone: 'neutral' },
  { label: 'Successive Failures', value: '—', tone: 'neutral' },
  { label: 'Backoff State', value: '—', tone: 'neutral' },
]

/** Empty shell before runtime API hydration. */
export function emptyStreamRuntimeDetail(streamId: string): StreamRuntimeDetailView {
  const title = /^\d+$/.test(streamId) ? `Stream ${streamId}` : streamId
  return {
    streamId,
    name: title,
    connectorName: '—',
    sourceTypeLabel: '—',
    pollingIntervalSec: 0,
    status: 'UNKNOWN',
    lastUpdatedRelative: '—',
    statusSinceDisplay: '—',
    statusUptimeLabel: '—',
    events1h: 0,
    eventsPerMinApprox: 0,
    deliveryPct: 0,
    deliveryLabel: '—',
    latencyP95Ms: 0,
    latencyP50Ms: 0,
    latencyP99Label: '—',
    latencyTrend: FLAT_LATENCY,
    lastCheckpointDisplay: '—',
    lastCheckpointRelative: '—',
    checkpointLagLabel: '—',
    routesTotal: 0,
    routesOk: 0,
    routesWarn: 0,
    routesErr: 0,
    eventsOverTime: [],
    eventsBreakdown: [],
    streamHealthSignals: NEUTRAL_HEALTH_SIGNALS,
    runHistory: [],
    recentLogs: [],
    routeHealth: [],
  }
}
