import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Info, Send } from 'lucide-react'
import { cn } from '../../lib/utils'
import { logsExplorerPath } from '../../config/nav-paths'
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

export type StreamRecentEventsPanelProps = {
  streamId: string
  backendStreamId: number | undefined
  recentLogs: RecentLogLine[]
  runHistory: RunHistoryRow[]
  logsHref: string
  variant?: 'default' | 'compact'
}

function compactEventIcon(message: string, level: string) {
  const m = message.toLowerCase()
  if (level === 'ERROR' || level === 'WARN' || m.includes('fail')) {
    return <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
  }
  if (m.includes('deliver') || m.includes('success')) {
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
  variant = 'default',
}: StreamRecentEventsPanelProps) {
  const [tab, setTab] = useState<RecentEventsTab>('events')
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null)

  // Actual IDs in the loaded runtime timeline sample only: never infer unseen Routes.
  const availableRouteIds = useMemo(() => [...new Set(
    recentLogs
      .map((log) => log.routeId)
      .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0),
  )].sort((a, b) => a - b), [recentLogs])
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
        Route (recent sample)
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
        Recent timeline sample only — for complete records, inspect scoped Logs.
      </p>
    </div>
  ) : null

  const tabs: { id: RecentEventsTab; label: string; count: number }[] = [
    { id: 'events', label: 'Recent events', count: recentLogs.length },
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
        <div className="hidden border-b border-slate-200/80 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-divider dark:text-gdc-muted sm:grid sm:grid-cols-[minmax(7rem,1fr)_minmax(0,1.5fr)_6rem] sm:gap-3">
          <span>Event</span>
          <span>Description</span>
          <span className="text-right">Time</span>
        </div>
        <ul className="flex-1 divide-y divide-slate-200/70 dark:divide-gdc-divider">
          {items.length === 0 ? (
            <li className="px-4 py-8 text-center text-[12px] text-slate-500 dark:text-gdc-muted">No recent events.</li>
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
                    <span className="shrink-0 sm:hidden">{compactEventIcon(log.message, log.level)}</span>
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
