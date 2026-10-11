import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Info, Send } from 'lucide-react'
import { cn } from '../../lib/utils'
import { logsExplorerPath, runtimeAnalyticsPath } from '../../config/nav-paths'
import { toOperatorEventLabel } from '../../lib/stream-governance-snapshot'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import type { RecentLogLine, RunHistoryRow } from './stream-runtime-detail-model'

export type RecentEventsTab = 'events' | 'errors' | 'delivery'

const DELIVERY_EVENT_STAGES = new Set([
  'route_send_success',
  'route_send_failed',
  'route_retry_success',
  'route_retry_failed',
  'route_unknown_failure_policy',
  'route_skip',
  'destination_rate_limited',
  'dynamic_route_send_success',
  'dynamic_route_send_failed',
  'dynamic_route_send_skip',
  'dynamic_route_send_rate_limited',
  'dynamic_route_rate_limited',
  'dynamic_route_skip',
  'failover_route_attempt',
  'failover_route_send_success',
  'failover_route_send_failed',
])

function isDeliveryMessage(log: RecentLogLine): boolean {
  // Runtime stage is authoritative. Only older lines without stage use text inference.
  const stage = log.stage?.trim().toLowerCase()
  if (stage) return DELIVERY_EVENT_STAGES.has(stage)
  const m = log.message.toLowerCase()
  return m.includes('route') || m.includes('deliver') || m.includes('send') || m.includes('destination')
}

// Route-scoped runtime records are gateway-side observations, not a complete
// delivery-rate window, end-to-end receiver acknowledgment, or processing preview.
const RECORDED_GATEWAY_SUCCESSES = new Set([
  'route_send_success',
  'route_retry_success',
  'dynamic_route_send_success',
  'failover_route_send_success',
])
const RECORDED_GATEWAY_FAILURES = new Set([
  'route_send_failed',
  'route_retry_failed',
  'dynamic_route_send_failed',
  'failover_route_send_failed',
])

