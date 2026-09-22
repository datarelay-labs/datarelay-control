import { Activity, ArrowRight, ChevronRight, ClipboardCopy, Loader2, Radio, RotateCcw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchCheckpointTrace, fetchRuntimeLogTrace, replayDeliveryLog } from '../../api/gdcRuntime'
import type { CheckpointTraceResponse, DeliveryLogReplayResponse, RuntimeTraceResponse } from '../../api/types/gdcApi'
import {
  connectorDetailPath,
  destinationDetailPath,
  routeEditPath,
  runtimeOverviewPath,
  streamApiTestPath,
  streamEditPath,
  streamMappingPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import { resolveStreamRouteIdentifier } from '../../utils/streamWorkflow'
import { cn } from '../../lib/utils'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import {
  buildRetryTimelineEntries,
  deliveryStatusPresentation,
  formatLatencyMs,
  safeCtxInt,
  stageChipText,
} from './logs-console-helpers'
import { LevelBadge } from './logs-level-badge'
import { getEventPreview, getHost, getRequestId, getWorker, pipelineStageLabel, type LogExplorerRow } from './logs-types'

export type LogDetailTab = 'overview' | 'payload' | 'trace' | 'retry' | 'checkpoint'

function formatTableTime(iso: string) {
  return iso.slice(0, 23).replace('T', ' ')
}

function JsonSyntaxBlock({ json }: { json: Record<string, unknown> }) {
  const lines = useMemo(() => JSON.stringify(json, null, 2).split('\n'), [json])
  return (
    <pre className="max-h-[min(52vh,420px)] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100 shadow-inner dark:border-gdc-border">
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          {highlightJsonLine(line)}
        </div>
      ))}
    </pre>
  )
}

function highlightJsonLine(line: string) {
  const trimmed = line.trimStart()
  const indent = line.slice(0, line.length - trimmed.length)
  const keyMatch = trimmed.match(/^("([^"]+)":)\s*(.*)$/)
  if (keyMatch) {
    const [, fullKey, , rest] = keyMatch
    return (
      <>
        <span className="text-slate-500">{indent}</span>
        <span className="text-violet-400">{fullKey}</span>
        <span className="text-slate-600"> </span>
        {highlightJsonValue(rest)}
      </>
    )
  }
  return (
    <>
      <span className="text-slate-500">{indent}</span>
      <span className="text-slate-300">{trimmed}</span>
    </>
  )
}

function highlightJsonValue(rest: string) {
  const t = rest.trim()
  if (t === 'null') return <span className="text-slate-500">null</span>
  if (t === 'true' || t === 'false') return <span className="text-amber-400">{t}</span>
  if (/^-?\d+(\.\d+)?$/.test(t)) return <span className="text-sky-400">{t}</span>
  if (t.startsWith('"') && t.endsWith('"')) return <span className="text-emerald-400">{t}</span>
  if (t === '{' || t === '}' || t === '[' || t === ']') return <span className="text-slate-400">{t}</span>
  return <span className="text-slate-300">{rest}</span>
}

function traceSectionTitle(stage: string): string {
  const s = stage.toLowerCase()
  if (s === 'source_fetch') return 'Source Fetch'
  if (s === 'parse') return 'Parse'
  if (s === 'mapping') return 'Mapping'
  if (s === 'enrichment') return 'Enrichment'
  if (s === 'route') return 'Route Fan-out'
  if (
    s.startsWith('route_send') ||
    s.startsWith('route_retry') ||
    s === 'destination_rate_limited' ||
    s === 'route_skip' ||
    s === 'route_unknown_failure_policy'
  )
    return 'Destination Delivery'
  if (s === 'checkpoint_update') return 'Checkpoint Update'
  if (s === 'run_started') return 'Run Started'
  if (s === 'run_complete') return 'Run Complete'
  if (s === 'source_rate_limited') return 'Source Rate Limited'
  return stage.replace(/_/g, ' ')
}

