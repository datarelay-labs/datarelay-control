import { Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import {
  bulkExecuteGovernanceReplay,
  executeGovernanceReplay,
  fetchGovernanceReplayDetail,
  fetchGovernanceReplayEvents,
  type GovernanceReplayDetailResponse,
  type GovernanceReplayEntry,
  type ReplayDisplayStatus,
  type ReplayWindow,
} from '../../api/gdcGovernanceReplay'
import { fetchStreamsList } from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { NAV_PATH } from '../../config/nav-paths'
import { canExecuteReplay, governanceReadOnlyReason } from '../../lib/governance-rbac'
import { humanizeQuarantineReason } from '../../lib/humanize-quarantine-reason'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'

const WINDOWS: readonly ReplayWindow[] = ['24h', '7d', '30d'] as const
const STATUSES: readonly ReplayDisplayStatus[] = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DISCARDED'] as const

function formatTime(iso: string | null | undefined) {
  return formatTimestampWithResolvedTimezone(iso)
}

function statusBadgeClass(status: ReplayDisplayStatus) {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    case 'RUNNING':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
    case 'COMPLETED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    case 'DISCARDED':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
}

function isRetryable(entry: GovernanceReplayEntry) {
  return entry.status === 'PENDING' || entry.status === 'FAILED'
}

function ReplayDetailDrawer({
  detail,
  loading,
  actionLoading,
  readOnly,
  onClose,
  onExecute,
}: {
  detail: GovernanceReplayDetailResponse | null
  loading: boolean
  actionLoading: boolean
  readOnly: boolean
  onClose: () => void
  onExecute: () => void
}) {
  const entry = detail?.entry
  const strip = detail?.error_message ?? detail?.outcome ?? entry?.status ?? null

  return (
    <GovernanceInvestigationDrawer
      title="Replay investigation"
      testId="replay-detail-drawer"
      closeTestId="replay-detail-close"
      loading={loading}
      hasContent={Boolean(detail && entry)}
      onClose={onClose}
      rootCauseStrip={strip}
      rootCauseTestId="replay-root-cause-strip"
      whatHappenedTestId="replay-section-what-happened"
      whyTestId="replay-section-why"
      whatShouldIDoTestId="replay-section-what-should-i-do"
      whatHappened={
        detail && entry ? (
          <>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{detail.policy_summary.policy_name}</p>
            <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{entry.stream_name}</p>
            <span
              className={cn('inline-flex rounded px-2 py-0.5 text-[11px] font-semibold', statusBadgeClass(entry.status))}
            >
              {entry.status}
            </span>
            <p className="text-[12px] text-slate-500">Replay #{entry.id} · {formatTime(entry.created_at)}</p>
          </>
        ) : null
      }
      why={
        detail && entry ? (
          <>
            <p className="text-[13px] text-slate-800 dark:text-slate-200">{detail.source.origin}</p>
            {detail.source.violation ? (
              <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
                Violation triggered recovery · {detail.source.violation.reason}
              </p>
            ) : null}
            {detail.source.quarantine ? (
              <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
                Quarantine #{detail.source.quarantine.quarantine_event_id} ·{' '}
                {humanizeQuarantineReason(detail.source.quarantine.quarantine_reason)}
              </p>
            ) : null}
            {detail.error_message ? (
              <p className="text-[12px] text-red-600 dark:text-red-400">{detail.error_message}</p>
            ) : null}
          </>
        ) : null
      }
      related={
        detail ? (
          <>
            <ul className="space-y-1.5 text-[12px] text-slate-700 dark:text-gdc-muted">
              {detail.timeline.map((step) => (
                <li key={step.step} data-testid={`replay-timeline-${step.step}`}>
                  <span className="font-medium text-slate-800 dark:text-slate-200">{step.label}</span>
                  {' · '}
                  {formatTime(step.event_time)}
                </li>
              ))}
            </ul>
            {detail.correlation_id ? (
              <p className="mt-2 text-[12px] text-slate-600 dark:text-gdc-muted">
                Correlation:{' '}
                <Link
                  to={`${NAV_PATH.governanceAudit}?correlation=${encodeURIComponent(detail.correlation_id)}`}
                  className="font-mono text-violet-700 hover:underline dark:text-violet-300"
                  data-testid="replay-audit-link"
                >
                  {detail.correlation_id}
                </Link>
              </p>
            ) : null}
            {detail.outcome ? (
              <p className="mt-2 text-[12px] font-medium text-slate-800 dark:text-slate-200">Outcome: {detail.outcome}</p>
            ) : (
              <p className="mt-2 text-[12px] text-slate-500">Pending delivery</p>
            )}
          </>
        ) : null
      }
      whatShouldIDo={
        detail && entry ? (
          <div className="flex flex-wrap gap-2">
            {!readOnly && detail.can_execute ? (
              <button
                type="button"
                disabled={actionLoading}
                onClick={onExecute}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                data-testid="replay-action-execute"
              >
                Replay
              </button>
            ) : null}
            {detail.source.violation ? (
              <Link
                to={NAV_PATH.governanceViolations}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              >
                View details
              </Link>
            ) : null}
            {detail.source.quarantine ? (
              <Link
                to={`${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.source.quarantine.quarantine_event_id))}`}
                className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                data-testid="replay-open-quarantine"
              >
                View details
              </Link>
            ) : null}
          </div>
        ) : null
      }
    />
  )
}

function ReplaySection({
  title,
  subtitle,
  events,
  testId,
}: {
  title: string
  subtitle: string
  events: GovernanceReplayEntry[]
  testId: string
}) {
  if (events.length === 0) return null
  return (
    <section className="rounded-xl border border-slate-200/90 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card" data-testid={testId}>
      <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</p>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">{subtitle}</p>
      <ul className="mt-2 space-y-1 text-[12px] text-slate-700 dark:text-gdc-muted">
        {events.slice(0, 5).map((e) => (
          <li key={e.id}>
            #{e.id} · {e.stream_name} · {e.status}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ReplayCenterPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlStatusParam = searchParams.get('status')?.toUpperCase()

  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<GovernanceReplayEntry[]>([])
  const [queueCount, setQueueCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [recentCount, setRecentCount] = useState(0)
  const [window, setWindow] = useState<ReplayWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [streamId, setStreamId] = useState<number | ''>('')
  const [status, setStatus] = useState<ReplayDisplayStatus | ''>(() => {
    if (urlStatusParam && STATUSES.includes(urlStatusParam as ReplayDisplayStatus)) {
      return urlStatusParam as ReplayDisplayStatus
    }
    return ''
  })
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [drawerId, setDrawerId] = useState<number | null>(null)
  const [detail, setDetail] = useState<GovernanceReplayDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingIds, setPendingIds] = useState<number[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmTypeValue, setConfirmTypeValue] = useState('')

  const readOnly = !canExecuteReplay()
  const readOnlyReason = governanceReadOnlyReason()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetchGovernanceReplayEvents({
        window,
        policy_id: policyId === '' ? undefined : policyId,
        stream_id: streamId === '' ? undefined : streamId,
        status: status === '' ? undefined : status,
      })
      setEvents(resp?.replay_events ?? [])
      setQueueCount(resp?.queue_count ?? 0)
      setFailedCount(resp?.failed_count ?? 0)
      setRecentCount(resp?.recent_count ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [window, policyId, streamId, status])

  useEffect(() => {
    void fetchGovernancePolicies().then((r) => setPolicies(r?.policies ?? []))
    void fetchStreamsList().then((r) => setStreams(r ?? []))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const updateStatusFilter = (next: ReplayDisplayStatus | '') => {
    setStatus(next)
    const params = new URLSearchParams(searchParams)
    if (next === '') params.delete('status')
    else params.set('status', next)
    setSearchParams(params, { replace: true })
  }

  const openDetail = async (id: number) => {
    setDrawerId(id)
    setDetailLoading(true)
    setDetail(null)
    try {
      const d = await fetchGovernanceReplayDetail(id, '30d')
      setDetail(d)
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    setDrawerId(null)
    setDetail(null)
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    const retryable = events.filter(isRetryable)
    if (selectedIds.size === retryable.length && retryable.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(retryable.map((e) => e.id)))
    }
  }

  const requestExecute = (ids: number[]) => {
    if (readOnly || ids.length === 0) return
    setActionError(null)
    setError(null)
    setConfirmTypeValue('')
    setPendingIds(ids)
  }

  const runExecute = async (ids: number[]) => {
    requestExecute(ids)
  }

  const executePending = async () => {
    if (readOnly || !pendingIds || pendingIds.length === 0) return
    const ids = pendingIds
    setActionLoading(true)
    setActionError(null)
    setError(null)
    try {
      if (ids.length === 1) {
        const result = await executeGovernanceReplay(ids[0])
        if (result.outcome !== 'replayed') {
          const msg = result.message || 'Replay failed.'
          setActionError(msg)
          setError(msg)
          return
        }
      } else {
        const result = await bulkExecuteGovernanceReplay(ids)
        if (result.failed > 0) {
          const msg = result.results.find((r) => r.outcome !== 'replayed')?.message ?? 'Some replays failed.'
          setActionError(msg)
          setError(msg)
          return
        }
      }
      setPendingIds(null)
      setSelectedIds(new Set())
      closeDetail()
      await load()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setActionError(msg)
      setError(msg)
    } finally {
      setActionLoading(false)
    }
  }

  const queueEvents = useMemo(
    () => events.filter((e) => e.status === 'PENDING' || e.status === 'RUNNING'),
    [events],
  )
  const failedEvents = useMemo(() => events.filter((e) => e.status === 'FAILED'), [events])
  const recentEvents = useMemo(() => events.filter((e) => e.status === 'COMPLETED'), [events])
  const policyOptions = useMemo(() => policies.map((p) => ({ id: p.id, name: p.name })), [policies])
  const streamOptions = useMemo(() => streams.map((s) => ({ id: s.id, name: s.name })), [streams])
  const retryableSelected = useMemo(
    () => [...selectedIds].filter((id) => events.some((e) => e.id === id && isRetryable(e))),
    [selectedIds, events],
  )

  return (
    <div className="space-y-4" data-testid="replay-center-page">
      {readOnlyReason ? (
        <div
          role="status"
          data-testid="replay-read-only-banner"
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-[12px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200/90 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-slate-100">
              <RotateCcw className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
              Replay Operations
            </p>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">
              What is waiting? What failed? What succeeded? What should I retry?
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            data-testid="replay-refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" data-testid="replay-filters">
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value as ReplayWindow)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="replay-filter-window"
            aria-label="Time range"
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <select
            value={policyId}
            onChange={(e) => setPolicyId(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="replay-filter-policy"
            aria-label="Policy"
          >
            <option value="">All policies</option>
            {policyOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={streamId}
            onChange={(e) => setStreamId(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="replay-filter-stream"
            aria-label="Stream"
          >
            <option value="">All streams</option>
            {streamOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => updateStatusFilter(e.target.value as ReplayDisplayStatus | '')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="replay-filter-status"
            aria-label="Status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {!readOnly && retryableSelected.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="replay-bulk-actions">
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runExecute(retryableSelected)}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              data-testid="replay-bulk-execute"
            >
              Execute Selected ({retryableSelected.length})
            </button>
          </div>
        ) : null}
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <ReplaySection
          title="Replay Queue"
          subtitle={`${queueCount} waiting`}
          events={queueEvents}
          testId="replay-section-queue"
        />
        <ReplaySection
          title="Failed Replay"
          subtitle={`${failedCount} failed`}
          events={failedEvents}
          testId="replay-section-failed"
        />
        <ReplaySection
          title="Recent Replay Activity"
          subtitle={`${recentCount} completed`}
          events={recentEvents}
          testId="replay-section-recent"
        />
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && events.length === 0 && !error ? (
        <div
          className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center dark:border-gdc-border dark:bg-gdc-card/50"
          data-testid="replay-empty-state"
        >
          <p className="text-[13px] font-medium text-slate-700 dark:text-slate-200">No replay events found</p>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">Try a wider time range or adjust filters.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white dark:border-gdc-border dark:bg-gdc-card">
          <table className={opTable} data-testid="replay-table">
            <thead>
              <tr className={opThRow}>
                {!readOnly ? (
                  <th className={opTh}>
                    <input
                      type="checkbox"
                      checked={events.filter(isRetryable).length > 0 && selectedIds.size === events.filter(isRetryable).length}
                      onChange={toggleSelectAll}
                      aria-label="Select all retryable"
                      data-testid="replay-select-all"
                    />
                  </th>
                ) : null}
                <th className={opTh}>Replay ID</th>
                <th className={opTh}>Policy</th>
                <th className={opTh}>Stream</th>
                <th className={opTh}>Status</th>
                <th className={opTh}>Created At</th>
                <th className={opTh}>Completed At</th>
                <th className={opTh}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr className={opTr}>
                  <td className={opTd} colSpan={readOnly ? 7 : 8}>
                    <Loader2 className="inline h-4 w-4 animate-spin" aria-hidden /> Loading…
                  </td>
                </tr>
              ) : (
                events.map((entry) => (
                  <tr
                    key={entry.id}
                    className={cn(opTr, 'cursor-pointer hover:bg-slate-50 dark:hover:bg-gdc-rowHover')}
                    data-testid={`replay-row-${entry.id}`}
                    onClick={() => void openDetail(entry.id)}
                  >
                    {!readOnly ? (
                      <td className={opTd} onClick={(e) => e.stopPropagation()}>
                        {isRetryable(entry) ? (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(entry.id)}
                            onChange={() => toggleSelect(entry.id)}
                            aria-label={`Select replay ${entry.id}`}
                            data-testid={`replay-select-${entry.id}`}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td className={opTd}>#{entry.id}</td>
                    <td className={opTd}>{entry.policy_name}</td>
                    <td className={opTd}>{entry.stream_name}</td>
                    <td className={opTd}>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', statusBadgeClass(entry.status))}>
                        {entry.status}
                      </span>
                    </td>
                    <td className={opTd}>{formatTime(entry.created_at)}</td>
                    <td className={opTd}>{formatTime(entry.completed_at)}</td>
                    <td className={opTd}>{entry.outcome ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {drawerId != null ? (
        <ReplayDetailDrawer
          detail={detail}
          loading={detailLoading}
          actionLoading={actionLoading}
          readOnly={readOnly}
          onClose={closeDetail}
          onExecute={() => void runExecute([drawerId])}
        />
      ) : null}

      {pendingIds ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && !actionLoading) {
              setPendingIds(null)
              setActionError(null)
              setConfirmTypeValue('')
            }
          }}
          title={
            pendingIds.length > 1
              ? `Execute ${pendingIds.length} replay jobs?`
              : 'Execute replay job?'
          }
          targetName={
            pendingIds.length === 1
              ? `replay #${pendingIds[0]}`
              : `${pendingIds.length} selected replay jobs`
          }
          risk="high"
          confirmMode={pendingIds.length > 1 ? 'type-name' : 'click'}
          expectedTypeName={pendingIds.length > 1 ? 'REPLAY' : ''}
          typeNameValue={confirmTypeValue}
          onTypeNameChange={setConfirmTypeValue}
          impactBullets={[
            'Re-delivers stored payloads to destinations without advancing production checkpoints.',
            'Duplicate downstream delivery is possible; platform deduplication is not assumed.',
            'Already-completed replay jobs are rejected by the backend.',
          ]}
          dependencies={[{ label: 'Selected replay jobs', count: pendingIds.length }]}
          reversibility="Replay cannot be undone. Destination systems may receive duplicate records."
          primaryLabel={pendingIds.length > 1 ? 'Execute selected' : 'Execute replay'}
          busy={actionLoading}
          error={actionError}
          onConfirm={() => void executePending()}
          dataTestId="replay-center-execute-dialog"
        />
      ) : null}
    </div>
  )
}