function SelectedRouteEvidence({
  routeId,
  recentLogs,
  backendStreamId,
  routeMetrics,
}: {
  routeId: number
  recentLogs: readonly RecentLogLine[]
  backendStreamId: number | undefined
  routeMetrics?: StreamRecentEventsPanelProps['routeMetrics']
}) {
  const stages = recentLogs
    .map((log) => log.stage?.trim().toLowerCase())
    .filter((stage): stage is string => Boolean(stage))
  const successful = stages.filter((stage) => RECORDED_GATEWAY_SUCCESSES.has(stage)).length
  const failed = stages.filter((stage) => RECORDED_GATEWAY_FAILURES.has(stage)).length
  const observedStages = [...new Set(stages)].slice(0, 4)
  const metricRow = routeMetrics?.find((row) => row.routeId === routeId)
  const recordedMetricsFailures = metricRow != null &&
    Number.isSafeInteger(metricRow.failedCount) && metricRow.failedCount >= 0
      ? metricRow.failedCount : null
  const destinations = [...new Set(
    recentLogs.map((log) => log.destinationId)
      .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0),
  )]
  const hasExactScope =
    Number.isSafeInteger(backendStreamId) && (backendStreamId ?? 0) > 0 &&
    Number.isSafeInteger(routeId) && routeId > 0
  const failureLogsHref = hasExactScope && (failed > 0 || (recordedMetricsFailures ?? 0) > 0)
    ? logsExplorerPath({ route_id: routeId, stream_id: backendStreamId, status: 'failed' })
    : null
  // The existing Analytics view makes a separate Route-filtered 24h API request.
  // This path does not present the currently loaded 12-event sample as history.
  const routeAnalyticsHref = hasExactScope
    ? runtimeAnalyticsPath({ window: '24h', stream_id: backendStreamId, route_id: routeId })
    : null

  return (
    <section
      aria-label="Selected Route evidence"
      data-testid="stream-selected-route-evidence"
      className="space-y-2 border-b border-slate-200/80 bg-slate-50/70 px-3 py-3 dark:border-gdc-border dark:bg-gdc-elevated/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Route #{routeId} — loaded runtime evidence</h4>
          <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
            {recentLogs.length} events in loaded sample · not a full-history health or delivery rate
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {failureLogsHref ? (
            <Link
              to={failureLogsHref}
              className="inline-flex min-h-9 items-center rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-red-800 hover:underline dark:border-red-500/35 dark:bg-gdc-card dark:text-red-200"
            >
              Inspect recorded Route failures
            </Link>
          ) : null}
          {routeAnalyticsHref ? (
            <Link
              to={routeAnalyticsHref}
              className="inline-flex min-h-9 items-center rounded-md border border-violet-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-violet-800 hover:underline dark:border-violet-500/35 dark:bg-gdc-card dark:text-violet-200"
            >
              Analyze Route failure trend (24h)
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
        <span>Gateway success records: {successful}</span>
        <span>Gateway failure records: {failed}</span>
        {destinations.length > 0 ? (
          <span>Observed {destinations.map((id) => `Destination #${id}`).join(', ')}</span>
        ) : (
          <span>Destination identity not verified in sample</span>
        )}
      </div>
      {successful + failed === 0 ? (
        <p className="text-[11px] font-medium text-slate-600 dark:text-gdc-muted">
          Gateway outcome not verified in this sample
        </p>
      ) : null}
      {metricRow ? (
        <div className="space-y-1 text-[11px] text-slate-600 dark:text-gdc-muted">
          <p>Last reported Route state: {metricRow.enabled ? 'Enabled' : 'Disabled'}</p>
          {recordedMetricsFailures != null ? (
            <p>Metrics-reported failed attempts: {recordedMetricsFailures}</p>
          ) : (
            <p>Metrics failure count not verified</p>
          )}
          {metricRow.destinationName?.trim() ? (
            <p>Destination {metricRow.destinationName}</p>
          ) : null}
          <p>Metrics is not proof of current receiver acknowledgment or complete live history.</p>
        </div>
      ) : null}
      {observedStages.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-slate-600 dark:text-gdc-muted">Observed stages:</span>
          {observedStages.map((stage) => (
            <code key={stage} className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] text-slate-700 dark:bg-gdc-card dark:text-gdc-mutedStrong">
              {stage}
            </code>
          ))}
        </div>
      ) : null}
      {routeAnalyticsHref ? (
        <p className="text-[10px] text-slate-600 dark:text-gdc-muted">
          Historical Analytics is loaded separately; this is a recent timeline sample.
        </p>
      ) : null}
      <p className="text-[10px] text-slate-600 dark:text-gdc-muted">
        Receiver acknowledgment not verified. Only actual runtime stage records count as gateway outcomes.
      </p>
    </section>
  )
}

export type StreamRecentEventsPanelProps = {
  streamId: string
  backendStreamId: number | undefined
  recentLogs: RecentLogLine[]
  runHistory: RunHistoryRow[]
  logsHref: string
  /** Actual numeric IDs from the already-loaded runtime Metrics route_health snapshot. */
  observedRouteIds?: readonly number[]
  /** Already loaded Metrics evidence, not a verified current receiver state. */
  routeMetrics?: readonly {
    routeId: number
    enabled: boolean
    failedCount: number
    destinationName?: string | null
  }[]
  variant?: 'default' | 'compact'
  /** Optional page-level shared scope for Overview → Events navigation. */
  selectedRouteId?: number | null
  onSelectedRouteIdChange?: (routeId: number | null) => void
}

function compactEventIcon(log: RecentLogLine) {
  // A free-text message is not evidence of successful delivery. Runtime stage wins.
  const stage = log.stage?.trim().toLowerCase()
  if (log.level === 'ERROR' || log.level === 'WARN' || (stage != null && RECORDED_GATEWAY_FAILURES.has(stage))) {
    return <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
  }
  if (stage != null && RECORDED_GATEWAY_SUCCESSES.has(stage)) {
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
  }
  return <Info className="h-4 w-4 text-sky-500" aria-hidden />
}

