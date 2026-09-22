import { Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { NAV_PATH, logsExplorerPath } from '../../config/nav-paths'
import { canExecuteReplay, governanceReadOnlyReason } from '../../lib/governance-rbac'
import { gdcUi } from '../../lib/gdc-ui-tokens'
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

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function parseReplayId(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

function statusBadgeClass(status: ReplayDisplayStatus) {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-200'
    case 'RUNNING':
      return 'bg-blue-500/15 text-blue-800 ring-1 ring-blue-500/30 dark:text-blue-200'
    case 'COMPLETED':
      return 'bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30 dark:text-emerald-200'
    case 'FAILED':
      return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
    case 'DISCARDED':
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
    default:
      return 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300'
  }
}

function statusLabel(status: ReplayDisplayStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Pending'
    case 'RUNNING':
      return 'Running'
    case 'COMPLETED':
      return 'Completed'
    case 'FAILED':
      return 'Failed'
    case 'DISCARDED':
      return 'Discarded'
    default:
      return status
  }
}

function isRetryable(entry: GovernanceReplayEntry) {
  return entry.status === 'PENDING' || entry.status === 'FAILED'
}

function actionButtonClass(variant: 'primary' | 'secondary' = 'secondary') {
  if (variant === 'primary') {
    return 'inline-flex rounded-md border border-violet-600 bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 disabled:opacity-50'
  }
  return 'inline-flex rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover'
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
  const violationHref = detail?.source.violation
    ? `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(detail.source.violation.violation_id)}`
    : null
  const quarantineHref = detail?.source.quarantine
    ? `${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.source.quarantine.quarantine_event_id))}`
    : null
  const logsHref = entry
    ? logsExplorerPath({ stream_id: entry.stream_id, stage: 'quarantine_event_created' })
    : null

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
      relatedTestId="replay-section-related"
      whatHappened={
        detail && entry ? (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Policy
              </p>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {detail.policy_summary.policy_name}
              </p>
              {detail.policy_summary.policy_version != null ? (
                <p className="text-xs text-slate-500 dark:text-gdc-muted">
                  Version {detail.policy_summary.policy_version}
                  {detail.policy_summary.policy_status
                    ? ` · ${detail.policy_summary.policy_status}`
                    : ''}
                </p>
              ) : null}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Stream
              </p>
              <p className="text-sm text-slate-800 dark:text-slate-200">{entry.stream_name}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                  statusBadgeClass(entry.status),
                )}
              >
                {statusLabel(entry.status)}
              </span>
              <span className="text-xs text-slate-500 dark:text-gdc-muted">
                Replay #{entry.id} · {formatTime(entry.created_at)}
              </span>
            </div>
          </div>
        ) : null
      }
      why={
        detail && entry ? (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Source origin
              </p>
              <p className="text-sm text-slate-800 dark:text-slate-200">{detail.source.origin}</p>
            </div>
            {detail.source.violation ? (
              <p className="text-sm text-slate-600 dark:text-gdc-muted">
                Violation triggered recovery · {detail.source.violation.reason}
              </p>
            ) : null}
            {detail.source.quarantine ? (
              <p className="text-sm text-slate-600 dark:text-gdc-muted">
                Quarantine #{detail.source.quarantine.quarantine_event_id} ·{' '}
                {humanizeQuarantineReason(detail.source.quarantine.quarantine_reason)}
              </p>
            ) : null}
            {detail.error_message ? (
              <div
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
                data-testid="replay-error-message"
              >
                {detail.error_message}
              </div>
            ) : null}
          </div>
        ) : null
      }
      related={
        detail ? (
          <div className="space-y-3" data-testid="replay-related-evidence">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Timeline
              </p>
              <ul className="mt-1.5 space-y-1.5 text-sm text-slate-700 dark:text-gdc-muted">
                {detail.timeline.map((step) => (
                  <li key={step.step} data-testid={`replay-timeline-${step.step}`}>
                    <span className="font-medium text-slate-800 dark:text-slate-200">{step.label}</span>
                    {' · '}
                    {formatTime(step.event_time)}
                  </li>
                ))}
              </ul>
            </div>
            {detail.correlation_id ? (
              <p className="text-sm text-slate-600 dark:text-gdc-muted">
                Correlation:{' '}
                <Link
                  to={`${NAV_PATH.governanceAudit}?correlation=${encodeURIComponent(detail.correlation_id)}`}
                  className="font-mono text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                  data-testid="replay-audit-link"
                >
                  {detail.correlation_id}
                </Link>
              </p>
            ) : null}
            {detail.outcome ? (
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Outcome: {detail.outcome}
              </p>
            ) : (
              <p className="text-sm text-slate-500 dark:text-gdc-muted">Pending delivery</p>
            )}
            {violationHref ? (
              <Link
                to={violationHref}
                className="inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                data-testid="replay-related-violation-link"
              >
                Open Violation
              </Link>
            ) : null}
            {quarantineHref ? (
              <Link
                to={quarantineHref}
                className="ml-3 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                data-testid="replay-related-quarantine-link"
              >
                Open Quarantine
              </Link>
            ) : null}
          </div>
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
                className={actionButtonClass('primary')}
                data-testid="replay-action-execute"
              >
                Replay
              </button>
            ) : null}
            {violationHref ? (
              <Link to={violationHref} className={actionButtonClass()} data-testid="replay-open-violation">
                Open Violation
              </Link>
            ) : null}
            {quarantineHref ? (
              <Link
                to={quarantineHref}
                className={actionButtonClass()}
                data-testid="replay-open-quarantine"
              >
                Open Quarantine
              </Link>
            ) : null}
            {logsHref ? (
              <Link to={logsHref} className={actionButtonClass()} data-testid="replay-view-logs">
                View delivery records
              </Link>
            ) : null}
          </div>
        ) : null
      }
    />
  )
}

