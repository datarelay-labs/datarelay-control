import { AlertTriangle, Bell, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchDestinationsList, type DestinationListItem } from '../../api/gdcDestinations'
import { fetchRuntimeAlertSummary, fetchRuntimeDashboardSummary, invalidateDashboardAnalyticsCache } from '../../api/gdcRuntime'
import { fetchValidationAlerts, type ValidationAlertRow } from '../../api/gdcValidation'
import {
  clearOperationalSnapshotCache,
  getOperationalSnapshot,
  type OperationalProblem,
  type OperationalSnapshotResponse,
} from '../../api/operationalSnapshot'
import type { DashboardSummaryResponse, RuntimeAlertSummaryResponse } from '../../api/types/gdcApi'
import {
  NAV_PATH,
  destinationDetailPath,
  logsExplorerPath,
  routeEditPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import { extractCapacityConfig } from '../destinations/destination-mini-charts'
type CapacityAlert = {
  destinationId: number
  destinationName: string
  currentEps: number
  limitEps: number
  usagePct: number
  criticalPct: number
}

type AlertsBundle = {
  snapshot: OperationalSnapshotResponse | null
  runtimeAlerts: RuntimeAlertSummaryResponse | null
  dashboard: DashboardSummaryResponse | null
  validationAlerts: ValidationAlertRow[] | null
  destinations: DestinationListItem[] | null
  unavailable: string[]
}

const EMPTY_BUNDLE: AlertsBundle = {
  snapshot: null,
  runtimeAlerts: null,
  dashboard: null,
  validationAlerts: null,
  destinations: null,
  unavailable: [],
}
function unwrap<T>(result: PromiseSettledResult<T>, name: string, unavailable: string[]): T | null {
  if (result.status === 'fulfilled') {
    if (result.value != null) return result.value
    unavailable.push(name)
    return null
  }
  unavailable.push(name)
  return null
}

function operationalProblemTarget(problem: OperationalProblem): string {
  if (problem.route_id != null) return routeEditPath(String(problem.route_id))
  if (problem.destination_id != null) return destinationDetailPath(String(problem.destination_id))
  if (problem.stream_id != null) return streamRuntimePath(String(problem.stream_id))
  return NAV_PATH.dashboard
}

function fmtTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}
function severityRank(value: 'critical' | 'warning'): number {
  return value === 'critical' ? 0 : 1
}

