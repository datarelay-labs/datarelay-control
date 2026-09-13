import { Loader2, Server, TestTube2, Webhook } from 'lucide-react'
import { useCallback, useMemo, useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { testDestination } from '../../api/gdcDestinations'
import { destinationDetailPath, logsPath, routeEditPath } from '../../config/nav-paths'
import { formatThroughputEps } from '../../lib/observability-format'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { StatusBadge } from '../shell/status-badge'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import type {
  RecentRouteErrorItem,
  RouteRuntimeConnectivityState,
  RouteRuntimeMetricsRow,
  StreamMetricsRouteHealthRow,
  StreamRuntimeMetricsResponse,
} from '../../api/types/gdcApi'

function MiniSparkline({ values, className }: { values: readonly number[]; className?: string }) {
  const w = 44
  const h = 14
  const padX = 1
  const padY = 1
  const nums = values.length ? [...values] : [0]
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const range = max - min || 1
  const innerW = w - padX * 2
  const innerH = h - padY * 2
  const pts = nums.map((v, i) => {
    const x = padX + (i / Math.max(nums.length - 1, 1)) * innerW
    const y = padY + (1 - (v - min) / range) * innerH
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={cn('shrink-0 text-violet-600 dark:text-violet-400', className)}
      aria-hidden
    >
      <polyline fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" points={pts.join(' ')} />
    </svg>
  )
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 19).replace('T', ' ')
}

function connectivityTone(s: RouteRuntimeConnectivityState): 'success' | 'warning' | 'error' | 'neutral' {
  switch (s) {
    case 'HEALTHY':
      return 'success'
    case 'DEGRADED':
      return 'warning'
    case 'ERROR':
      return 'error'
    case 'DISABLED':
      return 'neutral'
    default:
      return 'neutral'
  }
}

/** Prefer expanded API row; fall back to legacy route_health for older backends. */
export function resolveRouteRuntimeRows(m: StreamRuntimeMetricsResponse | null): RouteRuntimeMetricsRow[] {
  const rr = m?.route_runtime
  if (rr && rr.length > 0) return rr
  const rh = m?.route_health
  if (!rh?.length) return []
  const windowSeconds =
    m?.metrics_window_seconds != null && Number.isFinite(m.metrics_window_seconds) ? Math.max(1, m.metrics_window_seconds) : 3600
  return rh.map((h) => fallbackRowFromHealth(h, windowSeconds))
}

function fallbackRowFromHealth(h: StreamMetricsRouteHealthRow, windowSeconds: number): RouteRuntimeMetricsRow {
  const ok = h.success_count
  const bad = h.failed_count
  const tot = ok + bad
  const sr = tot > 0 ? Math.round((100 * ok) / tot * 10) / 10 : 100
  const conn: RouteRuntimeConnectivityState =
    !h.enabled ? 'DISABLED' : bad > 0 && ok === 0 ? 'ERROR' : bad > 0 ? 'DEGRADED' : 'HEALTHY'
  const ts = new Date().toISOString()
  return {
    route_id: h.route_id,
    destination_id: 0,
    destination_name: h.destination_name,
    destination_type: h.destination_type,
    enabled: h.enabled,
    route_status: h.enabled ? 'ENABLED' : 'DISABLED',
    success_rate: sr,
    events_last_hour: tot,
    delivered_last_hour: ok,
    failed_last_hour: bad,
    avg_latency_ms: h.avg_latency_ms,
    p95_latency_ms: h.avg_latency_ms,
    max_latency_ms: h.avg_latency_ms,
    eps_current: ok / windowSeconds,
    retry_count_last_hour: 0,
    last_success_at: h.last_success_at,
    last_failure_at: h.last_failure_at,
    last_error_message: h.last_error_message,
    last_error_code: null,
    failure_policy: h.failure_policy,
    connectivity_state: conn,
    disable_reason: null,
    latency_trend: Array.from({ length: 12 }, () => ({ timestamp: ts, avg_latency_ms: h.avg_latency_ms })),
    success_rate_trend: Array.from({ length: 12 }, () => ({ timestamp: ts, success_rate: sr })),
  }
}

function RoutePanelSkeleton() {
  return (
    <div className="animate-pulse space-y-2 px-3 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 rounded-md bg-slate-200/80 dark:bg-gdc-elevated" />
      ))}
    </div>
  )
}

