import { ClipboardList, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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
import { governanceReadOnlyReason } from '../../lib/governance-rbac'
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
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatTimeShort(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function eventTypeLabel(eventType: AuditEventType) {
  return eventType.replace(/_/g, ' ')
}

function statusBadgeClass(status: AuditStatus) {
  switch (status) {
    case 'QUARANTINED':
    case 'IN_PROGRESS':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    case 'RELEASED':
    case 'DELIVERED':
    case 'ACTIVE':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
}

function outcomeBadgeClass(outcome: string) {
  switch (outcome) {
    case 'DELIVERED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
    case 'FAILED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
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

  return (
    <GovernanceInvestigationDrawer
      title="Audit investigation"
      testId="audit-detail-drawer"
      closeTestId="audit-detail-close"
      loading={loading}
      hasContent={Boolean(detail)}
      onClose={onClose}
      rootCauseStrip={firstStep?.summary ?? detail?.outcome ?? null}
      rootCauseTestId="audit-root-cause-strip"
      whatHappenedTestId="audit-section-what-happened"
      whyTestId="audit-section-why"
      whatShouldIDoTestId="audit-section-what-should-i-do"
      whatHappened={
        detail ? (
          <>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{detail.policy_name}</p>
            {detail.stream_name ? (
              <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{detail.stream_name}</p>
            ) : null}
            <span
              className={cn(
                'inline-flex rounded px-2 py-0.5 text-[11px] font-semibold uppercase',
                statusBadgeClass(detail.current_status),
              )}
            >
              {detail.current_status}
            </span>
            <p className="text-[12px] font-mono text-slate-500">{detail.correlation_id}</p>
          </>
        ) : null
      }
      why={
        detail ? (
          detail.timeline.length === 0 ? (
            <p className="text-[12px] text-slate-500">No timeline steps recorded.</p>
          ) : (
            <ol className="space-y-3 border-l border-slate-200 pl-3 dark:border-gdc-border">
              {detail.timeline.map((step, idx) => (
                <li key={`${step.event_type}-${step.event_time}-${idx}`} className="relative">
                  <span className="absolute -left-[13px] top-1.5 h-2 w-2 rounded-full bg-violet-500" aria-hidden />
                  <p className="text-[11px] font-mono text-slate-500">{formatTimeShort(step.event_time)}</p>
                  <p className="text-[13px] font-medium text-slate-900 dark:text-slate-100">{step.summary}</p>
                  {step.actor ? <p className="text-[11px] text-slate-500">By {step.actor}</p> : null}
                </li>
              ))}
            </ol>
          )
        ) : null
      }
      related={
        detail ? (
          <>
            {detail.related_violation ? (
              <div className="text-[12px]">
                <p className="font-medium text-slate-800 dark:text-slate-200">
                  Violation · {detail.related_violation.violation_id}
                </p>
                <p className="text-slate-500">{detail.related_violation.status}</p>
              </div>
            ) : null}
            {detail.related_quarantine ? (
              <div className="mt-2 text-[12px]">
                <p className="font-medium text-slate-800 dark:text-slate-200">
                  Quarantine · #{detail.related_quarantine.quarantine_event_id}
                </p>
                <p className="text-slate-500">{detail.related_quarantine.status}</p>
              </div>
            ) : null}
            {detail.related_replay ? (
              <div className="mt-2 text-[12px]">
                <p className="font-medium text-slate-800 dark:text-slate-200">
                  Replay · #{detail.related_replay.replay_event_id}
                </p>
                <p className="text-slate-500">
                  {detail.related_replay.status} · {detail.related_replay.event_count} events
                </p>
              </div>
            ) : null}
            {detail.outcome ? (
              <p className="mt-2">
                <span
                  className={cn(
                    'inline-flex rounded px-2 py-0.5 text-[11px] font-semibold uppercase',
                    outcomeBadgeClass(detail.outcome),
                  )}
                >
                  {detail.outcome}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-[12px] text-slate-500">Lifecycle still in progress.</p>
            )}
            {!detail.related_violation && !detail.related_quarantine && !detail.related_replay ? (
              <p className="text-[12px] text-slate-500">No related governance objects.</p>
            ) : null}
          </>
        ) : null
      }
      whatShouldIDo={
        detail ? (
          <div className="flex flex-wrap gap-2">
            {detail.related_violation ? (
              <Link
                to={NAV_PATH.governanceViolations}
                className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
                data-testid="audit-open-violations"
              >
                Resolve
              </Link>
            ) : null}
            {detail.related_quarantine ? (
              <Link
                to={`${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.related_quarantine.quarantine_event_id))}`}
                className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
                data-testid="audit-open-quarantine"
              >
                Release
              </Link>
            ) : null}
            {detail.related_replay ? (
              <Link
                to={`${NAV_PATH.governanceReplay}?id=${encodeURIComponent(String(detail.related_replay.replay_event_id))}`}
                className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
                data-testid="audit-open-replay"
              >
                Replay
              </Link>
            ) : null}
            <Link
              to={NAV_PATH.governanceAudit}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            >
              View details
            </Link>
          </div>
        ) : null
      }
    />
  )
}

export function AuditTrailPage() {
  const readOnlyReason = governanceReadOnlyReason()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<GovernanceAuditEntry[]>([])
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [window, setWindow] = useState<AuditWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [streamId, setStreamId] = useState<number | ''>('')
  const [eventType, setEventType] = useState<AuditEventType | ''>('')
  const [status, setStatus] = useState<AuditStatus | ''>('')
  const [selectedCorrelationId, setSelectedCorrelationId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GovernanceAuditDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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

  const openDetail = async (correlationId: string) => {
    setSelectedCorrelationId(correlationId)
    setDetailLoading(true)
    setDetail(null)
    try {
      const d = await fetchGovernanceAuditDetail(correlationId, window === '24h' ? '7d' : window)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    setSelectedCorrelationId(null)
    setDetail(null)
  }

  const policyOptions = useMemo(
    () => policies.map((p) => ({ id: p.id, name: p.name })),
    [policies],
  )

  const streamOptions = useMemo(
    () => streams.map((s) => ({ id: s.id, name: s.name })),
    [streams],
  )

  return (
    <div className="space-y-4" data-testid="audit-trail-page">
      <section className="rounded-xl border border-slate-200/90 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-slate-100">
              <ClipboardList className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
              Governance Audit
            </p>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">
              Trace policy violations through quarantine, release, and recovery.
              {readOnlyReason ? ` ${readOnlyReason}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            data-testid="audit-refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" data-testid="audit-filters">
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value as AuditWindow)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="audit-filter-window"
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
          <select
            value={streamId}
            onChange={(e) => setStreamId(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
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
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value as AuditEventType | '')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
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
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AuditStatus | '')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="audit-filter-status"
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
      </section>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && events.length === 0 && !error ? (
        <div
          className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center dark:border-gdc-border dark:bg-gdc-card/50"
          data-testid="audit-empty-state"
        >
          <p className="text-[13px] font-medium text-slate-700 dark:text-slate-200">
            No governance audit events found
          </p>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">
            Try a wider time range or adjust filters.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white dark:border-gdc-border dark:bg-gdc-card">
          <table className={opTable} data-testid="audit-table">
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Time</th>
                <th className={opTh}>Policy</th>
                <th className={opTh}>Stream</th>
                <th className={opTh}>Event Type</th>
                <th className={opTh}>Status</th>
                <th className={opTh}>Correlation ID</th>
              </tr>
            </thead>
            <tbody>
              {loading && events.length === 0 ? (
                <tr className={opTr}>
                  <td colSpan={6} className={cn(opTd, 'text-center text-slate-500')}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden />
                  </td>
                </tr>
              ) : (
                events.map((row, idx) => (
                  <tr
                    key={`${row.correlation_id}-${row.event_type}-${row.event_time}-${idx}`}
                    className={cn(opTr, 'cursor-pointer hover:bg-slate-50 dark:hover:bg-gdc-rowHover')}
                    onClick={() => void openDetail(row.correlation_id)}
                    data-testid={`audit-row-${row.correlation_id}-${row.event_type}`}
                  >
                    <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>{formatTime(row.event_time)}</td>
                    <td className={opTd}>
                      <span className="font-medium text-slate-900 dark:text-slate-100">{row.policy_name}</span>
                    </td>
                    <td className={opTd}>{row.stream_name ?? '—'}</td>
                    <td className={opTd}>
                      <span className="text-[11px] font-medium uppercase text-slate-700 dark:text-slate-300">
                        {eventTypeLabel(row.event_type)}
                      </span>
                    </td>
                    <td className={opTd}>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                          statusBadgeClass(row.status),
                        )}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className={cn(opTd, 'font-mono text-[11px] text-slate-600 dark:text-gdc-muted')}>
                      {row.correlation_id}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedCorrelationId ? (
        <AuditTimelineDrawer detail={detail} loading={detailLoading} onClose={closeDetail} />
      ) : null}
    </div>
  )
}