function capacityAlerts(
  snapshot: OperationalSnapshotResponse | null,
  destinations: DestinationListItem[] | null,
): CapacityAlert[] {
  if (!snapshot || !destinations) return []
  const runtimeById = new Map(snapshot.destinations.map((row) => [row.destination_id, row]))

  return destinations.flatMap((row) => {
    const runtime = runtimeById.get(row.id)
    const { limitEps, thresholds } = extractCapacityConfig(row)
    if (!runtime || limitEps == null || limitEps <= 0) return []
    const currentEps = runtime.inbound_eps_1m
    if (!Number.isFinite(currentEps)) return []
    const usagePct = (currentEps / limitEps) * 100
    if (usagePct < thresholds.warningPct) return []
    return [{
      destinationId: row.id,
      destinationName: row.name,
      currentEps,
      limitEps,
      usagePct,
      criticalPct: thresholds.criticalPct,
    }]
  })
}
export function OperationalAlertsPage() {
  const [bundle, setBundle] = useState<AlertsBundle>(EMPTY_BUNDLE)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    if (fresh) {
      clearOperationalSnapshotCache()
      invalidateDashboardAnalyticsCache()
    }

    const settled = await Promise.allSettled([
      getOperationalSnapshot(),
      fetchRuntimeAlertSummary('1h', 100),
      fetchRuntimeDashboardSummary(100, '1h'),
      fetchValidationAlerts({ status: 'OPEN', limit: 100 }),
      fetchDestinationsList(),
    ])

    const unavailable: string[] = []
    setBundle({
      snapshot: unwrap(settled[0], 'operational snapshot', unavailable),
      runtimeAlerts: unwrap(settled[1], 'runtime alert summary', unavailable),
      dashboard: unwrap(settled[2], 'dashboard summary', unavailable),
      validationAlerts: unwrap(settled[3], 'health-check alerts', unavailable),
      destinations: unwrap(settled[4], 'destination catalog', unavailable),
      unavailable,
    })
    setLoading(false)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const capacity = useMemo(
    () => capacityAlerts(bundle.snapshot, bundle.destinations),
    [bundle.snapshot, bundle.destinations],
  )

  const problems = useMemo(() => {
    const rows = [...(bundle.snapshot?.problems ?? [])]
    return rows.sort((a, b) => {
      const severity = severityRank(a.severity) - severityRank(b.severity)
      if (severity !== 0) return severity
      return String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? ''))
    })
  }, [bundle.snapshot])

  const noDataCount = (bundle.snapshot?.streams ?? []).filter(
    (stream) => stream.enabled && stream.health_status === 'IDLE',
  ).length
  const lowVolumeCount = (bundle.snapshot?.streams ?? []).filter(
    (stream) => stream.enabled && stream.health_status === 'DEGRADED',
  ).length
  const schemaDriftCount = bundle.dashboard?.open_schema_field_drift_count ?? null
  const runtimeRows = bundle.runtimeAlerts?.items ?? []
  const validationRows = bundle.validationAlerts ?? []
  const empty =
    !loading &&
    problems.length === 0 &&
    capacity.length === 0 &&
    noDataCount === 0 &&
    lowVolumeCount === 0 &&
    (schemaDriftCount ?? 0) === 0 &&
    runtimeRows.length === 0 &&
    validationRows.length === 0

  return (
    <div className="flex w-full min-w-0 flex-col gap-4" data-testid="operational-alerts-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-gdc-foreground">Operational alerts</h2>
          </div>
          <p className="mt-1 max-w-3xl text-[12px] text-slate-600 dark:text-gdc-muted">
            Current operational signals from runtime truth, configured destination capacity, schema drift, and health checks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          Refresh
        </button>
      </div>

      {bundle.unavailable.length > 0 ? (
        <p
          className="rounded-md border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="operational-alerts-partial"
        >
          Some alert sources are unavailable: {bundle.unavailable.join(', ')}. Available runtime facts are still shown.
        </p>
      ) : null}

      <section
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
        aria-label="Operational signal summary"
        data-testid="operational-alerts-summary"
      >
        <SummaryCard label="No data streams" value={noDataCount} href="/streams?filter=no-data" />
        <SummaryCard label="Low volume streams" value={lowVolumeCount} href="/streams?filter=low-volume" />
        <SummaryCard label="Schema drift" value={schemaDriftCount} href={NAV_PATH.governance} unknownLabel="—" />
        <SummaryCard label="Capacity warnings" value={capacity.length} href="/destinations?filter=warning" />
      </section>
      {empty ? (
        <div
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
          data-testid="operational-alerts-empty"
        >
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            No current operational signals need attention.
          </div>
        </div>
      ) : null}

      {problems.length > 0 || capacity.length > 0 ? (
        <section className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="border-b border-slate-200/80 px-4 py-3 dark:border-gdc-divider">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Needs attention</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">
              Current stream, route, destination, checkpoint, and capacity problems.
            </p>
          </div>
          <ul className="divide-y divide-slate-200/70 dark:divide-gdc-divider">
            {problems.map((problem, index) => (
              <ProblemRow key={`problem-${index}-${problem.last_seen_at ?? index}`} problem={problem} />
            ))}
            {capacity.map((item) => {
              const critical = item.usagePct >= item.criticalPct
              return (
                <li key={`capacity-${item.destinationId}`} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    {critical ? (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link
                        to={destinationDetailPath(String(item.destinationId))}
                        className="text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      >
                        {item.destinationName} capacity at {Math.round(item.usagePct)}%
                      </Link>
                      <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                        {item.currentEps.toFixed(1)} / {item.limitEps.toLocaleString()} EPS · configured capacity evidence
                      </p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      {runtimeRows.length > 0 ? (
        <section className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="border-b border-slate-200/80 px-4 py-3 dark:border-gdc-divider">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent runtime alert clusters</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">WARN/ERROR delivery-log clusters from the last hour.</p>
          </div>
          <ul className="divide-y divide-slate-200/70 dark:divide-gdc-divider">
            {runtimeRows.map((row, index) => (
              <li key={`runtime-${row.stream_id}-${index}`} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  {row.severity === 'ERROR' ? (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      to={streamRuntimePath(String(row.stream_id))}
                      className="text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {row.stream_name}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                      {row.severity} · {row.count} events · last {fmtTime(row.latest_occurrence)}
                    </p>
                    <Link
                      to={logsExplorerPath({ stream_id: row.stream_id })}
                      className="mt-1 inline-block text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      View logs
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {validationRows.length > 0 ? (
        <section className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="border-b border-slate-200/80 px-4 py-3 dark:border-gdc-divider">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Open health-check alerts</h3>
            <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">
              Validation findings are supporting operational evidence, not a separate runtime truth source.
            </p>
          </div>
          <ul className="divide-y divide-slate-200/70 dark:divide-gdc-divider">
            {validationRows.map((row) => (
              <li key={row.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/validation/runs?validation_id=${encodeURIComponent(String(row.validation_id))}`}
                      className="text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {row.title}
                    </Link>
                    <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">{row.message}</p>
                    <p className="mt-1 font-mono text-[10px] text-slate-500 dark:text-gdc-muted">
                      {row.alert_type} · {fmtTime(row.triggered_at)}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
function SummaryCard({
  label,
  value,
  href,
  unknownLabel = '0',
}: {
  label: string
  value: number | null
  href: string
  unknownLabel?: string
}) {
  const hot = (value ?? 0) > 0
  return (
    <Link
      to={href}
      className="rounded-lg border border-slate-200/80 bg-white p-3 shadow-sm transition hover:border-violet-300 dark:border-gdc-border dark:bg-gdc-card"
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${hot ? 'text-amber-600 dark:text-amber-300' : 'text-slate-900 dark:text-slate-100'}`}>
        {value == null ? unknownLabel : value}
      </p>
    </Link>
  )
}
function ProblemRow({ problem }: { problem: OperationalProblem }) {
  const critical = problem.severity === 'critical'
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {critical ? (
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <Link
            to={operationalProblemTarget(problem)}
            className="text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
          >
            {problem.title}
          </Link>
          <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">{problem.message}</p>
          <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-muted">
            {problem.scope} · {fmtTime(problem.last_seen_at)}
          </p>
        </div>
      </div>
    </li>
  )
}
