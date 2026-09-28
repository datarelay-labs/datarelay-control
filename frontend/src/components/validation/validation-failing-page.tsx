import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchValidations, type ContinuousValidationRow } from '../../api/gdcValidation'
import { streamRuntimePath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { ValidationHealthPill } from './validation-health-pill'

export function ValidationFailingPage() {
  const [rows, setRows] = useState<ContinuousValidationRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const data = await fetchValidations(false)
    if (data === null) setErr('Failed to load validations')
    setRows(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const bad = (rows ?? []).filter((r) => r.enabled && r.last_status !== 'HEALTHY')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wide">Failing or degraded</span>
        </div>
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
      <div className="overflow-x-auto rounded-lg border border-amber-200/60 bg-white shadow-sm dark:border-amber-900/40 dark:bg-gdc-card dark:shadow-gdc-card">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Name</th>
              <th className={opTh}>Health</th>
              <th className={opTh}>Failures</th>
              <th className={opTh}>Stream</th>
              <th className={opTh}>Last error</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr className={cn(opTr, opStateRow)}>
                <td className={opTd} colSpan={5}>
                  Loading…
                </td>
              </tr>
            ) : null}
            {!loading && bad.length === 0 ? (
              <tr className={cn(opTr, opStateRow)}>
                <td className={opTd} colSpan={5}>
                  No enabled validations in a non-healthy state.
                </td>
              </tr>
            ) : null}
            {bad.map((r) => (
              <tr key={r.id} className={opTr}>
                <td className={opTd}>
                  <span className="font-medium text-slate-900 dark:text-slate-100">{r.name}</span>
                </td>
                <td className={opTd}>
                  <ValidationHealthPill status={r.last_status} />
                </td>
                <td className={opTd}>
                  <span className="font-mono text-xs tabular-nums">{r.consecutive_failures}</span>
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
                  <span className="line-clamp-3 font-mono text-[10px] text-slate-700 dark:text-slate-200">{r.last_error ?? '—'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
