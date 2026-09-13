import { Loader2, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  discardStreamQuarantineEvent,
  fetchStreamQuarantineEvents,
  fetchStreamQuarantineSummary,
  releaseStreamQuarantineEvent,
  type QuarantineEventItem,
  type StreamQuarantineSummaryResponse,
} from '../../api/gdcQuarantine'
import { humanizeQuarantineReason } from '../../lib/humanize-quarantine-reason'
import { notifyStreamGovernanceChanged } from '../../lib/stream-governance-events'
import { compatibleGovernancePreload } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

type PendingQuarantineAction = {
  kind: 'release' | 'discard'
  row: QuarantineEventItem
}

function statusBadge(status: string): string {
  switch (status) {
    case 'quarantined':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
    case 'released':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
    case 'discarded':
      return 'bg-slate-200 text-slate-700 dark:bg-gdc-elevated dark:text-gdc-muted'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-gdc-elevated dark:text-slate-300'
  }
}

export function QuarantinePanel({
  streamId,
  canOperate,
  initialSummary,
}: {
  streamId: number
  canOperate: boolean
  initialSummary?: StreamQuarantineSummaryResponse | null
}) {
  const preload = compatibleGovernancePreload(streamId, initialSummary)
  const preloadRef = useRef(preload)
  preloadRef.current = preload
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<StreamQuarantineSummaryResponse | null>(preload ?? null)
  const [events, setEvents] = useState<QuarantineEventItem[]>([])
  const [actionBusy, setActionBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingQuarantineAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (preload != null) setSummary(preload)
  }, [preload])

  const load = useCallback(async (opts?: { skipSummary?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      const skipSummary = opts?.skipSummary === true
      if (skipSummary) {
        const e = await fetchStreamQuarantineEvents(streamId, undefined, 30)
        setEvents(e?.events ?? [])
        if (preloadRef.current == null && e == null) {
          setError('Quarantine APIs unavailable.')
        }
        return
      }
      const [s, e] = await Promise.all([
        fetchStreamQuarantineSummary(streamId),
        fetchStreamQuarantineEvents(streamId, undefined, 30),
      ])
      setSummary(s)
      setEvents(e?.events ?? [])
      if (s == null && e == null) {
        setError('Quarantine APIs unavailable.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [streamId])

  useEffect(() => {
    const skipSummary = preloadRef.current != null
    void load({ skipSummary })
  }, [streamId, load])

  async function executePending() {
    if (!pending || !canOperate) return
    const { kind, row } = pending
    if (row.status !== 'quarantined') return
    setActionBusy(true)
    setActionError(null)
    setMessage(null)
    try {
      const res =
        kind === 'release'
          ? await releaseStreamQuarantineEvent(row.id)
          : await discardStreamQuarantineEvent(row.id)
      setMessage(res.message)
      setPending(null)
      await load()
      notifyStreamGovernanceChanged(streamId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <section
      className="rounded-xl border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Quarantine"
      data-testid="quarantine-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Quarantine</p>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-[12px] font-medium text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      {summary ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-[11px] tabular-nums" data-testid="quarantine-summary">
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Quarantined </span>
            <span className="font-semibold text-amber-800 dark:text-amber-200">{summary.quarantined_count}</span>
          </li>
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Released </span>
            <span className="font-semibold text-emerald-800 dark:text-emerald-200">{summary.released_count}</span>
          </li>
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Discarded </span>
            <span className="font-semibold text-slate-700 dark:text-slate-300">{summary.discarded_count}</span>
          </li>
        </ul>
      ) : null}

      {message ? (
        <p className="mt-2 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">{message}</p>
      ) : null}

      <div className="mt-3 overflow-x-auto">
        <table className={cn(opTable, 'min-w-full text-[11px]')} data-testid="quarantine-events-table">
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>ID</th>
              <th className={opTh}>Status</th>
              <th className={opTh}>Source</th>
              <th className={opTh}>Reason</th>
              <th className={opTh}>Events</th>
              <th className={opTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr className={opTr}>
                <td colSpan={6} className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')}>
                  No quarantine events.
                </td>
              </tr>
            ) : (
              events.map((row) => (
                <tr key={row.id} className={opTr} data-testid={`quarantine-event-row-${row.id}`}>
                  <td className={cn(opTd, 'font-mono')}>{row.id}</td>
                  <td className={opTd}>
                    <span className={cn('rounded px-1.5 py-0.5 font-semibold uppercase', statusBadge(row.status))}>
                      {row.status}
                    </span>
                  </td>
                  <td className={opTd}>{row.quarantine_source}</td>
                  <td
                    className={cn(opTd, 'max-w-[12rem] truncate')}
                    title={humanizeQuarantineReason(row.quarantine_reason, { quarantineSource: row.quarantine_source })}
                  >
                    {humanizeQuarantineReason(row.quarantine_reason, { quarantineSource: row.quarantine_source })}
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>{row.event_count}</td>
                  <td className={opTd}>
                    <div className="flex flex-wrap gap-1">
                      {row.status === 'quarantined' && canOperate ? (
                        <>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => {
                              setActionError(null)
                              setPending({ kind: 'release', row })
                            }}
                            className="inline-flex items-center gap-0.5 rounded border border-emerald-300 px-1.5 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-200 dark:hover:bg-emerald-950/40"
                            data-testid={`quarantine-event-release-${row.id}`}
                          >
                            <Send className="h-3 w-3" aria-hidden />
                            Release
                          </button>
                          <button
                            type="button"
                            disabled={actionBusy}
                            onClick={() => {
                              setActionError(null)
                              setPending({ kind: 'discard', row })
                            }}
                            className="inline-flex items-center gap-0.5 rounded border border-slate-300 px-1.5 py-0.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                            data-testid={`quarantine-event-discard-${row.id}`}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden />
                            Discard
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pending ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && !actionBusy) {
              setPending(null)
              setActionError(null)
            }
          }}
          title={pending.kind === 'release' ? 'Release quarantine event?' : 'Discard quarantine event permanently?'}
          targetName={`quarantine #${pending.row.id} · stream ${streamId}`}
          risk={pending.kind === 'discard' ? 'critical' : 'high'}
          impactBullets={
            pending.kind === 'release'
              ? [
                  'Delivers the held payload to the configured destination.',
                  'May advance the stream checkpoint as part of release.',
                  'Duplicate downstream delivery is possible if the event was partially processed earlier.',
                ]
              : [
                  'Permanently discards this held quarantine payload.',
                  'The event will not be delivered to destinations.',
                  'This cannot be undone from the product UI.',
                ]
          }
          dependencies={[
            { label: 'Held events', count: pending.row.event_count },
            { label: 'Reason', detail: humanizeQuarantineReason(pending.row.quarantine_reason, { quarantineSource: pending.row.quarantine_source }) },
          ]}
          reversibility={
            pending.kind === 'release'
              ? 'Release is not reversible. Deduplication is not guaranteed unless the destination enforces it.'
              : 'Discard is irreversible. Re-fetch or re-quarantine would be required to recover equivalent data.'
          }
          primaryLabel={pending.kind === 'release' ? 'Release event' : 'Discard event'}
          busy={actionBusy}
          error={actionError}
          onConfirm={() => void executePending()}
          dataTestId={pending.kind === 'release' ? 'quarantine-release-dialog' : 'quarantine-discard-dialog'}
        />
      ) : null}
    </section>
  )
}