type RouteOperationalPanelProps = {
  streamSlug: string
  backendStreamId: number | undefined
  metrics: StreamRuntimeMetricsResponse | null
  loading: boolean
  routeToggleBusyId: number | null
  onToggleEnabled: (routeId: number, enabled: boolean, opts?: { disable_reason?: string | null }) => Promise<void>
  /** When true, hide route enable/disable and destination probe actions (Viewer / read-only monitoring). */
  routeActionsReadOnly?: boolean
}

export function RouteOperationalPanel({
  streamSlug,
  backendStreamId,
  metrics,
  loading,
  routeToggleBusyId,
  onToggleEnabled,
  routeActionsReadOnly = false,
}: RouteOperationalPanelProps) {
  const rows = resolveRouteRuntimeRows(metrics)
  const [testBusyId, setTestBusyId] = useState<number | null>(null)
  const [testHint, setTestHint] = useState<string | null>(null)
  const [disableDialog, setDisableDialog] = useState<{ routeId: number; destinationName: string } | null>(null)
  const [enableDialog, setEnableDialog] = useState<{ routeId: number; destinationName: string } | null>(null)
  const [disableReason, setDisableReason] = useState('')

  const runDestinationTest = useCallback(async (destinationId: number, routeId: number) => {
    setTestBusyId(routeId)
    setTestHint(null)
    try {
      const r = await testDestination(destinationId)
      const ok = r?.success === true
      setTestHint(`${ok ? 'OK' : 'Fail'} · ${String(r?.message ?? '').slice(0, 120)}`)
    } catch (e) {
      setTestHint(e instanceof Error ? e.message : String(e))
    } finally {
      setTestBusyId(null)
    }
  }, [])

  const executeDisable = useCallback(async () => {
    if (!disableDialog) return
    const trimmed = disableReason.trim()
    await onToggleEnabled(disableDialog.routeId, false, trimmed ? { disable_reason: trimmed } : undefined)
    setDisableDialog(null)
    setDisableReason('')
  }, [disableDialog, disableReason, onToggleEnabled])

  const executeEnable = useCallback(async () => {
    if (!enableDialog) return
    await onToggleEnabled(enableDialog.routeId, true)
    setEnableDialog(null)
  }, [enableDialog, onToggleEnabled])

  if (backendStreamId == null) {
    return (
      <div className="px-3 py-6 text-[12px] text-slate-600 dark:text-gdc-muted">
        Invalid stream id — route operational panel unavailable.
      </div>
    )
  }

  if (loading && !metrics) {
    return <RoutePanelSkeleton />
  }

  if (rows.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-[12px] text-slate-600 dark:text-gdc-muted">
        <p className="font-medium text-slate-800 dark:text-slate-200">No routes for this stream</p>
        <p className="mt-1 text-[11px]">Connect a destination from the stream workflow or mapping UI.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {testHint ? (
        <p className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-1 text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200">
          Last destination test: {testHint}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th scope="col" className={opTh}>
                Destination / Route
              </th>
              <th scope="col" className={opTh}>
                State
              </th>
              <th scope="col" className={cn(opTh, 'tabular-nums')}>
                Success %
              </th>
              <th scope="col" className={cn(opTh, 'tabular-nums')}>
                Throughput (window avg)
              </th>
              <th scope="col" className={cn(opTh, 'tabular-nums')}>
                Latency
              </th>
              <th scope="col" className={cn(opTh, 'tabular-nums')}>
                Retry 1h
              </th>
              <th scope="col" className={opTh}>
                Last error
              </th>
              <th scope="col" className={cn(opTh, 'text-right')}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const latSpark = r.latency_trend?.length
                ? r.latency_trend.map((p) => p.avg_latency_ms)
                : [r.avg_latency_ms]
              const destIcon =
                String(r.destination_type).toUpperCase().includes('WEBHOOK') ||
                String(r.destination_type).toLowerCase().includes('webhook') ? (
                  <Webhook className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                ) : (
                  <Server className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                )
              const hoverDetail = [
                r.disable_reason ? `Disable reason: ${r.disable_reason}` : null,
                `Max latency: ${r.max_latency_ms.toFixed(0)} ms · P95: ${r.p95_latency_ms.toFixed(0)} ms`,
                r.last_error_code ? `Code: ${r.last_error_code}` : null,
                `Delivered 1h: ${r.delivered_last_hour} · Failed 1h: ${r.failed_last_hour}`,
              ]
                .filter(Boolean)
                .join('\n')
              return (
                <tr key={r.route_id} className={cn(opTr, 'group')} title={hoverDetail}>
                  <td className={opTd}>
                    <div className="flex min-w-[160px] items-start gap-2">
                      <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 dark:bg-gdc-elevated">
                        {destIcon}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-slate-100">{r.destination_name}</p>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                          {r.destination_type} · Route #{r.route_id}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <span className="rounded bg-slate-100 px-1 py-px text-[9px] font-semibold text-slate-700 dark:bg-gdc-elevated dark:text-gdc-mutedStrong">
                            {r.failure_policy}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className={opTd}>
                    <div className="flex flex-col gap-1">
                      <StatusBadge tone={r.enabled ? 'success' : 'neutral'} className="w-fit text-[10px] font-bold uppercase">
                        {r.enabled ? 'On' : 'Off'}
                      </StatusBadge>
                      <StatusBadge tone={connectivityTone(r.connectivity_state)} className="w-fit text-[10px] font-bold uppercase">
                        {r.connectivity_state}
                      </StatusBadge>
                    </div>
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">{r.success_rate.toFixed(1)}%</span>
                      <MiniSparkline
                        values={r.success_rate_trend?.length ? r.success_rate_trend.map((p) => p.success_rate) : [r.success_rate]}
                        className="text-emerald-600 dark:text-emerald-400"
                      />
                    </div>
                  </td>
                  <td className={cn(opTd, 'tabular-nums text-[12px] font-semibold text-slate-800 dark:text-slate-100')}>
                    {formatThroughputEps(r.eps_current)}
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                        {r.avg_latency_ms.toFixed(0)} / {r.p95_latency_ms.toFixed(0)} ms
                      </span>
                      <MiniSparkline values={latSpark} />
                    </div>
                  </td>
                  <td className={cn(opTd, 'tabular-nums text-[12px]')}>{r.retry_count_last_hour}</td>
                  <td className={opTd}>
                    <div className="max-w-[200px] space-y-0.5">
                      {r.last_error_message ? (
                        <p className="line-clamp-2 text-[10px] font-medium leading-snug text-red-700 dark:text-red-300">{r.last_error_message}</p>
                      ) : (
                        <span className="text-[10px] text-slate-500">—</span>
                      )}
                      <p className="text-[9px] tabular-nums text-slate-500 dark:text-gdc-muted">
                        ok {fmtTs(r.last_success_at)} · fail {fmtTs(r.last_failure_at)}
                      </p>
                    </div>
                  </td>
                  <td className={cn(opTd, 'text-right')}>
                    <div className="flex flex-wrap justify-end gap-1">
                      {!routeActionsReadOnly ? (
                        <>
                          {r.enabled ? (
                            <button
                              type="button"
                              disabled={routeToggleBusyId === r.route_id}
                              onClick={() =>
                                setDisableDialog({ routeId: r.route_id, destinationName: r.destination_name })
                              }
                              className="inline-flex h-7 items-center rounded border border-slate-200/90 bg-white px-1.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={routeToggleBusyId === r.route_id}
                              onClick={() =>
                                setEnableDialog({ routeId: r.route_id, destinationName: r.destination_name })
                              }
                              className="inline-flex h-7 items-center rounded border border-emerald-200/90 bg-emerald-500/[0.08] px-1.5 text-[10px] font-semibold text-emerald-900 hover:bg-emerald-500/[0.12] disabled:opacity-50 dark:border-emerald-500/30 dark:text-emerald-100"
                            >
                              Enable
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={testBusyId === r.route_id || r.destination_id <= 0}
                            onClick={() => void runDestinationTest(r.destination_id, r.route_id)}
                            className="inline-flex h-7 items-center gap-0.5 rounded border border-slate-200/90 bg-white px-1.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                          >
                            {testBusyId === r.route_id ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <TestTube2 className="h-3 w-3" aria-hidden />}
                            Test
                          </button>
                        </>
                      ) : (
                        <span className="text-[10px] text-slate-500 dark:text-gdc-muted">Read-only</span>
                      )}
                      <Link
                        to={`${logsPath(streamSlug)}?route=${r.route_id}`}
                        className="inline-flex h-7 items-center rounded border border-slate-200/90 bg-white px-1.5 text-[10px] font-semibold text-violet-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-violet-300"
                      >
                        Logs
                      </Link>
                      <Link
                        to={routeEditPath(String(r.route_id))}
                        className="inline-flex h-7 items-center rounded border border-slate-200/90 bg-white px-1.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                      >
                        Edit
                      </Link>
                      {r.destination_id > 0 ? (
                        <Link
                          to={destinationDetailPath(String(r.destination_id))}
                          className="inline-flex h-7 items-center rounded border border-slate-200/90 bg-white px-1.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                        >
                          Dest
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {disableDialog ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && routeToggleBusyId == null) {
              setDisableDialog(null)
              setDisableReason('')
            }
          }}
          title="Disable route?"
          targetName={disableDialog.destinationName}
          impactBullets={['Delivery to this destination stops until the route is enabled again.']}
          reversibility="Reversible — enable the route again to resume delivery."
          risk="medium"
          optionalNote={{
            label: 'Optional disable reason (stored on route)',
            value: disableReason,
            onChange: setDisableReason,
            placeholder: 'Maintenance, incident, capacity…',
          }}
          primaryLabel="Disable route"
          busy={routeToggleBusyId === disableDialog.routeId}
          onConfirm={() => void executeDisable()}
          dataTestId="route-disable-dialog"
        />
      ) : null}
      {enableDialog ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && routeToggleBusyId == null) setEnableDialog(null)
          }}
          title="Enable route?"
          targetName={enableDialog.destinationName}
          impactBullets={['Resumes delivery from this stream to the destination.']}
          reversibility="You can disable the route again later without deleting it."
          risk="medium"
          primaryLabel="Enable route"
          busy={routeToggleBusyId === enableDialog.routeId}
          onConfirm={() => void executeEnable()}
          dataTestId="route-enable-dialog"
        />
      ) : null}
    </div>
  )
}