export function StreamRecentEventsPanel({
  streamId,
  backendStreamId,
  recentLogs,
  runHistory,
  logsHref,
  observedRouteIds,
  routeMetrics,
  variant = 'default',
  selectedRouteId: controlledRouteId,
  onSelectedRouteIdChange,
}: StreamRecentEventsPanelProps) {
  const [tab, setTab] = useState<RecentEventsTab>('events')
  const [localRouteId, setLocalRouteId] = useState<number | null>(null)
  const selectedRouteId = controlledRouteId === undefined ? localRouteId : controlledRouteId
  const setSelectedRouteId = onSelectedRouteIdChange ?? setLocalRouteId

  // Only IDs explicitly present in the loaded runtime timeline or Metrics snapshot.
  // A Metrics-only Route may have ZERO timeline events; absence is not evidence of health.
  const availableRouteIds = useMemo(() => [...new Set(
    [...recentLogs.map((log) => log.routeId), ...(observedRouteIds ?? []), ...(routeMetrics?.map((row) => row.routeId) ?? [])]
      .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0),
  )].sort((a, b) => a - b), [recentLogs, observedRouteIds, routeMetrics])
  const activeRouteId = selectedRouteId != null && availableRouteIds.includes(selectedRouteId)
    ? selectedRouteId : null
  const scopedLogs = useMemo(() =>
    activeRouteId == null ? recentLogs : recentLogs.filter((log) => log.routeId === activeRouteId),
  [recentLogs, activeRouteId])
  const errorLogs = useMemo(() => scopedLogs.filter((l) => l.level === 'ERROR' || l.level === 'WARN'), [scopedLogs])
  const deliveryLogs = useMemo(() => scopedLogs.filter(isDeliveryMessage), [scopedLogs])
  // A per-Stream Run count has no Route identity: do not attribute it to the selected Route.
  const deliveryRuns = useMemo(() =>
    activeRouteId == null ? runHistory.filter((r) => r.delivered > 0 || r.failed > 0) : [],
  [runHistory, activeRouteId])
  const scopedLogsHref = backendStreamId != null && activeRouteId != null
    ? logsExplorerPath({ stream_id: backendStreamId, route_id: activeRouteId })
    : logsHref
  const routeSampleFilter = availableRouteIds.length > 0 ? (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
      <label htmlFor="stream-recent-route-filter" className="text-[11px] font-semibold text-slate-700 dark:text-gdc-mutedStrong">
        Route (loaded runtime evidence)
      </label>
      <select
        id="stream-recent-route-filter"
        aria-label="Filter recent events by Route"
        value={activeRouteId == null ? 'all' : String(activeRouteId)}
        onChange={(event) => {
          const value = event.target.value
          setSelectedRouteId(value === 'all' ? null : Number(value))
        }}
        className="min-h-9 max-w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
      >
        <option value="all">All routes in sample</option>
        {availableRouteIds.map((routeId) => (
          <option key={routeId} value={routeId}>Route #{routeId}</option>
        ))}
      </select>
      <p className="w-full text-[10px] text-slate-500 dark:text-gdc-muted">
        Route IDs come from loaded timeline or Metrics. Outcomes are recent sample only; inspect scoped Logs for wider history.
      </p>
    </div>
  ) : null

  const tabs: { id: RecentEventsTab; label: string; count: number }[] = [
    { id: 'events', label: 'Recent events', count: scopedLogs.length },
    { id: 'errors', label: 'Recent errors', count: errorLogs.length },
    { id: 'delivery', label: 'Recent delivery', count: deliveryLogs.length + deliveryRuns.length },
  ]

  if (variant === 'compact') {
    const items = scopedLogs.slice(0, 6)
    return (
      <section
        aria-label="Recent events"
        data-testid="stream-recent-events-panel"
        className="flex min-h-[280px] flex-col rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recent Events</h3>
          <Link to={scopedLogsHref} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-400">
            View all →
          </Link>
        </div>
        {routeSampleFilter}
        {activeRouteId != null ? (
          <SelectedRouteEvidence
            routeId={activeRouteId}
            recentLogs={scopedLogs}
            backendStreamId={backendStreamId}
            routeMetrics={routeMetrics}
          />
        ) : null}
        <div className="hidden border-b border-slate-200/80 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-divider dark:text-gdc-muted sm:grid sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.5fr)_6rem] sm:gap-3">
          <span>Event</span>
          <span>Description</span>
          <span className="text-right">Time</span>
        </div>
        <ul className="flex-1 divide-y divide-slate-200/70 dark:divide-gdc-divider">
          {items.length === 0 ? (
            <li className="px-4 py-8 text-center text-[12px] text-slate-500 dark:text-gdc-muted">
              {activeRouteId != null
                ? `No Route #${activeRouteId} events in this timeline sample. Inspect scoped Logs for wider history.`
                : 'No recent events.'}
            </li>
          ) : (
            items.map((log, i) => {
              const eventName = toOperatorEventLabel(log.message)
              const description = log.rawMessage && log.rawMessage !== log.message ? log.rawMessage : log.message
              return (
                <li
                  key={`${log.at}-${i}`}
                  className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.5fr)_6rem] sm:items-start sm:gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="shrink-0 sm:hidden">{compactEventIcon(log)}</span>
                    <p className="truncate text-[12px] font-semibold text-slate-800 dark:text-slate-100">{eventName}</p>
                  </div>
                  <p className="truncate text-[11px] text-slate-500 dark:text-gdc-muted">{description}</p>
                  <p className="whitespace-nowrap text-[11px] tabular-nums text-slate-500 dark:text-gdc-muted sm:text-right">{log.at}</p>
                </li>
              )
            })
          )}
        </ul>
      </section>
    )
  }

  return (
    <section
      aria-label="Recent events"
      data-testid="stream-recent-events-panel"
      className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <div>
          <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Recent Events</h3>
          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">Latest pipeline activity from runtime timeline</p>
        </div>
        <Link
          to={scopedLogsHref}
          className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          View all logs
        </Link>
      </div>

      {routeSampleFilter}
      {activeRouteId != null ? (
        <SelectedRouteEvidence
            routeId={activeRouteId}
            recentLogs={scopedLogs}
            backendStreamId={backendStreamId}
            routeMetrics={routeMetrics}
          />
      ) : null}
      <div className="flex flex-wrap gap-1 border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold',
              tab === t.id
                ? 'bg-violet-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-gdc-elevated dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
            )}
          >
            {t.label}
            <span className="ml-1 tabular-nums opacity-80">({t.count})</span>
          </button>
        ))}
      </div>

      <div className="p-2">
        {tab === 'events' ? (
          <RecentLogsTable
            logs={scopedLogs.slice(0, 8)}
            streamId={streamId}
            backendStreamId={backendStreamId}
            emptyLabel={activeRouteId != null
              ? `No events for Route #${activeRouteId} in this timeline sample. Inspect scoped Logs for wider history.`
              : 'No recent events. Open logs explorer for a wider range.'}
          />
        ) : null}
        {tab === 'errors' ? (
          <RecentLogsTable
            logs={errorLogs.slice(0, 8)}
            streamId={streamId}
            backendStreamId={backendStreamId}
            emptyLabel={activeRouteId != null
              ? `No errors observed for Route #${activeRouteId} in this timeline sample.`
              : 'No errors in the recent timeline sample.'}
          />
        ) : null}
        {tab === 'delivery' ? (
          <div className="space-y-3">
            {deliveryRuns.length > 0 ? (
              <div>
                <p className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Runs</p>
                <div className="overflow-x-auto">
                  <table className={opTable}>
                    <thead>
                      <tr className={opThRow}>
                        <th className={opTh}>Run / Record</th>
                        <th className={opTh}>Started</th>
                        <th className={opTh}>Status</th>
                        <th className={opTh}>Delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveryRuns.slice(0, 5).map((row) => (
                        <tr key={row.runId} className={opTr}>
                          <td className={cn(opTd, 'font-mono text-[11px]')}>
                            {row.idBasis === 'completion-record' ? `Completion record ${row.runId}` : row.runId}
                          </td>
                          <td className={cn(opTd, 'whitespace-nowrap tabular-nums')}>{row.startedAt}</td>
                          <td className={opTd}>
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold">
                              {row.status === 'Success' ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                              ) : (
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
                              )}
                              {row.status}
                            </span>
                          </td>
                          <td className={cn(opTd, 'tabular-nums')}>{row.delivered.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <RecentLogsTable
              logs={deliveryLogs.slice(0, 8)}
              streamId={streamId}
              backendStreamId={backendStreamId}
              emptyLabel={deliveryRuns.length === 0
                ? activeRouteId != null
                  ? `No delivery events observed for Route #${activeRouteId} in this timeline sample.`
                  : 'No recent delivery events in timeline sample.'
                : undefined}
              showHeader={deliveryRuns.length > 0}
              headerLabel="Delivery logs"
            />
          </div>
        ) : null}
      </div>
    </section>
  )
}

function RecentLogsTable({
  logs,
  streamId,
  backendStreamId,
  emptyLabel,
  showHeader,
  headerLabel,
}: {
  logs: RecentLogLine[]
  streamId: string
  backendStreamId: number | undefined
  emptyLabel?: string
  showHeader?: boolean
  headerLabel?: string
}) {
  if (logs.length === 0 && emptyLabel) {
    return <p className="px-2 py-4 text-[11px] text-slate-500 dark:text-gdc-muted">{emptyLabel}</p>
  }
  if (logs.length === 0) return null

  return (
    <div>
      {showHeader && headerLabel ? (
        <p className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{headerLabel}</p>
      ) : null}
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Time</th>
              <th className={opTh}>Level</th>
              <th className={opTh}>Message</th>
              <th className={cn(opTh, 'text-right')}>Logs</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log, i) => {
              const logHref =
                backendStreamId != null
                  ? logsExplorerPath({
                      stream_id: backendStreamId,
                      route_id: log.routeId ?? undefined,
                      destination_id: log.destinationId ?? undefined,
                      // Logs Explorer recognizes a run filter only for a usable run identity.
                      run_id: log.runId?.trim() && log.runId.trim().length >= 8 ? log.runId : undefined,
                    })
                  : `/logs/${streamId}`
              return (
                <tr key={`${log.at}-${i}`} className={opTr}>
                  <td className={cn(opTd, 'whitespace-nowrap tabular-nums text-[11px]')}>{log.at}</td>
                  <td className={opTd}>
                    <span
                      className={cn(
                        'rounded px-1 py-px text-[9px] font-bold uppercase',
                        log.level === 'ERROR' && 'bg-red-500/10 text-red-800 dark:text-red-200',
                        log.level === 'WARN' && 'bg-amber-500/15 text-amber-900 dark:text-amber-200',
                        log.level === 'INFO' && 'bg-slate-100 text-slate-700 dark:bg-gdc-elevated dark:text-slate-200',
                      )}
                    >
                      {log.level}
                    </span>
                  </td>
                  <td className={cn(opTd, 'max-w-[280px] truncate text-[11px]')}>{log.message}</td>
                  <td className={cn(opTd, 'text-right')}>
                    <Link to={logHref} className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300">
                      <Send className="h-3 w-3" aria-hidden />
                      Open
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
