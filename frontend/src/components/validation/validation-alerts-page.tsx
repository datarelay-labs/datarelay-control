import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchValidationAlerts,
  postValidationAlertAcknowledge,
  postValidationAlertResolve,
  type ValidationAlertRow,
} from '../../api/gdcValidation'
import { cn } from '../../lib/utils'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { ValidationSeverityBadge } from './validation-severity-badge'

export function ValidationAlertsPage() {
  const [rows, setRows] = useState<ValidationAlertRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const data = await fetchValidationAlerts({ limit: 200 })
    if (data === null) setErr('Failed to load alerts')
    setRows(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onAck = async (id: number) => {
    setBusyId(id)
    try {
      await postValidationAlertAcknowledge(id)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ack failed')
    } finally {
      setBusyId(null)
    }
  }

  const onResolve = async (id: number) => {
    setBusyId(id)
    try {
      await postValidationAlertResolve(id)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Resolve failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Health check alerts</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>
      {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Severity</th>
              <th className={opTh}>Type</th>
              <th className={opTh}>Check</th>
              <th className={opTh}>Status</th>
              <th className={opTh}>Title</th>
              <th className={opTh}>Triggered</th>
              <th className={opTh}>Drill-down</th>
              <th className={opTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr className={cn(opTr, opStateRow)}>
                <td className={opTd} colSpan={8}>
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && rows && rows.length === 0 ? (
              <tr className={cn(opTr, opStateRow)}>
                <td className={opTd} colSpan={8}>
                  No alerts recorded yet.
                </td>
              </tr>
            ) : null}
            {(rows ?? []).map((a) => (
              <tr key={a.id} className={opTr}>
                <td className={opTd}>
                  <ValidationSeverityBadge severity={a.severity} />
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[10px]">{a.alert_type}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px]">#{a.validation_id}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[10px]">{a.status}</span>
                </td>
                <td className={opTd}>
                  <div className="max-w-xs">
                    <p className="text-[11px] font-medium text-slate-900 dark:text-slate-100">{a.title}</p>
                    <p className="line-clamp-2 font-mono text-[10px] text-slate-500 dark:text-gdc-muted">{a.message}</p>
                  </div>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[10px] text-slate-600 dark:text-gdc-mutedStrong">
                    {new Date(a.triggered_at).toLocaleString()}
                  </span>
                </td>
                <td className={opTd}>
                  <div className="flex flex-col gap-0.5 text-[10px]">
                    <Link
                      className="text-violet-700 hover:underline dark:text-violet-300"
                      to={`/validation/runs?validation_id=${encodeURIComponent(String(a.validation_id))}`}
                    >
                      Runs
                    </Link>
                    <Link className="text-violet-700 hover:underline dark:text-violet-300" to="/runtime/analytics">
                      Analytics
                    </Link>
                    <Link className="text-violet-700 hover:underline dark:text-violet-300" to="/runtime">
                      Runtime
                    </Link>
                  </div>
                </td>
                <td className={opTd}>
                  <div className="flex flex-col gap-1">
                    {a.status === 'OPEN' ? (
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => void onAck(a.id)}
                        className={cn(
                          'rounded bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-slate-900 disabled:opacity-50 dark:bg-slate-200 dark:text-slate-900',
                        )}
                      >
                        Ack
                      </button>
                    ) : null}
                    {a.status !== 'RESOLVED' ? (
                      <button
                        type="button"
                        disabled={busyId === a.id}
                        onClick={() => void onResolve(a.id)}
                        className="rounded border border-emerald-600/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-200 dark:hover:bg-emerald-950/40"
                      >
                        Resolve
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
        Use stream runtime and logs with the correlated <span className="font-mono">run_id</span> from validation runs
        for delivery diagnosis.
      </p>
    </div>
  )
}
