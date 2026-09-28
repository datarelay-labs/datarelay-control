import { Activity, Bell, Play, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchRuntimeValidationOperationalSummary } from '../../api/gdcRuntime'
import type { ValidationOperationalSummaryResponse } from '../../api/types/gdcApi'
import { fetchValidations, postValidationRun, type ContinuousValidationRow } from '../../api/gdcValidation'
import { logsExplorerPath, streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { ValidationHealthPill } from './validation-health-pill'
import { ValidationOutcomeTrendChart } from './validation-outcome-trend-chart'
import { ValidationSeverityBadge } from './validation-severity-badge'
import { DevValidationBadge } from '../shell/dev-validation-badge'
import { isDevValidationLabEntityName } from '../../utils/devValidationLab'

const SOURCE_LAB_DEFS: { template_key: string; label: string }[] = [
  { template_key: 'dev_lab_s3_object_polling', label: 'S3 lab' },
  { template_key: 'dev_lab_db_query_pg', label: 'PostgreSQL query lab' },
  { template_key: 'dev_lab_db_query_mysql', label: 'MySQL query lab' },
  { template_key: 'dev_lab_db_query_mariadb', label: 'MariaDB query lab' },
  { template_key: 'dev_lab_remote_file_sftp', label: 'Remote file SFTP lab' },
  { template_key: 'dev_lab_remote_file_scp', label: 'Remote file SCP lab' },
]

function parsePerfSnapshot(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function ValidationOverviewPage() {
  const [rows, setRows] = useState<ContinuousValidationRow[] | null>(null)
  const [operational, setOperational] = useState<ValidationOperationalSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [labFilterOnly, setLabFilterOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const [data, op] = await Promise.all([fetchValidations(false), fetchRuntimeValidationOperationalSummary()])
    if (data === null) setErr('Failed to load validations')
    setRows(data ?? [])
    setOperational(op)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visibleRows = useMemo(() => {
    const list = rows ?? []
    if (!labFilterOnly) return list
    return list.filter((r) => isDevValidationLabEntityName(r.name))
  }, [rows, labFilterOnly])

  const sourceLabSliceRows = useMemo(() => {
    const list = rows ?? []
    const byTk = new Map<string, ContinuousValidationRow>()
    for (const r of list) {
      if (r.template_key) byTk.set(r.template_key, r)
    }
    return SOURCE_LAB_DEFS.map((d) => ({ ...d, row: byTk.get(d.template_key) ?? null }))
  }, [rows])

  const onRun = async (id: number) => {
    setRunningId(id)
    try {
      await postValidationRun(id)
      await load()
    } finally {
      setRunningId(null)
    }
  }

  const op = operational

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-600 dark:text-gdc-mutedStrong">
          <Activity className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wide">Health checks</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/validation/alerts"
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-100 dark:hover:bg-violet-900/60"
          >
            <Bell className="h-3.5 w-3.5" aria-hidden />
            Alerts
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </button>
          <label className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded-md border border-amber-200/80 bg-amber-50/80 px-2 py-1 text-[11px] font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50">
            <input
              type="checkbox"
              className="rounded border-amber-400 text-amber-700 focus:ring-amber-500"
              checked={labFilterOnly}
              onChange={(e) => setLabFilterOnly(e.target.checked)}
            />
            Dev validation lab only
          </label>
        </div>
      </div>
      {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}

      {!loading && rows && rows.length > 0 ? (
        <section
          className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card"
          aria-label="Dev validation source lab"
        >
          <div className="border-b border-slate-100 px-3 py-2 dark:border-gdc-border">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Dev validation — S3 / database / remote file smoke
            </h2>
            <p className="text-[10px] text-slate-500 dark:text-gdc-mutedStrong">
              Rows appear when optional lab slices are seeded. Performance JSON populates when{' '}
              <span className="font-mono">ENABLE_DEV_VALIDATION_PERFORMANCE=true</span>.
            </p>
          </div>
          <table className={opTable} aria-label="Dev validation source lab table">
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Slice</th>
                <th className={opTh}>Health</th>
                <th className={opTh}>Last run</th>
                <th className={opTh}>Run ms</th>
                <th className={opTh}>Extracted</th>
                <th className={opTh}>Delivered</th>
                <th className={opTh}>Avg route ms</th>
                <th className={opTh}>Failures</th>
                <th className={opTh}>Recent error</th>
              </tr>
            </thead>
            <tbody>
              {sourceLabSliceRows.map((s) => {
                const r = s.row
                const perf = parsePerfSnapshot(r?.last_perf_snapshot_json)
                const runMs = typeof perf?.run_duration_ms === 'number' ? perf.run_duration_ms : null
                const ext = typeof perf?.extracted_event_count === 'number' ? perf.extracted_event_count : null
                const del = typeof perf?.delivered_batch_event_count === 'number' ? perf.delivered_batch_event_count : null
                const avg = typeof perf?.avg_route_send_latency_ms === 'number' ? perf.avg_route_send_latency_ms : null
                const errs = typeof perf?.error_count === 'number' ? perf.error_count : r?.consecutive_failures ?? 0
                return (
                  <tr key={s.template_key} className={cn(opTr, !r && 'opacity-60')}>
                    <td className={opTd}>
                      <span className="font-medium text-slate-900 dark:text-slate-100">{s.label}</span>
                      <div className="font-mono text-[10px] text-slate-500">{s.template_key}</div>
                    </td>
                    <td className={opTd}>{r ? <ValidationHealthPill status={r.last_status} /> : <span className="text-slate-400">—</span>}</td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px] text-slate-600 dark:text-gdc-mutedStrong">
                        {r?.last_run_at ? new Date(r.last_run_at).toLocaleString() : '—'}
                      </span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px]">{runMs ?? '—'}</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px]">{ext ?? '—'}</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px]">{del ?? '—'}</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px]">{avg ?? '—'}</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px] tabular-nums">{r ? errs : '—'}</span>
                    </td>
                    <td className={opTd}>
                      {r?.last_error ? (
                        <p className="line-clamp-2 font-mono text-[10px] text-rose-600 dark:text-rose-400">{r.last_error}</p>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card">
            <table className={opTable} aria-label="Continuous validation definitions">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Name</th>
                  <th className={opTh}>Type</th>
                  <th className={opTh}>Stream</th>
                  <th className={opTh}>Health</th>
                  <th className={opTh}>Failures</th>
                  <th className={opTh}>Schedule</th>
                  <th className={opTh}>Last run</th>
                  <th className={opTh}>Drill</th>
                  <th className={opTh}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr className={cn(opTr, opStateRow)}>
                    <td className={opTd} colSpan={9}>
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {!loading && rows && rows.length === 0 ? (
                  <tr className={cn(opTr, opStateRow)}>
                    <td className={opTd} colSpan={9}>
                      No health checks configured yet. Operators can add checks via{' '}
                      <span className="font-mono text-[11px]">POST /api/v1/validation</span>.
                    </td>
                  </tr>
                ) : null}
                {!loading && rows && rows.length > 0 && visibleRows.length === 0 ? (
                  <tr className={cn(opTr, opStateRow)}>
                    <td className={opTd} colSpan={9}>
                      No health checks match the Dev validation lab filter.
                    </td>
                  </tr>
                ) : null}
                {visibleRows.map((r) => (
                  <tr key={r.id} className={cn(opTr, !r.enabled && 'opacity-60')}>
                    <td className={opTd}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-slate-900 dark:text-slate-100">{r.name}</span>
                        <DevValidationBadge name={r.name} />
                      </div>
                      {r.last_error ? (
                        <p className="mt-0.5 line-clamp-2 font-mono text-[10px] text-rose-600 dark:text-rose-400">{r.last_error}</p>
                      ) : null}
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[11px]">{r.validation_type}</span>
                    </td>
                    <td className={opTd}>
                      {r.target_stream_id != null ? (
                        <Link
                          className="font-mono text-[11px] text-violet-700 hover:underline dark:text-violet-300"
                          to={streamRuntimePath(String(r.target_stream_id))}
                        >
                          {r.target_stream_id}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className={opTd}>
                      <ValidationHealthPill status={r.last_status} />
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-xs tabular-nums">{r.consecutive_failures}</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[11px]">{r.schedule_seconds}s</span>
                    </td>
                    <td className={opTd}>
                      <span className="font-mono text-[10px] text-slate-600 dark:text-gdc-mutedStrong">
                        {r.last_run_at ? new Date(r.last_run_at).toLocaleString() : '—'}
                      </span>
                    </td>
                    <td className={opTd}>
                      {r.target_stream_id != null ? (
                        <div className="flex flex-col gap-0.5 text-[10px] font-semibold">
                          <Link className="text-violet-700 hover:underline dark:text-violet-300" to={streamRuntimePath(String(r.target_stream_id))}>
                            Runtime
                          </Link>
                          <Link className="text-violet-700 hover:underline dark:text-violet-300" to="/runtime/analytics">
                            Analytics
                          </Link>
                          <Link
                            className="text-violet-700 hover:underline dark:text-violet-300"
                            to={logsExplorerPath({ stream_id: r.target_stream_id })}
                          >
                            Logs
                          </Link>
                          <Link className="text-violet-700 hover:underline dark:text-violet-300" to="/routes">
                            Routes
                          </Link>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className={opTd}>
                      <button
                        type="button"
                        disabled={!r.enabled || runningId === r.id}
                        onClick={() => void onRun(r.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-gdc-elevated"
                      >
                        <Play className="h-3 w-3" aria-hidden />
                        Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="w-full shrink-0 space-y-3 xl:sticky xl:top-4 xl:w-[340px]" aria-label="Health check summary">
          <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active posture</h3>
            {op ? (
              <dl className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div>
                  <dt className="text-slate-500">Failing</dt>
                  <dd className="text-lg font-bold text-rose-600">{op.failing_validations_count}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Degraded</dt>
                  <dd className="text-lg font-bold text-amber-700">{op.degraded_validations_count}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Open critical</dt>
                  <dd className="text-lg font-bold text-rose-700">{op.open_alerts_critical}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Checkpoint drift</dt>
                  <dd className="text-lg font-bold text-slate-900 dark:text-slate-100">{op.open_checkpoint_drift_alerts}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1 text-[11px] text-slate-500">No operational summary.</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-control">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active failures</h3>
            {op && op.latest_open_alerts.length > 0 ? (
              <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto">
                {op.latest_open_alerts.slice(0, 12).map((a) => (
                  <li key={a.id} className="rounded border border-slate-100 p-2 dark:border-gdc-border">
                    <div className="flex items-center gap-2">
                      <ValidationSeverityBadge severity={a.severity} />
                      <span className="font-mono text-[10px] text-slate-500">val #{a.validation_id}</span>
                    </div>
                    <p className="mt-1 text-[11px] font-medium text-slate-900 dark:text-slate-50">{a.title}</p>
                    <Link
                      to={`/validation/runs?validation_id=${encodeURIComponent(String(a.validation_id))}`}
                      className="mt-1 inline-block text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      Open runs
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">No open alerts.</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-control">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recovery timeline</h3>
            {op && op.latest_recoveries.length > 0 ? (
              <ul className="mt-2 space-y-1.5 text-[11px] text-slate-800 dark:text-slate-200">
                {op.latest_recoveries.map((r) => (
                  <li key={r.id} className="border-l-2 border-emerald-500/60 pl-2">
                    <span className="font-medium">{r.title}</span>
                    <span className="block font-mono text-[10px] text-slate-500">{new Date(r.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">No recent recoveries.</p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-control">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">24h outcome trend</h3>
            {op ? <ValidationOutcomeTrendChart buckets={op.outcome_trend_24h} /> : null}
          </div>
        </aside>
      </div>

      <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
        Drill into committed runs in{' '}
        <Link className="text-violet-700 hover:underline dark:text-violet-300" to="/validation/runs">
          Runs
        </Link>{' '}
        or open{' '}
        <Link className="text-violet-700 hover:underline dark:text-violet-300" to={logsExplorerPath({})}>
          Logs
        </Link>{' '}
        filtered by <span className="font-mono">run_id</span>.
      </p>
    </div>
  )
}
