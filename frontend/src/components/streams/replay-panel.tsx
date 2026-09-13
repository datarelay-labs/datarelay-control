import { Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  discardStreamReplayEvent,
  fetchStreamReplayEvents,
  fetchStreamReplaySummary,
  replayStreamReplayEvent,
  type ReplayEventItem,
  type StreamReplaySummaryResponse,
} from '../../api/gdcReplay'
import { notifyStreamGovernanceChanged } from '../../lib/stream-governance-events'
import { compatibleGovernancePreload } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

type PendingReplayAction = {
  kind: 'replay' | 'discard'
  row: ReplayEventItem
}

function statusBadge(status: string): string {
  switch (status) {
    case 'pending':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200'
    case 'replayed':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300'
    case 'discarded':
      return 'bg-slate-200 text-slate-700 dark:bg-gdc-elevated dark:text-gdc-muted'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-gdc-elevated dark:text-slate-300'
  }
}

export function ReplayPanel({
  streamId,
  canOperate,
  initialSummary,
}: {
  streamId: number
  canOperate: boolean
  initialSummary?: StreamReplaySummaryResponse | null
}) {
  const preload = compatibleGovernancePreload(streamId, initialSummary)
  const preloadRef = useRef(preload)
  preloadRef.current = preload
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<StreamReplaySummaryResponse | null>(preload ?? null)
  const [events, setEvents] = useState<ReplayEventItem[]>([])
  const [actionBusy, setActionBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingReplayAction | null>(null)
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
        const e = await fetchStreamReplayEvents(streamId, undefined, 30)
        setEvents(e?.events ?? [])
        if (preloadRef.current == null && e == null) {
          setError('Replay APIs unavailable.')
        }
        return
      }
      const [s, e] = await Promise.all([
        fetchStreamReplaySummary(streamId),
        fetchStreamReplayEvents(streamId, undefined, 30),
      ])
      setSummary(s)
      setEvents(e?.events ?? [])
      if (s == null && e == null) {
        setError('Replay APIs unavailable.')
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
    setActionBusy(true)
    setActionError(null)
    setMessage(null)
    try {
      const res =
        kind === 'replay' ? await replayStreamReplayEvent(row.id) : await discardStreamReplayEvent(row.id)
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
      aria-label="Replay"
      data-testid="replay-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Replay</p>
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
        <ul className="mt-2 flex flex-wrap gap-2 text-[11px] tabular-nums" data-testid="replay-summary">
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Pending </span>
            <span className="font-semibold text-amber-800 dark:text-amber-200">{summary.pending_count}</span>
          </li>
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Failed </span>
            <span className="font-semibold text-red-700 dark:text-red-300">{summary.failed_count}</span>
          </li>
          <li>
            <span className="text-slate-500 dark:text-gdc-muted">Replayed </span>
            <span className="font-semibold text-emerald-800 dark:text-emerald-200">{summary.replayed_count}</span>
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
        <table className={cn(opTable, 'min-w-full text-[11px]')} data-testid="replay-events-table">
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>ID</th>
              <th className={opTh}>Status</th>
              <th className={opTh}>Dest</th>
              <th className={opTh}>Kind</th>
              <th className={opTh}>Events</th>
              <th className={opTh}>Retries</th>
              <th className={opTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 ? (
              <tr className={opTr}>
                <td colSpan={7} className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')}>
                  No replay events recorded.
                </td>
              </tr>
            ) : (
              events.map((row) => (
                <tr key={row.id} className={opTr} data-testid={`replay-event-row-${row.id}`}>
                  <td className={cn(opTd, 'font-mono')}>{row.id}</td>
                  <td className={opTd}>
                    <span className={cn('rounded px-1.5 py-0.5 font-semibold uppercase', statusBadge(row.status))}>
                      {row.status}
                    </span>
                  </td>
                  <td className={cn(opTd, 'font-mono')}>{row.destination_id}</td>
                  <td className={opTd}>{row.delivery_kind}</td>
                  <td className={cn(opTd, 'tabular-nums')}>{row.event_count}</td>
                  <td className={cn(opTd, 'tabular-nums')}>{row.retry_count}</td>
                  <td className={opTd}>
                    <div className="flex flex-wrap gap-1">
                      {(row.status === 'pending' || row.status === 'failed') && canOperate ? (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => {
                            setActionError(null)
                            setPending({ kind: 'replay', row })
                          }}
                          className="inline-flex items-center gap-0.5 rounded border border-violet-300 px-1.5 py-0.5 font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-950/40"
                          data-testid={`replay-event-replay-${row.id}`}
                        >
                          <RotateCcw className="h-3 w-3" aria-hidden />
                          Replay
                        </button>
                      ) : null}
                      {row.status !== 'discarded' && row.status !== 'replayed' && canOperate ? (
                        <button
                          type="button"
                          disabled={actionBusy}
                          onClick={() => {
                            setActionError(null)
                            setPending({ kind: 'discard', row })
                          }}
                          className="inline-flex items-center gap-0.5 rounded border border-slate-300 px-1.5 py-0.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                          data-testid={`replay-event-discard-${row.id}`}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                          Discard
                        </button>
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
          title={pending.kind === 'replay' ? 'Replay stored event?' : 'Discard replay event?'}
          targetName={`replay #${pending.row.id} · stream ${streamId} · destination ${pending.row.destination_id}`}
          risk={pending.kind === 'replay' ? 'high' : 'medium'}
          impactBullets={
            pending.kind === 'replay'
              ? [
                  'Re-delivers the stored payload to the destination without advancing the production checkpoint.',
                  'Duplicate downstream delivery is possible; platform deduplication is not assumed.',
                  'Already-replayed events are rejected by the backend (409).',
                ]
              : [
                  'Marks this replay job discarded so it will not execute.',
                  'The original failure history remains for audit.',
                ]
          }
          dependencies={[
            { label: 'Events in payload', count: pending.row.event_count },
            { label: 'Delivery kind', detail: pending.row.delivery_kind },
            { label: 'Retries so far', count: pending.row.retry_count },
          ]}
          reversibility={
            pending.kind === 'replay'
              ? 'Replay cannot be undone. Destination systems may receive duplicate records.'
              : 'Discard is permanent for this replay job.'
          }
          primaryLabel={pending.kind === 'replay' ? 'Execute replay' : 'Discard replay'}
          busy={actionBusy}
          error={actionError}
          onConfirm={() => void executePending()}
          dataTestId={pending.kind === 'replay' ? 'replay-execute-dialog' : 'replay-discard-dialog'}
        />
      ) : null}
    </section>
  )
}
