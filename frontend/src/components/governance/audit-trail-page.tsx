import { ClipboardList, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  fetchGovernanceAuditDetail,
  fetchGovernanceAuditEvents,
  type AuditEventType,
  type AuditStatus,
  type AuditWindow,
  type GovernanceAuditDetailResponse,
  type GovernanceAuditEntry,
} from '../../api/gdcGovernanceAudit'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { fetchStreamsList } from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { NAV_PATH } from '../../config/nav-paths'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { governanceReadOnlyReason } from '../../lib/governance-rbac'
import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'

const WINDOWS: readonly AuditWindow[] = ['24h', '7d', '30d'] as const
const EVENT_TYPES: readonly AuditEventType[] = [
  'POLICY_ACTIVATED',
  'SUBMITTED_FOR_REVIEW',
  'APPROVED',
  'REJECTED',
  'REQUEST_CHANGES',
  'APPROVAL_ACTIVATED',
  'VIOLATION_CREATED',
  'QUARANTINE_CREATED',
  'QUARANTINE_RELEASED',
  'QUARANTINE_DISCARDED',
  'REPLAY_STARTED',
  'REPLAY_COMPLETED',
  'REPLAY_FAILED',
] as const
const STATUSES: readonly AuditStatus[] = [
  'ACTIVE',
  'OPEN',
  'QUARANTINED',
  'RELEASED',
  'DISCARDED',
  'IN_PROGRESS',
  'DELIVERED',
  'FAILED',
] as const

