import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  fetchGovernanceViolationDetail,
  fetchGovernanceViolations,
  type GovernanceViolationDetailResponse,
  type GovernanceViolationEntry,
  type ViolationSeverity,
  type ViolationStatus,
  type ViolationWindow,
} from '../../api/gdcGovernanceViolations'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { NAV_PATH, logsExplorerPath } from '../../config/nav-paths'
import { governanceReadOnlyReason } from '../../lib/governance-rbac'
import { humanizeQuarantineReason } from '../../lib/humanize-quarantine-reason'
import { isOssReleaseMode } from '../../lib/feature-flags'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'

const WINDOWS: readonly ViolationWindow[] = ['24h', '7d', '30d'] as const
const STATUSES: readonly ViolationStatus[] = ['OPEN', 'QUARANTINED', 'RELEASED', 'REPLAYED'] as const
const SEVERITIES: readonly ViolationSeverity[] = ['HIGH', 'MEDIUM', 'LOW'] as const

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function statusBadgeClass(status: ViolationStatus) {
  switch (status) {
    case 'QUARANTINED':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-200'
    case 'RELEASED':
      return 'bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30 dark:text-emerald-200'
    case 'REPLAYED':
      return 'bg-violet-500/15 text-violet-800 ring-1 ring-violet-500/30 dark:text-violet-200'
    default:
      return 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300'
  }
}

function severityBadgeClass(severity: ViolationSeverity) {
  switch (severity) {
    case 'HIGH':
      return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
    case 'MEDIUM':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300'
    default:
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
  }
}

function severityLabel(severity: ViolationSeverity): string {
  if (severity === 'HIGH') return 'High'
  if (severity === 'MEDIUM') return 'Medium'
  return 'Low'
}

function statusLabel(status: ViolationStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Open'
    case 'QUARANTINED':
      return 'Quarantined'
    case 'RELEASED':
      return 'Released'
    case 'REPLAYED':
      return 'Replayed'
    default:
      return status
  }
}

function actionLinkClass(emphasized?: boolean) {
  if (emphasized) {
    return 'inline-flex rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100'
  }
  return 'inline-flex rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover'
}

function ViolationDetailDrawer({
  detail,
  loading,
  onClose,
}: {
  detail: GovernanceViolationDetailResponse | null
  loading: boolean
  onClose: () => void
}) {
  const v = detail?.violation
  const policyHref =
    detail?.policy_summary.policy_id != null
      ? isOssReleaseMode()
        ? NAV_PATH.governanceApprovals
        : NAV_PATH.governanceDataProtection
      : null

  return (
    <GovernanceInvestigationDrawer
      title="Violation investigation"
      testId="violation-detail-drawer"
      closeTestId="violation-detail-close"
      loading={loading}
      hasContent={Boolean(v && detail)}
      onClose={onClose}
      rootCauseStrip={v?.reason ?? null}
      rootCauseTestId="violation-root-cause-strip"
      whatHappenedTestId="violation-section-what-happened"
      whyTestId="violation-section-why"
      whatShouldIDoTestId="violation-section-what-should-i-do"
      relatedTestId="violation-section-related"
      whatHappened={
        v && detail ? (
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
            {detail.policy_summary.rule_summary ? (
              <div
                className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section"
                data-testid="violation-matched-rule"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Matched rule
                </p>
                <p className="mt-0.5 text-sm text-slate-800 dark:text-slate-200">
                  {detail.policy_summary.rule_summary}
                </p>
              </div>
            ) : null}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Reason
              </p>
              <p className="text-sm text-slate-800 dark:text-slate-200">{v.reason}</p>
            </div>
            <p className="text-xs text-slate-500 dark:text-gdc-muted">
              {v.stream_name} · {formatTime(v.event_time)}
            </p>
          </div>
        ) : null
      }
      why={
        v && detail ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <span
                className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                  severityBadgeClass(v.severity),
                )}
              >
                {severityLabel(v.severity)}
              </span>
              <span
                className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                  statusBadgeClass(v.status),
                )}
              >
                {statusLabel(v.status)}
              </span>
            </div>
            {detail.policy_summary.rule_summary ? (
              <p className="text-sm text-slate-700 dark:text-slate-200">
                Delivery matched this policy rule: {detail.policy_summary.rule_summary}
              </p>
            ) : (
              <p className="text-sm text-slate-700 dark:text-slate-200">
                Policy rule matched during delivery.
              </p>
            )}
          </div>
        ) : null
      }
      related={
        v && detail ? (
          <div className="space-y-3" data-testid="violation-related-evidence">
            {detail.related_quarantine ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Quarantine
                </p>
                <p className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                  #{detail.related_quarantine.quarantine_event_id} ·{' '}
                  {detail.related_quarantine.status}
                </p>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">
                  {humanizeQuarantineReason(detail.related_quarantine.quarantine_reason)}
                </p>
                <Link
                  to={`${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.related_quarantine.quarantine_event_id))}`}
                  className="mt-2 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                  data-testid="violation-related-quarantine-link"
                >
                  Open Quarantine
                </Link>
              </div>
            ) : null}
            {detail.related_replays.length > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Replay
                </p>
                <ul className="mt-1 space-y-1.5">
                  {detail.related_replays.map((r) => (
                    <li key={r.replay_event_id} className="text-sm text-slate-700 dark:text-slate-200">
                      #{r.replay_event_id} · {r.status} · {r.event_count} events
                    </li>
                  ))}
                </ul>
                <Link
                  to={`${NAV_PATH.governanceReplay}?id=${encodeURIComponent(String(detail.related_replays[0].replay_event_id))}`}
                  className="mt-2 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                  data-testid="violation-related-replay-link"
                >
                  Open Replay
                </Link>
              </div>
            ) : null}
            {!detail.related_quarantine && detail.related_replays.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-gdc-muted">
                No related quarantine or replay events.
              </p>
            ) : null}
          </div>
        ) : null
      }
      whatShouldIDo={
        v && detail ? (
          <div className="flex flex-wrap gap-2">
            {detail.related_quarantine ? (
              <Link
                to={`${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(detail.related_quarantine.quarantine_event_id))}`}
                className={actionLinkClass(true)}
                data-testid="violation-open-quarantine"
              >
                Release
              </Link>
            ) : null}
            {detail.related_replays.length > 0 ? (
              <Link
                to={`${NAV_PATH.governanceReplay}?id=${encodeURIComponent(String(detail.related_replays[0].replay_event_id))}`}
                className={actionLinkClass(true)}
                data-testid="violation-open-replay"
              >
                Replay
              </Link>
            ) : null}
            {policyHref ? (
              <Link to={policyHref} className={actionLinkClass()} data-testid="violation-open-policy">
                View details
              </Link>
            ) : null}
            <Link
              to={logsExplorerPath({ stream_id: v.stream_id, stage: 'quarantine_event_created' })}
              className={actionLinkClass()}
              data-testid="violation-view-logs"
            >
              View delivery records
            </Link>
          </div>
        ) : null
      }
    />
  )
}

