import { ListTree, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchValidationRuns, type ValidationRunRow } from '../../api/gdcValidation'
import { logsExplorerPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opStateRow, opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

export function ValidationRunsPage() {
  const [searchParams] = useSearchParams()
  const scopedVid = searchParams.get('validation_id')
  const validationId = scopedVid && /^\d+$/.test(scopedVid) ? Number(scopedVid) : undefined

  const [rows, setRows] = useState<ValidationRunRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const data = await fetchValidationRuns({ limit: 200, validation_id: validationId })
    if (data === null) setErr('Failed to load validation runs')
    setRows(data ?? [])
    setLoading(false)
  }, [validationId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-slate-600 dark:text-gdc-mutedStrong">
          <ListTree className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wide">Recent validation runs</span>
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
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Time</th>
              <th className={opTh}>Validation</th>
              <th className={opTh}>Stream</th>
              <th className={opTh}>Stage</th>
              <th className={opTh}>Status</th>
              <th className={opTh}>Latency</th>
              <th className={opTh}>Message</th>
              <th className={opTh}>Logs</th>
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
                  No validation runs recorded yet.
                </td>
              </tr>
            ) : null}
            {(rows ?? []).map((r) => (
              <tr key={r.id} className={opTr}>
                <td className={opTd}>
                  <span className="font-mono text-[10px] text-slate-600 dark:text-gdc-mutedStrong">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px]">{r.validation_id}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px]">{r.stream_id ?? '—'}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px]">{r.validation_stage}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px]">{r.status}</span>
                </td>
                <td className={opTd}>
                  <span className="font-mono text-[11px] tabular-nums">{r.latency_ms ?? '—'}</span>
                </td>
                <td className={opTd}>
                  <span className="line-clamp-2 font-mono text-[10px] text-slate-700 dark:text-slate-200">{r.message}</span>
                </td>
                <td className={opTd}>
                  {r.run_id && r.stream_id != null ? (
                    <Link
                      className="text-[11px] text-violet-700 hover:underline dark:text-violet-300"
                      to={logsExplorerPath({ stream_id: r.stream_id, run_id: r.run_id })}
                    >
                      Logs
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