export function RecentRouteErrorsPanel({
  errors,
  loading,
}: {
  errors: RecentRouteErrorItem[]
  loading: boolean
}) {
  const groups = useMemo(() => {
    const m = new Map<
      string,
      { route_id: number; destination_name: string; error_code: string | null; items: RecentRouteErrorItem[] }
    >()
    for (const e of errors) {
      const codeKey = e.error_code != null && String(e.error_code).trim() !== '' ? String(e.error_code).trim() : '—'
      const key = `${e.route_id}|${codeKey}`
      const cur = m.get(key)
      if (cur) cur.items.push(e)
      else m.set(key, { route_id: e.route_id, destination_name: e.destination_name, error_code: e.error_code, items: [e] })
    }
    return [...m.values()]
      .map((g) => ({
        ...g,
        items: [...g.items].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)),
      }))
      .sort((a, b) => (a.items[0]?.created_at < b.items[0]?.created_at ? 1 : -1))
  }, [errors])

  if (loading) {
    return <RoutePanelSkeleton />
  }
  if (!errors.length) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-slate-600 dark:text-gdc-muted">
        No recent route failures in the committed delivery records window.
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className={opTable}>
        <thead>
          <tr className={opThRow}>
            <th scope="col" className={opTh}>
              Time
            </th>
            <th scope="col" className={opTh}>
              Route / Destination
            </th>
            <th scope="col" className={opTh}>
              Code
            </th>
            <th scope="col" className={opTh}>
              Message
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={`${g.route_id}-${g.error_code ?? 'none'}`}>
              <tr className={cn(opTr, 'bg-slate-50/90 dark:bg-gdc-elevated/80')}>
                <td className={cn(opTd, 'py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted')} colSpan={4}>
                  <span className="text-slate-800 dark:text-slate-100">
                    Route #{g.route_id} · {g.destination_name}
                  </span>
                  <span className="mx-2 text-slate-300 dark:text-gdc-divider">|</span>
                  <span className="font-mono normal-case text-slate-700 dark:text-gdc-mutedStrong">{g.error_code ?? '—'}</span>
                  <span className="mx-2 text-slate-300 dark:text-gdc-divider">|</span>
                  <span className="tabular-nums normal-case">{g.items.length} event{g.items.length === 1 ? '' : 's'}</span>
                </td>
              </tr>
              {g.items.map((e, i) => (
                <tr key={`${e.created_at}-${e.route_id}-${i}`} className={opTr}>
                  <td className={cn(opTd, 'whitespace-nowrap text-[11px] tabular-nums text-slate-600 dark:text-gdc-muted')}>
                    {fmtTs(e.created_at)}
                  </td>
                  <td className={opTd}>
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Route #{e.route_id}</p>
                    <p className="text-[10px] text-slate-600 dark:text-gdc-muted">{e.destination_name}</p>
                  </td>
                  <td className={cn(opTd, 'font-mono text-[10px] text-slate-700 dark:text-gdc-mutedStrong')}>{e.error_code ?? '—'}</td>
                  <td className={opTd}>
                    <p className="max-w-md text-[11px] leading-snug text-red-800 dark:text-red-200">{e.message}</p>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