function formatTime(iso: string) {
  return formatTimestampWithResolvedTimezone(iso)
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function parseCorrelationId(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function eventTypeLabel(eventType: AuditEventType) {
  return eventType.replace(/_/g, ' ')
}

function statusLabel(status: AuditStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'Active'
    case 'OPEN':
      return 'Open'
    case 'QUARANTINED':
      return 'Quarantined'
    case 'RELEASED':
      return 'Released'
    case 'DISCARDED':
      return 'Discarded'
    case 'IN_PROGRESS':
      return 'In progress'
    case 'DELIVERED':
      return 'Delivered'
    case 'FAILED':
      return 'Failed'
    default:
      return status
  }
}

function statusBadgeClass(status: AuditStatus) {
  switch (status) {
    case 'QUARANTINED':
    case 'IN_PROGRESS':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-200'
    case 'RELEASED':
    case 'DELIVERED':
    case 'ACTIVE':
      return 'bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
    case 'FAILED':
      return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
    case 'OPEN':
      return 'bg-blue-500/15 text-blue-800 ring-1 ring-blue-500/30 dark:text-blue-200'
    default:
      return 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300'
  }
}

function outcomeBadgeClass(outcome: string) {
  switch (outcome) {
    case 'DELIVERED':
      return 'bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
    case 'FAILED':
      return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
    default:
      return 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300'
  }
}

function actionButtonClass() {
  return 'inline-flex rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100'
}

function AuditTimelineDrawer({
  detail,
  loading,
  onClose,
}: {
  detail: GovernanceAuditDetailResponse | null
  loading: boolean
  onClose: () => void
}) {
  const firstStep = detail?.timeline[0]
  const strip = firstStep?.summary ?? detail?.outcome ?? null
  const violationHref = detail?.related_violation
    ? `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(detail.related_violation.violation_id)}`
    : null
  const quarantineHref = detail?.related_quarantine
    ? `${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.related_quarantine.quarantine_event_id))}`
    : null
  const replayHref = detail?.related_replay
    ? `${NAV_PATH.governanceReplay}?id=${encodeURIComponent(String(detail.related_replay.replay_event_id))}`
    : null

  return (
    <GovernanceInvestigationDrawer
      title="Audit investigation"
      testId="audit-detail-drawer"
      closeTestId="audit-detail-close"
      loading={loading}
      hasContent={Boolean(detail)}
      onClose={onClose}
      rootCauseStrip={strip}
      rootCauseTestId="audit-root-cause-strip"
      whatHappenedTestId="audit-section-what-happened"
      whyTestId="audit-section-why"
      whatShouldIDoTestId="audit-section-what-should-i-do"
      relatedTestId="audit-section-related"
      whatHappened={
        detail ? (
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Policy
              </p>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.policy_name}</p>
              {detail.stream_name ? (
                <p className="mt-0.5 text-sm text-slate-600 dark:text-gdc-muted">{detail.stream_name}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                  statusBadgeClass(detail.current_status),
                )}
                data-testid="audit-detail-status"
              >
                {statusLabel(detail.current_status)}
              </span>
              {detail.outcome ? (
                <span
                  className={cn(
                    'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                    outcomeBadgeClass(detail.outcome),
                  )}
                  data-testid="audit-detail-outcome"
                >
                  Outcome · {detail.outcome}
                </span>
              ) : (
                <span className="text-xs text-slate-500 dark:text-gdc-muted" data-testid="audit-detail-outcome-pending">
                  Lifecycle still in progress
                </span>
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Correlation
              </p>
              <p
                className="mt-0.5 font-mono text-sm text-slate-800 dark:text-slate-200"
                data-testid="audit-detail-correlation"
              >
                {detail.correlation_id}
              </p>
            </div>
          </div>
        ) : null
      }
      why={
        detail ? (
          detail.timeline.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-gdc-muted">No timeline steps recorded.</p>
          ) : (
            <ol className="space-y-3 border-l border-slate-200 pl-4 dark:border-gdc-border" data-testid="audit-timeline">
              {detail.timeline.map((step, idx) => (
                <li
                  key={`${step.event_type}-${step.event_time}-${idx}`}
                  className="relative"
                  data-testid={`audit-timeline-step-${idx}`}
                >
                  <span
                    className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-violet-500 ring-2 ring-white dark:ring-gdc-card"
                    aria-hidden
                  />
                  <p className="text-xs text-slate-500 dark:text-gdc-muted">{formatTime(step.event_time)}</p>
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{step.summary}</p>
                  <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                    {eventTypeLabel(step.event_type)}
                  </p>
                  {step.actor ? (
                    <p className="text-xs text-slate-500 dark:text-gdc-muted">By {step.actor}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )
        ) : null
      }
      related={
        detail ? (
          <div className="space-y-3" data-testid="audit-related-evidence">
            {detail.related_violation ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Violation
                </p>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {detail.related_violation.violation_id}
                </p>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">{detail.related_violation.status}</p>
                {violationHref ? (
                  <Link
                    to={violationHref}
                    className="mt-1 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                    data-testid="audit-related-violation-link"
                  >
                    Open Violation
                  </Link>
                ) : null}
              </div>
            ) : null}
            {detail.related_quarantine ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Quarantine
                </p>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  #{detail.related_quarantine.quarantine_event_id}
                </p>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">{detail.related_quarantine.status}</p>
                {quarantineHref ? (
                  <Link
                    to={quarantineHref}
                    className="mt-1 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                    data-testid="audit-related-quarantine-link"
                  >
                    Open Quarantine
                  </Link>
                ) : null}
              </div>
            ) : null}
            {detail.related_replay ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Replay
                </p>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  #{detail.related_replay.replay_event_id}
                </p>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">
                  {detail.related_replay.status} · {detail.related_replay.event_count} events
                </p>
                {replayHref ? (
                  <Link
                    to={replayHref}
                    className="mt-1 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                    data-testid="audit-related-replay-link"
                  >
                    Open Replay
                  </Link>
                ) : null}
              </div>
            ) : null}
            {!detail.related_violation && !detail.related_quarantine && !detail.related_replay ? (
              <p className="text-sm text-slate-500 dark:text-gdc-muted">No related governance objects.</p>
            ) : null}
          </div>
        ) : null
      }
      whatShouldIDo={
        detail ? (
          <div className="flex flex-wrap gap-2">
            {violationHref ? (
              <Link to={violationHref} className={actionButtonClass()} data-testid="audit-open-violations">
                Open Violation
              </Link>
            ) : null}
            {quarantineHref ? (
              <Link to={quarantineHref} className={actionButtonClass()} data-testid="audit-open-quarantine">
                Open Quarantine
              </Link>
            ) : null}
            {replayHref ? (
              <Link to={replayHref} className={actionButtonClass()} data-testid="audit-open-replay">
                Open Replay
              </Link>
            ) : null}
            {!violationHref && !quarantineHref && !replayHref ? (
              <p className="text-sm text-slate-500 dark:text-gdc-muted">
                No linked governance actions for this correlation.
              </p>
            ) : null}
          </div>
        ) : null
      }
    />
  )
}

export function AuditTrailPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlCorrelation = parseCorrelationId(searchParams.get('correlation'))

  const readOnlyReason = governanceReadOnlyReason()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<GovernanceAuditEntry[]>([])
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [window, setWindow] = useState<AuditWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [streamId, setStreamId] = useState<number | ''>('')
  const [eventType, setEventType] = useState<AuditEventType | ''>('')
  const [status, setStatus] = useState<AuditStatus | ''>('')
  const [selectedCorrelationId, setSelectedCorrelationId] = useState<string | null>(urlCorrelation)
  const [detail, setDetail] = useState<GovernanceAuditDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const openedFromUrlRef = useRef<string | null>(null)

  const filtersActive = policyId !== '' || streamId !== '' || eventType !== '' || status !== ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchGovernanceAuditEvents({
        window,
        policy_id: policyId === '' ? undefined : policyId,
        stream_id: streamId === '' ? undefined : streamId,
        event_type: eventType === '' ? undefined : eventType,
        status: status === '' ? undefined : status,
      })
      setEvents(data?.events ?? [])
      if (data == null) setError('Governance audit APIs unavailable.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [window, policyId, streamId, eventType, status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void fetchGovernancePolicies().then((data) => setPolicies(data?.policies ?? []))
    void fetchStreamsList().then((data) => setStreams(data ?? []))
  }, [])

  const syncCorrelationId = useCallback(
    (correlationId: string | null) => {
      setSelectedCorrelationId(correlationId)
      const params = new URLSearchParams(searchParams)
      if (correlationId) params.set('correlation', correlationId)
      else params.delete('correlation')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const openDetail = useCallback(
    async (correlationId: string) => {
      syncCorrelationId(correlationId)
      setDetailLoading(true)
      setDetail(null)
      try {
        const d = await fetchGovernanceAuditDetail(correlationId, window === '24h' ? '7d' : window)
        setDetail(d)
        if (d == null) setError('Audit detail unavailable.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [syncCorrelationId, window],
  )

  const closeDetail = useCallback(() => {
    openedFromUrlRef.current = null
    syncCorrelationId(null)
    setDetail(null)
  }, [syncCorrelationId])

  useEffect(() => {
    if (urlCorrelation == null) {
      openedFromUrlRef.current = null
      return
    }
    if (openedFromUrlRef.current === urlCorrelation) return
    openedFromUrlRef.current = urlCorrelation
    void openDetail(urlCorrelation)
  }, [urlCorrelation, openDetail])

  const clearFilters = () => {
    setPolicyId('')
    setStreamId('')
    setEventType('')
    setStatus('')
  }

  const policyOptions = useMemo(
    () => policies.map((p) => ({ id: p.id, name: p.name })),
    [policies],
  )

  const streamOptions = useMemo(
    () => streams.map((s) => ({ id: s.id, name: s.name })),
    [streams],
  )

  const scanSummary = useMemo(() => {
    let openLike = 0
    let quarantined = 0
    let terminal = 0
    for (const row of events) {
      if (row.status === 'OPEN' || row.status === 'IN_PROGRESS' || row.status === 'ACTIVE') openLike += 1
      if (row.status === 'QUARANTINED') quarantined += 1
      if (row.status === 'DELIVERED' || row.status === 'DISCARDED' || row.status === 'FAILED' || row.status === 'RELEASED') {
        terminal += 1
      }
    }
    return { shown: events.length, openLike, quarantined, terminal }
  }, [events])

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="audit-trail-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            <ClipboardList className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
            Governance Audit
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            Trace lifecycle events from policy activation through violation, quarantine, release, and
            recovery for an exact correlation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          data-testid="audit-refresh"
          aria-label="Refresh audit events"
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
          data-testid="audit-read-only-banner"
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          role="alert"
          data-testid="audit-error"
        >
          {error}
        </div>
      ) : null}

      <section
        aria-label="Audit feed summary"
        data-testid="audit-scan-summary"
        className={cn(gdcUi.cardShell, 'px-5 py-4')}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Lifecycle feed
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading && events.length === 0
                ? 'Loading audit events…'
                : `${formatCount(scanSummary.shown)} event${scanSummary.shown === 1 ? '' : 's'} in view`}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
              Counts reflect the loaded audit list for the selected filters and time range.
            </p>
          </div>
          <dl className="flex flex-wrap gap-2" data-testid="audit-scan-counts">
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Open / active</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.openLike > 0 && 'text-amber-600 dark:text-amber-400',
                )}
                data-testid="audit-count-open-like"
              >
                {formatCount(scanSummary.openLike)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Quarantined</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.quarantined > 0 && 'text-amber-600 dark:text-amber-400',
                )}
                data-testid="audit-count-quarantined"
              >
                {formatCount(scanSummary.quarantined)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Terminal</dt>
              <dd
                className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50"
                data-testid="audit-count-terminal"
              >
                {formatCount(scanSummary.terminal)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={cn(gdcUi.cardShell, 'p-4')} aria-label="Audit filters" data-testid="audit-filters-panel">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Prioritize
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Filter lifecycle events</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Narrow by time range, policy, stream, event type, and status before opening a correlation
            investigation.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3" data-testid="audit-filters">
          <label className="flex min-w-[7rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Time range</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as AuditWindow)}
              className={gdcUi.select}
              data-testid="audit-filter-window"
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
              data-testid="audit-filter-policy"
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
              data-testid="audit-filter-stream"
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
          <label className="flex min-w-[10rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Event type</span>
            <select
              value={eventType}
              onChange={(e) => setEventType(e.target.value as AuditEventType | '')}
              className={gdcUi.select}
              data-testid="audit-filter-event-type"
              aria-label="Event type"
            >
              <option value="">All event types</option>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {eventTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[8rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AuditStatus | '')}
              className={gdcUi.select}
              data-testid="audit-filter-status"
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
              data-testid="audit-clear-filters"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      <section aria-label="Audit event list" data-testid="audit-list-section">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Investigate
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Lifecycle events</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Select a row to open correlation identity, timeline, status/outcome, and related governance
            evidence.
          </p>
        </div>

        {!loading && events.length === 0 && !error ? (
          filtersActive ? (
            <div className={cn(gdcUi.emptyPanel)} data-testid="audit-no-match-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No audit events match these filters
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Clear filters or widen the time range to broaden the feed.
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                data-testid="audit-no-match-clear"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className={cn(gdcUi.emptyPanel)} data-testid="audit-empty-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No governance audit events found
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Try a wider time range or adjust filters.
              </p>
            </div>
          )
        ) : (
          <div className={cn(gdcUi.cardShell, 'overflow-x-auto')}>
            <table className={opTable} data-testid="audit-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh} scope="col">
                    Time
                  </th>
                  <th className={opTh} scope="col">
                    Policy
                  </th>
                  <th className={opTh} scope="col">
                    Stream
                  </th>
                  <th className={opTh} scope="col">
                    Event Type
                  </th>
                  <th className={opTh} scope="col">
                    Status
                  </th>
                  <th className={opTh} scope="col">
                    Correlation ID
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && events.length === 0 ? (
                  <tr className={opTr}>
                    <td colSpan={6} className={cn(opTd, 'py-8 text-center text-slate-500')}>
                      <span className="inline-flex items-center gap-2" data-testid="audit-loading">
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                        Loading audit events…
                      </span>
                    </td>
                  </tr>
                ) : (
                  events.map((row, idx) => {
                    const selected = selectedCorrelationId === row.correlation_id
                    return (
                      <tr
                        key={`${row.correlation_id}-${row.event_type}-${row.event_time}-${idx}`}
                        className={cn(
                          opTr,
                          'cursor-pointer hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:focus-visible:bg-gdc-rowHover',
                          selected && 'bg-violet-50/70 dark:bg-violet-500/10',
                        )}
                        onClick={() => void openDetail(row.correlation_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void openDetail(row.correlation_id)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`Investigate audit correlation ${row.correlation_id} for ${row.policy_name}`}
                        aria-pressed={selected}
                        data-testid={`audit-row-${row.correlation_id}-${row.event_type}`}
                      >
                        <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>
                          {formatTime(row.event_time)}
                        </td>
                        <td className={opTd}>
                          <span className="font-medium text-slate-900 dark:text-slate-100">{row.policy_name}</span>
                        </td>
                        <td className={opTd}>{row.stream_name ?? '—'}</td>
                        <td className={opTd}>
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                            {eventTypeLabel(row.event_type)}
                          </span>
                        </td>
                        <td className={opTd}>
                          <span
                            className={cn(
                              'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                              statusBadgeClass(row.status),
                            )}
                          >
                            {statusLabel(row.status)}
                          </span>
                        </td>
                        <td className={cn(opTd, 'font-mono text-xs text-slate-600 dark:text-gdc-muted')}>
                          {row.correlation_id}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedCorrelationId ? (
        <AuditTimelineDrawer detail={detail} loading={detailLoading} onClose={closeDetail} />
      ) : null}
    </div>
  )
}