function traceOutcomeBadge(level: string, status: string | null | undefined) {
  const lv = level.toUpperCase()
  const st = (status ?? '').toUpperCase()
  if (lv === 'ERROR' || st === 'FAILED') return { label: 'Failed', tone: 'danger' as const }
  if (lv === 'WARN' || st.includes('RATE')) return { label: 'Throttled', tone: 'warning' as const }
  if (st === 'SKIPPED') return { label: 'Skipped', tone: 'muted' as const }
  if (st.includes('RETRY')) return { label: 'Retry', tone: 'warning' as const }
  return { label: 'OK', tone: 'success' as const }
}

function toneDotClass(tone: 'success' | 'warning' | 'error' | 'neutral'): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-500'
    case 'warning':
      return 'bg-amber-500'
    case 'error':
      return 'bg-red-500'
    default:
      return 'bg-slate-400'
  }
}

function CheckpointRunPanel({ runId }: { runId: string | null }) {
  const [data, setData] = useState<CheckpointTraceResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (runId == null || runId.trim() === '') {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchCheckpointTrace(runId).then((res) => {
      if (cancelled) return
      setData(res)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [runId])

  if (runId == null || runId.trim() === '') {
    return <p className="text-[12px] text-slate-600">No run ID on this row — open a log from a committed stream run.</p>
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden />
        Loading checkpoint trace…
      </div>
    )
  }
  if (!data) {
    return <p className="text-[12px] text-slate-600">Checkpoint trace unavailable.</p>
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[108px_1fr] gap-x-3 gap-y-2 text-[12px]">
        <DetailDt>Checkpoint type</DetailDt>
        <DetailDd className="font-mono text-[11px]">{data.checkpoint_type ?? '—'}</DetailDd>
        <DetailDt>Update reason</DetailDt>
        <DetailDd>{data.update_reason ?? '—'}</DetailDd>
        <DetailDt>Processed</DetailDt>
        <DetailDd className="tabular-nums">{data.processed_events ?? '—'}</DetailDd>
        <DetailDt>Delivered</DetailDt>
        <DetailDd className="tabular-nums">{data.delivered_events ?? '—'}</DetailDd>
        <DetailDt>Failed</DetailDt>
        <DetailDd className="tabular-nums">{data.failed_events ?? '—'}</DetailDd>
        <DetailDt>Partial success</DetailDt>
        <DetailDd>{data.partial_success === true ? 'Yes' : data.partial_success === false ? 'No' : '—'}</DetailDd>
        <DetailDt>Retry pending</DetailDt>
        <DetailDd>{data.retry_pending === true ? 'Yes' : data.retry_pending === false ? 'No' : '—'}</DetailDd>
      </dl>
      {data.correlated_route_failures.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/80 p-2 text-[11px] dark:border-amber-900/60 dark:bg-amber-950/30">
          <p className="font-semibold text-amber-950 dark:text-amber-200">Correlated route failures</p>
          <ul className="mt-1 space-y-1">
            {data.correlated_route_failures.map((f) => (
              <li key={`${f.route_id}-${f.created_at}`} className="text-amber-950 dark:text-amber-100">
                Route #{f.route_id}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Checkpoint timeline</p>
        <ol className="relative mt-2 space-y-0 border-l border-slate-200 pl-4 dark:border-gdc-border">
          {data.timeline_events.map((e) => (
            <li key={`${e.kind}-${e.log_id ?? e.title}-${e.created_at ?? ''}`} className="relative pb-5 last:pb-0">
              <span
                className={cn(
                  'absolute -left-[21px] top-1.5 flex h-3 w-3 rounded-full border-2 border-white dark:border-slate-950',
                  toneDotClass(e.tone),
                )}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{e.title}</span>
                <span className="font-mono text-[9px] text-slate-500">{e.kind}</span>
              </div>
              {e.detail ? <p className="mt-1 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">{e.detail}</p> : null}
              {e.created_at ? <p className="mt-0.5 font-mono text-[9px] text-slate-400">{e.created_at}</p> : null}
            </li>
          ))}
        </ol>
      </div>
      <div className="grid gap-2 lg:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Checkpoint before</p>
          <pre className="mt-1 max-h-[28vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-2 font-mono text-[10px] text-slate-100">
            {JSON.stringify(data.checkpoint_before ?? {}, null, 2)}
          </pre>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Checkpoint after</p>
          <pre className="mt-1 max-h-[28vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-2 font-mono text-[10px] text-slate-100">
            {JSON.stringify(data.checkpoint_after ?? {}, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  )
}

function LogExecutionTracePanel({ logDbId, highlightLogId }: { logDbId: number | null; highlightLogId: number | null }) {
  const [data, setData] = useState<RuntimeTraceResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (logDbId == null) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void fetchRuntimeLogTrace(logDbId).then((res) => {
      if (cancelled) return
      setData(res)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [logDbId])

  if (logDbId == null) {
    return <p className="text-[12px] leading-relaxed text-slate-600">Open a row loaded from the Runtime API to load an execution trace.</p>
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden />
        Loading trace…
      </div>
    )
  }
  if (!data?.timeline?.length) {
    return <p className="text-[12px] text-slate-600">No trace data available for this log.</p>
  }

  return (
    <div className="space-y-4">
      {data.stream ? (
        <p className="text-[11px] text-slate-600">
          Stream <span className="font-semibold text-slate-900">{data.stream.name}</span>
          {data.connector ? (
            <>
              {' '}
              · Connector <span className="font-semibold text-slate-900">{data.connector.name}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {data.run_id ? (
        <p className="font-mono text-[10px] text-slate-600">
          run_id: <span className="select-all text-slate-900">{data.run_id}</span>
        </p>
      ) : (
        <p className="text-[11px] text-amber-800">This log predates run correlation; showing a single-row trace.</p>
      )}
      <ol className="relative space-y-0 border-l border-slate-200 pl-4 dark:border-gdc-border">
        {data.timeline.map((e) => {
          const sec = traceSectionTitle(e.stage)
          const badge = traceOutcomeBadge(e.level, e.status)
          const st = deliveryStatusPresentation(e.status)
          const selected = highlightLogId != null && e.id === highlightLogId
          return (
            <li
              key={e.id}
              className={cn(
                'relative pb-6 last:pb-0',
                selected && 'rounded-md border border-violet-300 bg-violet-50/90 py-2 pl-3 -ml-3 dark:border-violet-800 dark:bg-violet-950/40',
              )}
            >
              <span className="absolute -left-[21px] top-1.5 flex h-3 w-3 rounded-full border-2 border-white bg-violet-500 dark:border-slate-950" />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{sec}</span>
                <span
                  className={cn(
                    'inline-flex rounded border px-1.5 py-px text-[9px] font-bold uppercase',
                    badge.tone === 'success' && 'border-emerald-300/80 bg-emerald-500/[0.08] text-emerald-900',
                    badge.tone === 'warning' && 'border-amber-300/80 bg-amber-500/[0.1] text-amber-950',
                    badge.tone === 'danger' && 'border-red-300/80 bg-red-500/[0.08] text-red-900',
                    badge.tone === 'muted' && 'border-slate-200 bg-slate-50 text-slate-700',
                  )}
                >
                  {badge.label}
                </span>
                <span className="font-mono text-[10px] text-slate-500">{e.stage}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-slate-800">{e.message}</p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-600">
                {e.route_id != null ? <span>Route #{e.route_id}</span> : null}
                {e.destination_id != null ? <span>Destination #{e.destination_id}</span> : null}
                {e.latency_ms != null ? <span className="tabular-nums">Latency {formatLatencyMs(e.latency_ms)}</span> : null}
                {e.retry_count > 0 ? <span className="tabular-nums font-semibold text-amber-800">Retries {e.retry_count}</span> : null}
                <span className={cn('tabular-nums uppercase', st.tone === 'danger' && 'text-red-700')}>{st.label}</span>
              </div>
              <p className="mt-1 font-mono text-[9px] text-slate-400">{e.created_at}</p>
            </li>
          )
        })}
      </ol>
      {data.checkpoint ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
          <p className="font-semibold text-slate-800 dark:text-slate-100">Checkpoint</p>
          <p className="text-slate-600 dark:text-gdc-muted">{data.checkpoint.message ?? '—'}</p>
          {data.checkpoint.checkpoint_type ? (
            <p className="mt-1 font-mono text-[10px] text-slate-500">Type {data.checkpoint.checkpoint_type}</p>
          ) : null}
          {data.checkpoint.update_reason ? (
            <p className="mt-1 text-slate-700 dark:text-gdc-mutedStrong">Reason: {data.checkpoint.update_reason}</p>
          ) : null}
          {data.checkpoint.partial_success === true ? (
            <p className="mt-1 font-semibold text-amber-800 dark:text-amber-300">Partial success boundary — review route failures.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DetailDt({ children }: { children: ReactNode }) {
  return <dt className="text-slate-500 dark:text-gdc-muted">{children}</dt>
}

function DetailDd({ children, className }: { children: ReactNode; className?: string }) {
  return <dd className={cn('min-w-0 text-slate-900 dark:text-slate-100', className)}>{children}</dd>
}

function StreamDrilldownLinks({ streamName }: { streamName: string }) {
  const trimmed = (streamName ?? '').trim()
  if (!trimmed) return <span className="text-slate-500 dark:text-gdc-muted">—</span>
  const { id, slug } = resolveStreamRouteIdentifier(trimmed)
  const target = id != null ? String(id) : slug
  const runtimeHref = id != null ? runtimeOverviewPath({ stream_id: id }) : streamRuntimePath(target)
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-slate-800 dark:text-slate-200">{trimmed}</span>
      <Link
        to={runtimeHref}
        className="inline-flex items-center gap-1 rounded-md border border-slate-900 bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white hover:bg-slate-800 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        data-testid="log-detail-stream-runtime"
      >
        Runtime
      </Link>
      <Link
        to={streamEditPath(target)}
        className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-gdc-muted dark:hover:text-slate-200"
        data-testid="log-detail-stream-edit"
      >
        Edit
      </Link>
    </span>
  )
}

function buildLogDiagnosisSummary(row: LogExplorerRow, statusLabel: string, stage: string, retryCount: number): string {
  if (row.level === 'ERROR') {
    const code =
      typeof row.contextJson.error_code === 'string' && row.contextJson.error_code.trim() !== ''
        ? row.contextJson.error_code.trim()
        : null
    return [
      `ERROR at ${stage || 'unknown stage'}`,
      statusLabel !== '—' ? `status ${statusLabel}` : null,
      code ? `code ${code}` : null,
      retryCount > 0 ? `${retryCount} retr${retryCount === 1 ? 'y' : 'ies'}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (row.level === 'WARN') {
    return `Warning at ${stage || 'unknown stage'} · ${statusLabel}`
  }
  return `${row.level} · ${stage || 'lifecycle'} · ${statusLabel}`
}

export function LogDetailDrawer({
  row,
  onClose,
  initialTab = 'overview',
}: {
  row: LogExplorerRow
  onClose: () => void
  initialTab?: LogDetailTab
}) {
  const [tab, setTab] = useState<LogDetailTab>(initialTab)
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayResult, setReplayResult] = useState<DeliveryLogReplayResponse | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [liveReplayConfirmOpen, setLiveReplayConfirmOpen] = useState(false)
  const preview = useMemo(() => getEventPreview(row), [row])
  const payloadObject = useMemo(() => {
    const base: Record<string, unknown> = { ...row.contextJson }
    base.message = row.message
    base.level = row.level
    base.stream = row.stream
    base.route = row.route
    base.connector = row.connector
    return base
  }, [row])

  const statusUi = deliveryStatusPresentation(typeof row.contextJson.status === 'string' ? row.contextJson.status : null)
  const httpStatus = safeCtxInt(row.contextJson, 'http_status')
  const retryCount = safeCtxInt(row.contextJson, 'retry_count') ?? 0
  const logDbId = safeCtxInt(row.contextJson, 'log_db_id')
  const latencySource = safeCtxInt(row.contextJson, 'latency_ms')
  const latencyMs = latencySource != null && latencySource >= 0 ? latencySource : row.durationMs

  const routeId = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
  const destId = typeof row.contextJson.destination_id === 'number' ? row.contextJson.destination_id : null
  const connId = typeof row.contextJson.connector_id === 'number' ? row.contextJson.connector_id : null

  const { id: streamResolveId, slug: streamSlug } = resolveStreamRouteIdentifier(row.stream)
  const streamTarget = streamResolveId != null ? String(streamResolveId) : streamSlug

  const runtimeHref = useMemo(() => {
    const ctxSid = typeof row.contextJson.stream_id === 'number' ? row.contextJson.stream_id : null
    const ctxRid = typeof row.contextJson.route_id === 'number' ? row.contextJson.route_id : null
    const ctxDid = typeof row.contextJson.destination_id === 'number' ? row.contextJson.destination_id : null
    const ctxRun = typeof row.contextJson.run_id === 'string' && row.contextJson.run_id.trim() !== '' ? row.contextJson.run_id : null
    if (ctxSid != null) {
      return runtimeOverviewPath({
        stream_id: ctxSid,
        route_id: ctxRid ?? undefined,
        destination_id: ctxDid ?? undefined,
        run_id: ctxRun ?? undefined,
      })
    }
    return streamTarget ? streamRuntimePath(streamTarget) : '/runtime'
  }, [row.contextJson, streamTarget])

  function copy(text: string) {
    void navigator.clipboard?.writeText(text)
  }

  const retryEntries = useMemo(() => buildRetryTimelineEntries(row), [row])

  const runIdStr = typeof row.contextJson.run_id === 'string' && row.contextJson.run_id.trim() !== '' ? row.contextJson.run_id : null

  const stageRaw = String(row.contextJson.stage ?? '').toLowerCase()
  const replayEligible =
    logDbId != null &&
    row.level === 'ERROR' &&
    (stageRaw === 'route_send_failed' || stageRaw === 'route_retry_failed')

  async function runReplay(dryRun: boolean) {
    if (logDbId == null) return
    setReplayBusy(true)
    setReplayError(null)
    setReplayResult(null)
    try {
      const res = await replayDeliveryLog(logDbId, { dry_run: dryRun })
      setReplayResult(res)
      if (!dryRun) setLiveReplayConfirmOpen(false)
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Replay request failed'
      setReplayError(msg)
    } finally {
      setReplayBusy(false)
    }
  }

  const tabs: { id: LogDetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'payload', label: 'Payload' },
    { id: 'trace', label: 'Trace' },
    { id: 'retry', label: 'Retry Timeline' },
    { id: 'checkpoint', label: 'Checkpoint' },
  ]

  return (
    <>
      <div
        className="flex items-start justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-gdc-border dark:bg-gdc-elevated"
        data-testid="log-detail-drawer"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Log detail</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-card"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <LevelBadge level={row.level} />
            <span className="font-mono text-xs text-slate-600 dark:text-gdc-muted">{formatTableTime(row.timeIso)}</span>
            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-px font-mono text-[11px] text-slate-700 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-200">
              {getRequestId(row)}
            </span>
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto border-b border-slate-100 pb-0 dark:border-gdc-border/80" role="tablist" aria-label="Log detail tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`log-detail-tab-${t.id}`}
                className={cn(
                  '-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-sm font-semibold transition-colors',
                  tab === t.id
                    ? 'border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-50'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-gdc-muted dark:hover:text-slate-200',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {tab === 'overview' ? (
          <>
            <section
              className={cn(
                'rounded-xl border px-4 py-3',
                row.level === 'ERROR' && 'border-red-200 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/30',
                row.level === 'WARN' && 'border-amber-200 bg-amber-50/70 dark:border-amber-900/45 dark:bg-amber-950/25',
                row.level !== 'ERROR' && row.level !== 'WARN' && 'border-slate-200 bg-slate-50/80 dark:border-gdc-border dark:bg-gdc-card',
              )}
              data-testid="log-detail-diagnosis"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Diagnosis</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                {buildLogDiagnosisSummary(row, statusUi.label, stageChipText(row), retryCount)}
              </p>
              <p className="mt-1 text-sm leading-snug text-slate-700 dark:text-slate-200">{row.message}</p>
              {replayEligible ? (
                <p className="mt-2 text-xs text-slate-600 dark:text-gdc-muted">
                  Recovery available: dry-run or live delivery replay (checkpoints are not updated).
                </p>
              ) : null}
            </section>

            <dl className="grid grid-cols-[104px_1fr] gap-x-3 gap-y-2.5 text-sm">
              <DetailDt>Stage</DetailDt>
              <DetailDd>
                <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-input dark:text-slate-200">
                  {stageChipText(row)}
                </span>
              </DetailDd>
              <DetailDt>Status</DetailDt>
              <DetailDd>
                <span
                  className={cn(
                    'inline-flex rounded-md border px-1.5 py-px text-[11px] font-bold uppercase',
                    statusUi.tone === 'success' &&
                      'border-emerald-300/80 bg-emerald-500/[0.09] text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100',
                    statusUi.tone === 'warning' &&
                      'border-amber-300/80 bg-amber-500/[0.12] text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/25 dark:text-amber-100',
                    statusUi.tone === 'danger' &&
                      'border-red-300/80 bg-red-500/[0.1] text-red-900 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-100',
                    statusUi.tone === 'muted' &&
                      'border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                  )}
                >
                  {statusUi.label}
                </span>
              </DetailDd>
              <DetailDt>Connector</DetailDt>
              <DetailDd className="font-medium">{row.connector}</DetailDd>
              <DetailDt>Stream</DetailDt>
              <DetailDd>
                <StreamDrilldownLinks streamName={row.stream} />
              </DetailDd>
              <DetailDt>Route</DetailDt>
              <DetailDd>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-slate-800 dark:text-slate-200">{row.route}</span>
                  {routeId != null ? (
                    <Link
                      to={routeEditPath(String(routeId))}
                      className="inline-flex items-center gap-0.5 text-xs font-semibold text-slate-600 underline-offset-2 hover:underline dark:text-gdc-muted"
                    >
                      #{routeId}
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  ) : null}
                </div>
              </DetailDd>
              <DetailDt>Destination</DetailDt>
              <DetailDd>
                {destId != null ? (
                  <Link
                    to={destinationDetailPath(String(destId))}
                    className="text-sm font-semibold text-slate-800 underline-offset-2 hover:underline dark:text-slate-100"
                  >
                    Open destination #{destId}
                  </Link>
                ) : (
                  <span className="text-slate-600 dark:text-gdc-muted">—</span>
                )}
              </DetailDd>
              <DetailDt>Latency</DetailDt>
              <DetailDd className="tabular-nums">{formatLatencyMs(latencyMs)}</DetailDd>
              <DetailDt>Retry count</DetailDt>
              <DetailDd className={cn('tabular-nums', retryCount > 0 && 'font-semibold text-red-700 dark:text-red-400')}>
                {retryCount}
              </DetailDd>
              <DetailDt>HTTP status</DetailDt>
              <DetailDd className="tabular-nums">{httpStatus != null ? String(httpStatus) : '—'}</DetailDd>
              <DetailDt>Error code</DetailDt>
              <DetailDd className="font-mono text-xs">
                {typeof row.contextJson.error_code === 'string' && row.contextJson.error_code.trim() !== ''
                  ? row.contextJson.error_code
                  : '—'}
              </DetailDd>
              <DetailDt>Event ID</DetailDt>
              <DetailDd className="font-mono text-xs">{row.eventId}</DetailDd>
              <DetailDt>Log ID</DetailDt>
              <DetailDd className="font-mono text-xs">{logDbId != null ? String(logDbId) : row.id}</DetailDd>
            </dl>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Payload sample</p>
              <div className="mt-2 space-y-2">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => copy(JSON.stringify(preview, null, 2))}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-input"
                  >
                    <ClipboardCopy className="h-3.5 w-3.5" />
                    Copy JSON
                  </button>
                </div>
                <JsonSyntaxBlock json={preview} />
              </div>
            </div>
          </>
        ) : null}

        {tab === 'payload' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Structured context</p>
              <button
                type="button"
                onClick={() => copy(JSON.stringify(payloadObject, null, 2))}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-input"
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                Copy JSON
              </button>
            </div>
            <JsonSyntaxBlock json={payloadObject} />
          </div>
        ) : null}

        {tab === 'trace' ? <LogExecutionTracePanel logDbId={logDbId} highlightLogId={logDbId} /> : null}

        {tab === 'checkpoint' ? <CheckpointRunPanel runId={runIdStr} /> : null}

        {tab === 'retry' ? (
          <div className="space-y-3">
            {retryEntries.length === 0 ? (
              <p className="text-[12px] text-slate-600 dark:text-gdc-muted">No retries recorded for this log row.</p>
            ) : (
              <ul className="space-y-2">
                {retryEntries.map((e) => (
                  <li
                    key={e.attempt}
                    className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 text-[12px] dark:border-gdc-border dark:bg-gdc-input/80"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-50">Attempt {e.attempt}</span>
                      <span className="font-mono text-[10px] text-slate-600 dark:text-gdc-muted">{e.atLabel}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-600 dark:text-gdc-muted">
                      <span>Backoff: {e.backoffLabel}</span>
                      <span className="capitalize">Outcome: {e.outcome}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <div
        className="space-y-2 border-t border-slate-200 bg-slate-50/80 p-4 dark:border-gdc-border dark:bg-gdc-panel/80"
        data-testid="log-detail-recovery"
      >
        {replayEligible ? (
          <div
            className="mb-3 space-y-2 rounded-lg border border-slate-300 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
            data-testid="log-detail-replay-panel"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-gdc-muted">Recovery · delivery replay</p>
            <p className="text-sm leading-snug text-slate-700 dark:text-slate-200">
              Re-send events from this failed delivery log. Checkpoints are not updated.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={replayBusy}
                onClick={() => void runReplay(true)}
                data-testid="delivery-log-dry-run-replay"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
              >
                {replayBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                Dry-run replay
              </button>
              <button
                type="button"
                disabled={replayBusy}
                onClick={() => {
                  setReplayError(null)
                  setLiveReplayConfirmOpen(true)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                data-testid="delivery-log-live-replay-open"
              >
                {replayBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                Replay delivery
              </button>
            </div>
            {replayError ? (
              <p className="text-sm font-medium text-red-800 dark:text-red-300">{replayError}</p>
            ) : null}
            {replayResult ? (
              <div className="rounded-md border border-slate-200 bg-slate-50/90 p-2 text-sm dark:border-gdc-border dark:bg-gdc-panel">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  {replayResult.outcome === 'dry_run_ok'
                    ? 'Dry-run OK'
                    : replayResult.outcome === 'delivered'
                      ? 'Delivered'
                      : 'Replay failed'}
                </p>
                <p className="mt-1 text-slate-700 dark:text-gdc-mutedStrong">{replayResult.message}</p>
                <p className="mt-1 tabular-nums text-slate-600 dark:text-gdc-muted">
                  Events: {replayResult.event_count}
                  {replayResult.preview_message_count != null
                    ? ` · Preview messages: ${replayResult.preview_message_count}`
                    : null}
                  {replayResult.replay_run_id ? ` · run ${replayResult.replay_run_id.slice(0, 8)}…` : null}
                </p>
                {replayResult.preview_messages != null && replayResult.preview_messages.length > 0 ? (
                  <pre className="mt-2 max-h-[140px] overflow-auto rounded border border-slate-200 bg-slate-950 p-2 font-mono text-[10px] text-slate-100">
                    {JSON.stringify(replayResult.preview_messages.slice(0, 3), null, 2)}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Context</p>
        <div className="flex flex-col gap-1.5">
          <Link
            to={runtimeHref}
            onClick={onClose}
            data-testid="log-detail-open-runtime"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-900 bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            <Activity className="h-4 w-4" aria-hidden />
            Open Runtime
            <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-70" aria-hidden />
          </Link>
          {routeId != null ? (
            <Link
              to={routeEditPath(String(routeId))}
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-input"
            >
              <ChevronRight className="h-4 w-4 text-slate-500" aria-hidden />
              Open Route
              <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-400 dark:text-gdc-muted" aria-hidden />
            </Link>
          ) : null}
          {destId != null ? (
            <Link
              to={destinationDetailPath(String(destId))}
              onClick={onClose}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-input"
            >
              <Radio className="h-4 w-4 text-slate-500" aria-hidden />
              Open Destination
              <ArrowRight className="ml-auto h-3.5 w-3.5 text-slate-400 dark:text-gdc-muted" aria-hidden />
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setTab('trace')}
            className="inline-flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            <Activity className="h-4 w-4 text-slate-500" aria-hidden />
            View Trace
          </button>
        </div>
        {streamTarget ? (
          <div className="mt-2 flex flex-wrap gap-2 border-t border-slate-200/80 pt-3 dark:border-gdc-border/80">
            <Link
              to={streamEditPath(streamTarget)}
              onClick={onClose}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-gdc-muted"
            >
              Edit workflow
            </Link>
            <span className="text-slate-300 dark:text-gdc-muted">·</span>
            <Link
              to={streamApiTestPath(streamTarget)}
              onClick={onClose}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-gdc-muted"
            >
              API test
            </Link>
            <span className="text-slate-300">·</span>
            <Link
              to={streamMappingPath(streamTarget)}
              onClick={onClose}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-gdc-muted"
            >
              Mapping
            </Link>
            {connId != null ? (
              <>
                <span className="text-slate-300">·</span>
                <Link
                  to={connectorDetailPath(String(connId))}
                  onClick={onClose}
                  className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-gdc-muted"
                >
                  Connector #{connId}
                </Link>
              </>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-slate-500">
          Worker {getWorker(row)} · Host {getHost(row)} · Summary stage {pipelineStageLabel(row)}
        </p>
      </div>

      {liveReplayConfirmOpen ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && !replayBusy) {
              setLiveReplayConfirmOpen(false)
            }
          }}
          title="Replay failed delivery live?"
          targetName={logDbId != null ? `delivery log #${logDbId}` : undefined}
          risk="high"
          impactBullets={[
            'Re-sends events from this failed delivery log to the destination.',
            'Production checkpoint is not updated by this action.',
            'Duplicate downstream delivery is possible; platform deduplication is not assumed.',
          ]}
          reversibility="Live replay cannot be undone. Prefer dry-run first when unsure."
          primaryLabel="Replay delivery"
          busy={replayBusy}
          error={replayError}
          onConfirm={() => void runReplay(false)}
          dataTestId="delivery-log-live-replay-dialog"
        />
      ) : null}
    </>
  )
}