export function ViolationCenterPage() {
  const readOnlyReason = governanceReadOnlyReason()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlId = searchParams.get('id')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violations, setViolations] = useState<GovernanceViolationEntry[]>([])
  const [total, setTotal] = useState(0)
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [window, setWindow] = useState<ViolationWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [status, setStatus] = useState<ViolationStatus | ''>('')
  const [severity, setSeverity] = useState<ViolationSeverity | ''>('')
  const [selectedId, setSelectedId] = useState<string | null>(urlId)
  const [detail, setDetail] = useState<GovernanceViolationDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const openedFromUrlRef = useRef<string | null>(null)

  const filtersActive = policyId !== '' || status !== '' || severity !== ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchGovernanceViolations({
        window,
        policy_id: policyId === '' ? undefined : policyId,
        status: status === '' ? undefined : status,
        severity: severity === '' ? undefined : severity,
      })
      setViolations(data?.violations ?? [])
      setTotal(data?.total ?? data?.violations?.length ?? 0)
      if (data == null) setError('Violation APIs unavailable.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [window, policyId, status, severity])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void fetchGovernancePolicies().then((data) => setPolicies(data?.policies ?? []))
  }, [])

  const syncSelectedId = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      const params = new URLSearchParams(searchParams)
      if (id) params.set('id', id)
      else params.delete('id')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const openDetail = useCallback(
    async (id: string) => {
      syncSelectedId(id)
      setDetailLoading(true)
      setDetail(null)
      try {
        const d = await fetchGovernanceViolationDetail(id, window === '24h' ? '7d' : window)
        setDetail(d)
        if (d == null) setError('Violation detail unavailable.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [syncSelectedId, window],
  )

  const closeDetail = useCallback(() => {
    openedFromUrlRef.current = null
    syncSelectedId(null)
    setDetail(null)
  }, [syncSelectedId])

  useEffect(() => {
    if (!urlId) {
      openedFromUrlRef.current = null
      return
    }
    if (openedFromUrlRef.current === urlId) return
    openedFromUrlRef.current = urlId
    void openDetail(urlId)
  }, [urlId, openDetail])

  const policyOptions = useMemo(
    () => policies.map((p) => ({ id: p.id, name: p.name })),
    [policies],
  )

  const scanSummary = useMemo(() => {
    const high = violations.filter((v) => v.severity === 'HIGH').length
    const openLike = violations.filter((v) => v.status === 'OPEN' || v.status === 'QUARANTINED').length
    const quarantined = violations.filter((v) => v.status === 'QUARANTINED').length
    return { high, openLike, quarantined, shown: violations.length, total }
  }, [violations, total])

  const clearFilters = () => {
    setPolicyId('')
    setStatus('')
    setSeverity('')
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="violation-center-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
            Violation Center
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            Investigate policy matches from quarantine and response outcomes. Filter the feed, open a
            violation, then continue into Quarantine, Replay, or delivery records with existing context
            preserved.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          data-testid="violation-refresh"
          aria-label="Refresh violations"
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
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="violation-read-only-banner"
          role="status"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          role="alert"
          data-testid="violation-error"
        >
          {error}
        </div>
      ) : null}

      <section
        aria-label="Violation scan summary"
        data-testid="violation-scan-summary"
        className={cn(gdcUi.cardShell, 'px-5 py-4')}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Current feed
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading && violations.length === 0
                ? 'Loading policy violations…'
                : `${formatCount(scanSummary.shown)} violation${scanSummary.shown === 1 ? '' : 's'} in view`}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
              Counts reflect the loaded violation list for the selected filters and time range.
            </p>
          </div>
          <dl className="flex flex-wrap gap-2" data-testid="violation-scan-counts">
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">High</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.high > 0 && 'text-red-600 dark:text-red-400',
                )}
                data-testid="violation-count-high"
              >
                {formatCount(scanSummary.high)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Open / quarantined</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.openLike > 0 && 'text-amber-600 dark:text-amber-400',
                )}
                data-testid="violation-count-open-like"
              >
                {formatCount(scanSummary.openLike)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Quarantined</dt>
              <dd
                className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50"
                data-testid="violation-count-quarantined"
              >
                {formatCount(scanSummary.quarantined)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={cn(gdcUi.cardShell, 'p-4')} aria-label="Violation filters" data-testid="violation-filters-panel">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Prioritize
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Filter violations</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Narrow by time range, policy, severity, and status before opening an investigation.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3" data-testid="violation-filters">
          <label className="flex min-w-[7rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Time range</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as ViolationWindow)}
              className={gdcUi.select}
              data-testid="violation-filter-window"
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
              data-testid="violation-filter-policy"
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
          <label className="flex min-w-[8rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Severity</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as ViolationSeverity | '')}
              className={gdcUi.select}
              data-testid="violation-filter-severity"
              aria-label="Severity"
            >
              <option value="">All severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {severityLabel(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[8rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ViolationStatus | '')}
              className={gdcUi.select}
              data-testid="violation-filter-status"
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
              data-testid="violation-clear-filters"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      <section aria-label="Violation list" data-testid="violation-list-section">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Investigate
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Policy violation feed
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Select a row to open policy match evidence and related Quarantine or Replay context.
          </p>
        </div>

        {!loading && violations.length === 0 && !error ? (
          filtersActive ? (
            <div
              className={cn(gdcUi.emptyPanel)}
              data-testid="violation-no-match-state"
              role="status"
            >
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No violations match these filters
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Clear filters or widen the time range to broaden the feed.
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                data-testid="violation-no-match-clear"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div
              className={cn(gdcUi.emptyPanel)}
              data-testid="violation-empty-state"
              role="status"
            >
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No policy violations found
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Try a wider time range if you expected recent policy matches.
              </p>
            </div>
          )
        ) : (
          <div className={cn(gdcUi.cardShell, 'overflow-x-auto')}>
            <table className={opTable} data-testid="violation-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh} scope="col">
                    Severity
                  </th>
                  <th className={opTh} scope="col">
                    Policy
                  </th>
                  <th className={opTh} scope="col">
                    Stream
                  </th>
                  <th className={opTh} scope="col">
                    Reason
                  </th>
                  <th className={opTh} scope="col">
                    Status
                  </th>
                  <th className={opTh} scope="col">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && violations.length === 0 ? (
                  <tr className={opTr}>
                    <td colSpan={6} className={cn(opTd, 'py-8 text-center text-slate-500')}>
                      <span className="inline-flex items-center gap-2" data-testid="violation-loading">
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                        Loading violations…
                      </span>
                    </td>
                  </tr>
                ) : (
                  violations.map((row) => {
                    const selected = selectedId === row.id
                    return (
                      <tr
                        key={row.id}
                        className={cn(
                          opTr,
                          'cursor-pointer hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:focus-visible:bg-gdc-rowHover',
                          selected && 'bg-violet-50/70 dark:bg-violet-500/10',
                        )}
                        onClick={() => void openDetail(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            void openDetail(row.id)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                        aria-label={`Investigate ${row.policy_name} violation on ${row.stream_name}`}
                        aria-pressed={selected}
                        data-testid={`violation-row-${row.id}`}
                      >
                        <td className={opTd}>
                          <span
                            className={cn(
                              'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                              severityBadgeClass(row.severity),
                            )}
                          >
                            {severityLabel(row.severity)}
                          </span>
                        </td>
                        <td className={opTd}>
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {row.policy_name}
                          </span>
                        </td>
                        <td className={opTd}>{row.stream_name}</td>
                        <td className={cn(opTd, 'max-w-xs truncate')} title={row.reason}>
                          {row.reason}
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
                        <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>
                          {formatTime(row.event_time)}
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

      {selectedId ? (
        <ViolationDetailDrawer detail={detail} loading={detailLoading} onClose={closeDetail} />
      ) : null}
    </div>
  )
}
