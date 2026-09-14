import { ClipboardList, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { listAuditLogs, type AuditLogItemDto } from '../../api/gdcAudit'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

const PAGE_SIZE = 100

function formatTs(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function entityLabel(row: AuditLogItemDto) {
  if (!row.entity_type) return '—'
  const id = row.entity_id != null ? `#${row.entity_id}` : ''
  return `${row.entity_type}${id ? ` ${id}` : ''}`
}

function resultBadgeClass(result: string) {
  if (result === 'success') return 'border-emerald-500/35 bg-emerald-500/15 text-emerald-200'
  if (result === 'failure') return 'border-red-500/35 bg-red-500/15 text-red-200'
  return 'border-gdc-border bg-gdc-panel text-gdc-muted'
}

type AppliedFilters = {
  action: string
  entity_type: string
  result: string
}

export function AuditLogsPage() {
  const [rows, setRows] = useState<AuditLogItemDto[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionDraft, setActionDraft] = useState('')
  const [entityDraft, setEntityDraft] = useState('')
  const [resultDraft, setResultDraft] = useState('')
  const [applied, setApplied] = useState<AppliedFilters>({ action: '', entity_type: '', result: '' })
  const [offset, setOffset] = useState(0)

  const load = useCallback(async (nextOffset: number, filters: AppliedFilters) => {
    setBusy(true)
    setError(null)
    try {
      const res = await listAuditLogs({
        action: filters.action.trim() || undefined,
        entity_type: filters.entity_type.trim() || undefined,
        result: filters.result.trim() || undefined,
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setRows(res.items)
      setTotal(res.total)
      setOffset(nextOffset)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit logs')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(0, { action: '', entity_type: '', result: '' })
  }, [load])

  const applyFilters = () => {
    const next = {
      action: actionDraft,
      entity_type: entityDraft,
      result: resultDraft,
    }
    setApplied(next)
    void load(0, next)
  }

  const pageStart = total === 0 ? 0 : offset + 1
  const pageEnd = offset + rows.length
  const canPrev = offset > 0 && !busy
  const canNext = offset + rows.length < total && !busy

  return (
    <div className="space-y-6" data-testid="audit-logs-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className={cn('text-xl font-semibold', gdcUi.textTitle)}>Audit Logs</h1>
          <p className={cn(gdcUi.textMuted, 'mt-1 max-w-2xl text-sm')}>
            Operator and administrator actions recorded separately from runtime delivery logs.
          </p>
        </div>
        <button
          type="button"
          className={gdcUi.secondaryBtn}
          disabled={busy}
          onClick={() => void load(offset, applied)}
          data-testid="audit-logs-refresh"
        >
          <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <div className={cn(gdcUi.cardShell, 'p-4')}>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gdc-muted">
            Action
            <input
              className={gdcUi.input}
              value={actionDraft}
              onChange={(e) => setActionDraft(e.target.value)}
              placeholder="USER_LOGIN"
              data-testid="audit-filter-action"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gdc-muted">
            Entity type
            <input
              className={gdcUi.input}
              value={entityDraft}
              onChange={(e) => setEntityDraft(e.target.value)}
              placeholder="STREAM"
              data-testid="audit-filter-entity"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gdc-muted">
            Result
            <select
              className={gdcUi.input}
              value={resultDraft}
              onChange={(e) => setResultDraft(e.target.value)}
              data-testid="audit-filter-result"
            >
              <option value="">All</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
            </select>
          </label>
          <button
            type="button"
            className={gdcUi.primaryBtn}
            disabled={busy}
            onClick={applyFilters}
            data-testid="audit-filter-apply"
          >
            Apply filters
          </button>
        </div>

        {error ? (
          <p className="text-sm text-red-300" data-testid="audit-logs-error">
            {error}
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="audit-logs-table">
            <thead>
              <tr className="border-b border-gdc-border text-xs uppercase tracking-wide text-gdc-muted">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Actor</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gdc-muted">
                    {busy ? 'Loading…' : 'No audit entries match the current filters.'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-b border-gdc-border/60 hover:bg-gdc-elevated/40">
                    <td className="whitespace-nowrap px-3 py-2 text-gdc-muted">{formatTs(row.created_at)}</td>
                    <td className="px-3 py-2">{row.actor_username || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.action}</td>
                    <td className="px-3 py-2 text-gdc-muted">{entityLabel(row)}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          'inline-flex rounded border px-2 py-0.5 text-xs font-medium',
                          resultBadgeClass(row.result),
                        )}
                      >
                        {row.result}
                      </span>
                    </td>
                    <td className="max-w-md truncate px-3 py-2" title={row.summary || ''}>
                      {row.summary || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-gdc-muted">
          <p className="flex items-center gap-2">
            <ClipboardList className="h-3.5 w-3.5" />
            Showing {pageStart}-{pageEnd} of {total} entries
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={gdcUi.secondaryBtn}
              disabled={!canPrev}
              onClick={() => void load(Math.max(0, offset - PAGE_SIZE), applied)}
              data-testid="audit-logs-prev"
            >
              Previous
            </button>
            <button
              type="button"
              className={gdcUi.secondaryBtn}
              disabled={!canNext}
              onClick={() => void load(offset + PAGE_SIZE, applied)}
              data-testid="audit-logs-next"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