export function ReplayCenterPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlStatusParam = searchParams.get('status')?.toUpperCase()
  const urlId = parseReplayId(searchParams.get('id'))

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
  const [drawerId, setDrawerId] = useState<number | null>(urlId)
  const [detail, setDetail] = useState<GovernanceReplayDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingIds, setPendingIds] = useState<number[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmTypeValue, setConfirmTypeValue] = useState('')
  const openedFromUrlRef = useRef<number | null>(null)

  const readOnly = !canExecuteReplay()
  const readOnlyReason = governanceReadOnlyReason()
  const filtersActive = policyId !== '' || streamId !== '' || status !== ''

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
      if (resp == null) setError('Replay APIs unavailable.')
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

  const syncDrawerId = useCallback(
    (id: number | null) => {
      setDrawerId(id)
      const params = new URLSearchParams(searchParams)
      if (id != null) params.set('id', String(id))
      else params.delete('id')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const updateStatusFilter = (next: ReplayDisplayStatus | '') => {
    setStatus(next)
    const params = new URLSearchParams(searchParams)
    if (next === '') params.delete('status')
    else params.set('status', next)
    setSearchParams(params, { replace: true })
  }

  const openDetail = useCallback(
    async (id: number) => {
      syncDrawerId(id)
      setDetailLoading(true)
      setDetail(null)
      try {
        const d = await fetchGovernanceReplayDetail(id, '30d')
        setDetail(d)
        if (d == null) setError('Replay detail unavailable.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [syncDrawerId],
  )

  const closeDetail = useCallback(() => {
    openedFromUrlRef.current = null
    syncDrawerId(null)
    setDetail(null)
  }, [syncDrawerId])

  useEffect(() => {
    if (urlId == null) {
      openedFromUrlRef.current = null
      return
    }
    if (openedFromUrlRef.current === urlId) return
    openedFromUrlRef.current = urlId
    void openDetail(urlId)
  }, [urlId, openDetail])

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

  const policyOptions = useMemo(() => policies.map((p) => ({ id: p.id, name: p.name })), [policies])
  const streamOptions = useMemo(() => streams.map((s) => ({ id: s.id, name: s.name })), [streams])
  const retryableSelected = useMemo(
    () => [...selectedIds].filter((id) => events.some((e) => e.id === id && isRetryable(e))),
    [selectedIds, events],
  )

  const clearFilters = () => {
    setPolicyId('')
    setStreamId('')
    updateStatusFilter('')
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="replay-center-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            <RotateCcw className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
            Replay Center
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            Review the recovery queue, open a replay investigation, then execute or retry with the same
            confirmation safeguards and source evidence as before.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          data-testid="replay-refresh"
          aria-label="Refresh replay events"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
          Refresh
        </button>
      </header>

      {readOnlyReason ? (
        <div
          role="status"
          data-testid="replay-read-only-banner"
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          role="alert"
          data-testid="replay-error"
        >
          {error}
        </div>
      ) : null}

      <section
        aria-label="Replay queue summary"
        data-testid="replay-scan-summary"
        className={cn(gdcUi.cardShell, 'px-5 py-4')}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Current queue
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading && events.length === 0
                ? 'Loading replay events…'
                : `${formatCount(events.length)} replay${events.length === 1 ? '' : 's'} in view`}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
              Counts reflect the loaded replay list for the selected filters and time range.
            </p>
          </div>
          <dl className="flex flex-wrap gap-2" data-testid="replay-scan-counts">
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Waiting</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  queueCount > 0 && 'text-amber-600 dark:text-amber-400',
                )}
                data-testid="replay-count-queue"
              >
                {formatCount(queueCount)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Failed</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  failedCount > 0 && 'text-red-600 dark:text-red-400',
                )}
                data-testid="replay-count-failed"
              >
                {formatCount(failedCount)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Completed</dt>
              <dd
                className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50"
                data-testid="replay-count-recent"
              >
                {formatCount(recentCount)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        className={cn(gdcUi.cardShell, 'p-4')}
        aria-label="Replay filters"
        data-testid="replay-filters-panel"
      >
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Prioritize
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Filter recovery jobs</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Narrow by time range, policy, stream, and status before opening an investigation or bulk
            execute.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3" data-testid="replay-filters">
          <label className="flex min-w-[7rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Time range</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as ReplayWindow)}
              className={gdcUi.select}
              data-testid="replay-filter-window"
              aria-label="Time range"
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[10rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Policy</span>
            <select
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value === '' ? '' : Number(e.target.value))}
              className={gdcUi.select}
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
          </label>
          <label className="flex min-w-[10rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Stream</span>
            <select
              value={streamId}
              onChange={(e) => setStreamId(e.target.value === '' ? '' : Number(e.target.value))}
              className={gdcUi.select}
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
          </label>
          <label className="flex min-w-[8rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Status</span>
            <select
              value={status}
              onChange={(e) => updateStatusFilter(e.target.value as ReplayDisplayStatus | '')}
              className={gdcUi.select}
              data-testid="replay-filter-status"
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </label>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="h-10 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              data-testid="replay-clear-filters"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {!readOnly && retryableSelected.length > 0 ? (
          <div
            className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/80 pt-3 dark:border-gdc-divider"
            data-testid="replay-bulk-actions"
          >
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runExecute(retryableSelected)}
              className={actionButtonClass('primary')}
              data-testid="replay-bulk-execute"
            >
              Execute Selected ({retryableSelected.length})
            </button>
          </div>
        ) : null}
      </section>

      <section aria-label="Replay list" data-testid="replay-list-section">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Investigate
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Replay queue</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Select a row to open source origin, timeline, outcome/error evidence, and safe execute
            actions.
          </p>
        </div>

        {!loading && events.length === 0 && !error ? (
          filtersActive ? (
            <div className={cn(gdcUi.emptyPanel)} data-testid="replay-no-match-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No replay events match these filters
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Clear filters or widen the time range to broaden the queue.
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                data-testid="replay-no-match-clear"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className={cn(gdcUi.emptyPanel)} data-testid="replay-empty-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No replay events found
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Try a wider time range or adjust filters.
              </p>
            </div>
          )
        ) : (
          <div className={cn(gdcUi.cardShell, 'overflow-x-auto')}>
            <table className={opTable} data-testid="replay-table">
              <thead>
                <tr className={opThRow}>
                  {!readOnly ? (
                    <th className={opTh} scope="col">
                      <input
                        type="checkbox"
                        checked={
                          events.filter(isRetryable).length > 0 &&
                          selectedIds.size === events.filter(isRetryable).length
                        }
                        onChange={toggleSelectAll}
                        aria-label="Select all retryable"
                        data-testid="replay-select-all"
                      />
                    </th>
                  ) : null}
                  <th className={opTh} scope="col">
                    Replay ID
                  </th>
                  <th className={opTh} scope="col">
                    Policy
                  </th>
                  <th className={opTh} scope="col">
                    Stream
                  </th>
                  <th className={opTh} scope="col">
                    Status
                  </th>
                  <th className={opTh} scope="col">
                    Created
                  </th>
                  <th className={opTh} scope="col">
                    Completed
                  </th>
                  <th className={opTh} scope="col">
                    Outcome
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && events.length === 0 ? (
                  <tr className={opTr}>
                    <td colSpan={readOnly ? 7 : 8} className={cn(opTd, 'py-8 text-center text-slate-500')}>
                      <span className="inline-flex items-center gap-2" data-testid="replay-loading">
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                        Loading replay events…
                      </span>
                    </td>
                  </tr>
                ) : (
                  events.map((entry) => {
                    const selected = drawerId === entry.id
                    return (
                      <tr
                        key={entry.id}
                        className={cn(
                          opTr,
                          'cursor-pointer hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:focus-visible:bg-gdc-rowHover',
                          selected && 'bg-violet-50/70 dark:bg-violet-500/10',
                        )}
                        data-testid={`replay-row-${entry.id}`}
                        onClick={() => void openDetail(entry.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void openDetail(entry.id)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`Investigate replay ${entry.id} for ${entry.policy_name} on ${entry.stream_name}`}
                        aria-pressed={selected}
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
                        <td className={opTd}>
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            #{entry.id}
                          </span>
                        </td>
                        <td className={opTd}>{entry.policy_name}</td>
                        <td className={opTd}>{entry.stream_name}</td>
                        <td className={opTd}>
                          <span
                            className={cn(
                              'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                              statusBadgeClass(entry.status),
                            )}
                          >
                            {statusLabel(entry.status)}
                          </span>
                        </td>
                        <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>
                          {formatTime(entry.created_at)}
                        </td>
                        <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>
                          {formatTime(entry.completed_at)}
                        </td>
                        <td className={opTd}>{entry.outcome ?? '—'}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
