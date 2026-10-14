/** Logs explorer row shape — mapped from runtime delivery_logs API responses. */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

export type PipelineTimelineKey = 'POLLING' | 'SOURCE' | 'PARSING' | 'MAPPING' | 'DELIVERY' | 'CHECKPOINT'

export type TimelineNodeStatus = 'complete' | 'failed' | 'pending'

export type LogExplorerRow = {
  id: string
  eventId: string
  requestId?: string
  timeIso: string
  level: LogLevel
  connector: string
  stream: string
  route: string
  pipelineStage?: string
  message: string
  durationMs: number
  worker?: string
  host?: string
  eventPreview?: Record<string, unknown>
  contextJson: Record<string, unknown>
  relatedEventId: string | null
}

export type BackendLogStage =
  | 'source_fetch'
  | 'source_rate_limit'
  | 'parse'
  | 'mapping'
  | 'enrichment'
  | 'format'
  | 'route'
  | 'syslog_send'
  | 'webhook_send'
  | 'checkpoint_update'
  | 'run_complete'
  | 'destination_rate_limited'
  | 'route_retry_failed'
  | 'route_retry_success'
  | string

export function getRequestId(row: LogExplorerRow): string {
  const fromRun =
    typeof row.contextJson.run_id === 'string' && row.contextJson.run_id.trim() !== '' ? row.contextJson.run_id : null
  return fromRun ?? row.requestId ?? row.eventId.replace(/^evt_/, 'req_')
}

export function getWorker(row: LogExplorerRow): string {
  return row.worker ?? '—'
}

export function getHost(row: LogExplorerRow): string {
  return row.host ?? '—'
}

export function getEventPreview(row: LogExplorerRow): Record<string, unknown> {
  if (row.eventPreview) return row.eventPreview
  const sample = row.contextJson.payload_sample
  if (sample && typeof sample === 'object' && !Array.isArray(sample)) return sample as Record<string, unknown>
  return {
    message: row.message,
    stage: row.contextJson.stage,
    status: row.contextJson.status,
    error_code: row.contextJson.error_code,
    stream_id: row.contextJson.stream_id,
    route_id: row.contextJson.route_id,
    destination_id: row.contextJson.destination_id,
  }
}

export function pipelineStageLabel(row: LogExplorerRow): string {
  if (row.pipelineStage) return row.pipelineStage
  const st = String(row.contextJson.stage ?? '').toLowerCase() as BackendLogStage
  if (!st) return '—'
  if (st.includes('retry')) return 'RETRY'
  if (st === 'source_fetch' || st === 'source_rate_limit') return 'SOURCE'
  if (st === 'parse') return 'PARSING'
  if (st === 'mapping' || st === 'enrichment') return 'MAPPING'
  if (
    st.startsWith('policy_') ||
    st === 'policy_evaluation_complete' ||
    st === 'classification_complete' ||
    st === 'protection_complete' ||
    st.startsWith('quarantine_event_') ||
    st.startsWith('schema_drift_policy')
  ) return 'GOVERNANCE'
  if (st === 'format' || st === 'route') return 'DELIVERY'
  if (st === 'syslog_send' || st === 'webhook_send' || st === 'destination_rate_limited') return 'DELIVERY'
  if (st === 'run_started' || st === 'checkpoint_update' || st === 'run_complete') return 'CHECKPOINT'
  return st.replace(/_/g, ' ').toUpperCase()
}

function timelineIndexFromBackendStage(stage: string): number {
  const s = stage.toLowerCase()
  if (s === 'source_fetch' || s === 'source_rate_limit') return 1
  if (s === 'parse') return 2
  if (s === 'mapping' || s === 'enrichment') return 3
  if (
    s.startsWith('policy_') ||
    s === 'policy_evaluation_complete' ||
    s === 'classification_complete' ||
    s === 'protection_complete' ||
    s.startsWith('quarantine_event_') ||
    s.startsWith('schema_drift_policy')
  ) return 3
  if (s === 'format' || s === 'route') return 4
  if (s === 'syslog_send' || s === 'webhook_send' || s === 'destination_rate_limited' || s.includes('retry')) return 4
  if (s === 'checkpoint_update' || s === 'run_complete') return 5
  return 4
}

const TIMELINE_KEYS: readonly PipelineTimelineKey[] = [
  'POLLING',
  'SOURCE',
  'PARSING',
  'MAPPING',
  'DELIVERY',
  'CHECKPOINT',
] as const

export function buildPipelineTimeline(
  row: LogExplorerRow,
): Array<{ key: PipelineTimelineKey; status: TimelineNodeStatus }> {
  const stage = String(row.contextJson.stage ?? '').toLowerCase()
  let failIdx: number | null = null
  if (row.level === 'ERROR') {
    if (stage === 'parse') failIdx = 2
    else if (stage === 'mapping' || stage === 'enrichment') failIdx = 3
    else if (stage === 'checkpoint_update') failIdx = 5
    else failIdx = 4
  }

  if (failIdx !== null) {
    return TIMELINE_KEYS.map((key, i) => {
      if (i < failIdx!) return { key, status: 'complete' }
      if (i === failIdx!) return { key, status: 'failed' }
      return { key, status: 'pending' }
    })
  }

  const through = timelineIndexFromBackendStage(stage)
  const allDone = stage === 'run_complete' || stage === 'checkpoint_update'

  return TIMELINE_KEYS.map((key, i) => {
    if (allDone) return { key, status: 'complete' }
    if (i <= through) return { key, status: 'complete' }
    return { key, status: 'pending' }
  })
}
