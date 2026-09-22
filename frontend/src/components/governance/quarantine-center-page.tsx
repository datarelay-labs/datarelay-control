import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  discardGovernanceQuarantineEvents,
  fetchGovernanceQuarantineDetail,
  fetchGovernanceQuarantineEvents,
  releaseGovernanceQuarantineEvents,
  replayGovernanceQuarantineEvents,
  type GovernanceQuarantineDetailResponse,
  type GovernanceQuarantineEntry,
  type QuarantineDisplayStatus,
  type QuarantineSeverity,
  type QuarantineWindow,
} from '../../api/gdcGovernanceQuarantine'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { fetchStreamsList } from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { NAV_PATH, logsExplorerPath } from '../../config/nav-paths'
import { canDiscardQuarantine, canExecuteReplay, canReleaseQuarantine, governanceReadOnlyReason } from '../../lib/governance-rbac'
import { humanizeQuarantineReason } from '../../lib/humanize-quarantine-reason'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'

type PendingQuarantineCenterAction = {
  kind: 'release' | 'discard' | 'replay'
  ids: number[]
}

const WINDOWS: readonly QuarantineWindow[] = ['24h', '7d', '30d'] as const
const STATUSES: readonly QuarantineDisplayStatus[] = ['QUARANTINED', 'RELEASED', 'DISCARDED', 'REPLAYED'] as const
const SEVERITIES: readonly QuarantineSeverity[] = ['HIGH', 'MEDIUM', 'LOW'] as const
const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const

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

function parseQuarantineId(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

function quarantinePath(id: number): string {
  return `${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(id))}`
}

function statusBadgeClass(status: QuarantineDisplayStatus) {
  switch (status) {
    case 'QUARANTINED':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-200'
    case 'RELEASED':
      return 'bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-500/30 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
    case 'REPLAYED':
      return 'bg-violet-500/15 text-violet-800 ring-1 ring-violet-500/30 dark:text-violet-200'
    default:
      return 'bg-slate-500/10 text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300'
  }
}

function severityBadgeClass(severity: QuarantineSeverity) {
  switch (severity) {
    case 'HIGH':
      return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
    case 'MEDIUM':
      return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300'
    default:
      return 'bg-slate-500/10 text-slate-600 ring-1 ring-slate-500/20 dark:text-slate-400'
  }
}

function severityLabel(severity: QuarantineSeverity): string {
  if (severity === 'HIGH') return 'High'
  if (severity === 'MEDIUM') return 'Medium'
  return 'Low'
}

function statusLabel(status: QuarantineDisplayStatus): string {
  switch (status) {
    case 'QUARANTINED':
      return 'Quarantined'
    case 'RELEASED':
      return 'Released'
    case 'DISCARDED':
      return 'Discarded'
    case 'REPLAYED':
      return 'Replayed'
    default:
      return status
  }
}

function actionButtonClass(variant: 'primary' | 'secondary' | 'danger' = 'secondary') {
  if (variant === 'primary') {
    return 'inline-flex rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 disabled:opacity-50'
  }
  if (variant === 'danger') {
    return 'inline-flex rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover'
  }
  return 'inline-flex rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100'
}

function InvestigationDrawer({
  detail,
  loading,
  actionLoading,
  readOnly,
  onClose,
  onRelease,
  onDiscard,
  onReplay,
}: {
  detail: GovernanceQuarantineDetailResponse | null
  loading: boolean
  actionLoading: boolean
  readOnly: boolean
  onClose: () => void
  onRelease: () => void
  onDiscard: () => void
  onReplay: () => void
}) {
  const entry = detail?.entry
  const strip = detail?.root_cause_strip
  const violationHref = detail?.related_violation
    ? `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(detail.related_violation.violation_id)}`
    : null
  const replayHref =
    detail && detail.related_replay.length > 0
      ? `${NAV_PATH.governanceReplay}?id=${encodeURIComponent(String(detail.related_replay[0].replay_event_id))}`
      : NAV_PATH.governanceReplay

  return (
    <GovernanceInvestigationDrawer
      title="Quarantine investigation"
      testId="quarantine-detail-drawer"
      closeTestId="quarantine-detail-close"
      loading={loading}
      hasContent={Boolean(detail && entry)}
      onClose={onClose}
      rootCauseStrip={strip?.summary ?? null}
      rootCauseTestId="quarantine-root-cause-strip"
      whatHappenedTestId="quarantine-section-what-happened"
      whyTestId="quarantine-section-why"
      whatShouldIDoTestId="quarantine-section-what-should-i-do"
      relatedTestId="quarantine-section-related"
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
            {detail.policy_summary.rule_summary ? (
              <div
                className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section"
                data-testid="quarantine-matched-rule"
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
              <p className="text-sm text-slate-800 dark:text-slate-200">
                {humanizeQuarantineReason(detail.violation_reason)}
              </p>
            </div>
            <p className="text-xs text-slate-500 dark:text-gdc-muted">
              {entry.stream_name} · {formatTime(entry.quarantined_at)}
            </p>
          </div>
        ) : null
      }
      why={
        detail ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {entry ? (
                <>
                  <span
                    className={cn(
                      'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                      severityBadgeClass(entry.severity),
                    )}
                  >
                    {severityLabel(entry.severity)}
                  </span>
                  <span
                    className={cn(
                      'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold',
                      statusBadgeClass(entry.status),
                    )}
                  >
                    {statusLabel(entry.status)}
                  </span>
                </>
              ) : null}
              {detail.classification ? (
                <span className="inline-flex rounded-md bg-slate-500/10 px-2 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-500/20 dark:text-slate-300">
                  {detail.classification}
                </span>
              ) : null}
            </div>
            {detail.sensitive_findings.length > 0 ? (
              <div data-testid="quarantine-sensitive-findings">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Sensitive findings
                </p>
                <ul className="mt-1 space-y-1 text-sm text-slate-700 dark:text-slate-200">
                  {detail.sensitive_findings.map((f) => (
                    <li key={`${f.field_path}-${f.sensitivity_class}`}>
                      {f.field_path} · {f.sensitivity_class}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {detail.protection_actions.length > 0 ? (
              <div data-testid="quarantine-protection-actions">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Protection actions
                </p>
                <ul className="mt-1 space-y-1 text-sm text-slate-700 dark:text-slate-200">
                  {detail.protection_actions.map((a) => (
                    <li key={`${a.field_path}-${a.protection_mode}`}>
                      {a.field_path} → {a.protection_mode.replace('_', ' ')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-sm text-slate-700 dark:text-slate-200">
              Policy decision: {detail.policy_decision.action}
              {detail.policy_decision.summary ? ` — ${detail.policy_decision.summary}` : ''}
            </p>
          </div>
        ) : null
      }
      related={
        detail && entry ? (
          <div className="space-y-3" data-testid="quarantine-related-evidence">
            {detail.related_violation ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Violation
                </p>
                <p className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {detail.related_violation.violation_id} · {detail.related_violation.status}
                </p>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">
                  {humanizeQuarantineReason(detail.related_violation.reason)}
                </p>
                {violationHref ? (
                  <Link
                    to={violationHref}
                    className="mt-2 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                    data-testid="quarantine-open-violation"
                  >
                    Open Violation
                  </Link>
                ) : null}
              </div>
            ) : null}
            {detail.related_replay.length > 0 ? (
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                  Replay
                </p>
                <ul className="mt-1 space-y-1.5">
                  {detail.related_replay.map((r) => (
                    <li key={r.replay_event_id} className="text-sm text-slate-700 dark:text-slate-200">
                      #{r.replay_event_id} · {r.status} · {r.event_count} events
                    </li>
                  ))}
                </ul>
                <Link
                  to={replayHref}
                  className="mt-2 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                  data-testid="quarantine-related-replay-link"
                >
                  Open Replay
                </Link>
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-gdc-muted">
                No related replay events in window.
              </p>
            )}
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Quarantine record
              </p>
              <p className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                #{detail.related_quarantine.quarantine_event_id} · {detail.related_quarantine.event_count}{' '}
                events
              </p>
              <Link
                to={logsExplorerPath({ stream_id: entry.stream_id, stage: 'quarantine_event_created' })}
                className="mt-2 inline-flex text-xs font-semibold text-violet-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                data-testid="quarantine-view-logs"
              >
                View delivery records
              </Link>
            </div>
          </div>
        ) : null
      }
      whatShouldIDo={
        !readOnly && entry ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionLoading || entry.status !== 'QUARANTINED'}
              onClick={onRelease}
              className={actionButtonClass('primary')}
              data-testid="quarantine-action-release"
            >
              Release
            </button>
            <button
              type="button"
              disabled={actionLoading || entry.status !== 'QUARANTINED'}
              onClick={onDiscard}
              className={actionButtonClass('danger')}
              data-testid="quarantine-action-discard"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={actionLoading}
              onClick={onReplay}
              className={actionButtonClass()}
              data-testid="quarantine-action-replay"
            >
              Replay
            </button>
          </div>
        ) : null
      }
    />
  )
}

export function QuarantineCenterPage() {
  const canAct = canReleaseQuarantine() || canDiscardQuarantine() || canExecuteReplay()
  const readOnly = !canAct
  const readOnlyReason = governanceReadOnlyReason()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlId = parseQuarantineId(searchParams.get('id'))

  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<GovernanceQuarantineEntry[]>([])
  const [total, setTotal] = useState(0)
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [window, setWindow] = useState<QuarantineWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [streamId, setStreamId] = useState<number | ''>('')
  const [status, setStatus] = useState<QuarantineDisplayStatus | ''>('')
  const [severity, setSeverity] = useState<QuarantineSeverity | ''>('')
  const [classification, setClassification] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [drawerId, setDrawerId] = useState<number | null>(urlId)
  const [detail, setDetail] = useState<GovernanceQuarantineDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingQuarantineCenterAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmTypeValue, setConfirmTypeValue] = useState('')
  const openedFromUrlRef = useRef<number | null>(null)

  const filtersActive =
    policyId !== '' || streamId !== '' || status !== '' || severity !== '' || classification !== ''

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchGovernanceQuarantineEvents({
        window,
        policy_id: policyId === '' ? undefined : policyId,
        stream_id: streamId === '' ? undefined : streamId,
        status: status === '' ? undefined : status,
        severity: severity === '' ? undefined : severity,
        classification: classification === '' ? undefined : classification,
      })
      setEvents(data?.quarantine_events ?? [])
      setTotal(data?.total ?? data?.quarantine_events?.length ?? 0)
      if (data == null) setError('Quarantine APIs unavailable.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [window, policyId, streamId, status, severity, classification])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void fetchGovernancePolicies().then((data) => setPolicies(data?.policies ?? []))
    void fetchStreamsList().then((data) => setStreams(data ?? []))
  }, [])

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

  const openDetail = useCallback(
    async (id: number) => {
      syncDrawerId(id)
      setDetailLoading(true)
      setDetail(null)
      try {
        const d = await fetchGovernanceQuarantineDetail(id, window === '24h' ? '7d' : window)
        setDetail(d)
        if (d == null) setError('Quarantine detail unavailable.')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [syncDrawerId, window],
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
    if (selectedIds.size === events.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(events.map((e) => e.id)))
    }
  }

  const requestAction = (kind: PendingQuarantineCenterAction['kind'], ids: number[]) => {
    if (readOnly || ids.length === 0) return
    setActionError(null)
    setError(null)
    setConfirmTypeValue('')
    setPendingAction({ kind, ids })
  }

  const runBulk = (action: 'release' | 'discard') => {
    if (readOnly || selectedIds.size === 0) return
    requestAction(action, Array.from(selectedIds))
  }

  const executePendingAction = async () => {
    if (!pendingAction || readOnly) return
    const { kind, ids } = pendingAction
    setActionLoading(true)
    setActionError(null)
    setError(null)
    try {
      if (kind === 'release') {
        const result = await releaseGovernanceQuarantineEvents(ids)
        if (result.failed > 0) {
          const msg =
            ids.length > 1
              ? `${result.failed} of ${result.total} operations failed.`
              : (result.results.find((r) => r.outcome !== 'released')?.message ?? 'Release failed.')
          setActionError(msg)
          setError(msg)
          return
        }
      } else if (kind === 'discard') {
        const result = await discardGovernanceQuarantineEvents(ids)
        if (result.failed > 0) {
          const msg =
            ids.length > 1
              ? `${result.failed} of ${result.total} operations failed.`
              : (result.results.find((r) => r.outcome !== 'discarded')?.message ?? 'Discard failed.')
          setActionError(msg)
          setError(msg)
          return
        }
      } else {
        const result = await replayGovernanceQuarantineEvents(ids)
        if (result.failed > 0) {
          const msg = result.results.find((r) => r.outcome !== 'replayed')?.message ?? 'Replay failed.'
          setActionError(msg)
          setError(msg)
          return
        }
      }
      setPendingAction(null)
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

  const runRelease = async (ids: number[]) => {
    requestAction('release', ids)
  }

  const runDiscard = async (ids: number[]) => {
    requestAction('discard', ids)
  }

  const runReplay = async (ids: number[]) => {
    requestAction('replay', ids)
  }

  const policyOptions = useMemo(() => policies.map((p) => ({ id: p.id, name: p.name })), [policies])
  const streamOptions = useMemo(() => streams.map((s) => ({ id: s.id, name: s.name })), [streams])

  const scanSummary = useMemo(() => {
    const held = events.filter((e) => e.status === 'QUARANTINED').length
    const high = events.filter((e) => e.severity === 'HIGH').length
    const restricted = events.filter((e) => e.classification === 'RESTRICTED').length
    return { held, high, restricted, shown: events.length, total }
  }, [events, total])

  const clearFilters = () => {
    setPolicyId('')
    setStreamId('')
    setStatus('')
    setSeverity('')
    setClassification('')
  }

  const pendingCount = pendingAction?.ids.length ?? 0
  const pendingTitle =
    pendingAction?.kind === 'release'
      ? pendingCount > 1
        ? `Release ${pendingCount} quarantine events?`
        : 'Release quarantine event?'
      : pendingAction?.kind === 'discard'
        ? pendingCount > 1
          ? `Discard ${pendingCount} quarantine events permanently?`
          : 'Discard quarantine event permanently?'
        : pendingCount > 1
          ? `Replay ${pendingCount} quarantine-linked events?`
          : 'Replay quarantine-linked event?'
  const pendingImpact =
    pendingAction?.kind === 'release'
      ? [
          'Delivers held quarantine payload(s) to configured destinations.',
          'Release may advance stream checkpoint(s).',
          'Duplicate downstream delivery is possible; platform deduplication is not assumed.',
        ]
      : pendingAction?.kind === 'discard'
        ? [
            'Permanently discards held quarantine payload(s).',
            'Events will not be delivered to destinations.',
            'This cannot be undone from the product UI.',
          ]
        : [
            'Executes linked pending replay job(s) for the selected quarantine event(s).',
            'Production checkpoint is not advanced by replay.',
            'Duplicate downstream delivery is possible.',
          ]

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="quarantine-center-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
            Quarantine Center
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            Prioritize held events, open an investigation, then Release, Discard, or Replay with the
            same confirmation safeguards and policy evidence as before.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          data-testid="quarantine-refresh"
          aria-label="Refresh quarantine events"
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
          data-testid="quarantine-read-only-banner"
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          role="alert"
          data-testid="quarantine-error"
        >
          {error}
        </div>
      ) : null}

      <section
        aria-label="Quarantine scan summary"
        data-testid="quarantine-scan-summary"
        className={cn(gdcUi.cardShell, 'px-5 py-4')}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Current queue
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading && events.length === 0
                ? 'Loading quarantined events…'
                : `${formatCount(scanSummary.shown)} event${scanSummary.shown === 1 ? '' : 's'} in view`}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
              Counts reflect the loaded quarantine list for the selected filters and time range.
            </p>
          </div>
          <dl className="flex flex-wrap gap-2" data-testid="quarantine-scan-counts">
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Held</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.held > 0 && 'text-amber-600 dark:text-amber-400',
                )}
                data-testid="quarantine-count-held"
              >
                {formatCount(scanSummary.held)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">High</dt>
              <dd
                className={cn(
                  'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                  scanSummary.high > 0 && 'text-red-600 dark:text-red-400',
                )}
                data-testid="quarantine-count-high"
              >
                {formatCount(scanSummary.high)}
              </dd>
            </div>
            <div className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Restricted</dt>
              <dd
                className="mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50"
                data-testid="quarantine-count-restricted"
              >
                {formatCount(scanSummary.restricted)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section
        className={cn(gdcUi.cardShell, 'p-4')}
        aria-label="Quarantine filters"
        data-testid="quarantine-filters-panel"
      >
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Prioritize
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Filter held events</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Narrow by time range, policy, stream, classification, severity, and status before opening an
            investigation.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3" data-testid="quarantine-filters">
          <label className="flex min-w-[7rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Time range</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as QuarantineWindow)}
              className={gdcUi.select}
              data-testid="quarantine-filter-window"
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
              data-testid="quarantine-filter-policy"
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
              data-testid="quarantine-filter-stream"
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
          <label className="flex min-w-[9rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Classification</span>
            <select
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
              className={gdcUi.select}
              data-testid="quarantine-filter-classification"
              aria-label="Classification"
            >
              <option value="">All classifications</option>
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[8rem] flex-col gap-1">
            <span className={gdcUi.formLabel}>Severity</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as QuarantineSeverity | '')}
              className={gdcUi.select}
              data-testid="quarantine-filter-severity"
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
              onChange={(e) => setStatus(e.target.value as QuarantineDisplayStatus | '')}
              className={gdcUi.select}
              data-testid="quarantine-filter-status"
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
              data-testid="quarantine-clear-filters"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {!readOnly && selectedIds.size > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/80 pt-3 dark:border-gdc-divider" data-testid="quarantine-bulk-actions">
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runBulk('release')}
              className={actionButtonClass('primary')}
              data-testid="quarantine-bulk-release"
            >
              Release Selected ({selectedIds.size})
            </button>
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runBulk('discard')}
              className={actionButtonClass('danger')}
              data-testid="quarantine-bulk-discard"
            >
              Discard Selected ({selectedIds.size})
            </button>
          </div>
        ) : null}
      </section>

      <section aria-label="Quarantine list" data-testid="quarantine-list-section">
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Investigate
          </p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Held event queue</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Select a row to open policy reason, sensitive findings, protection actions, and safe next
            actions.
          </p>
        </div>

        {!loading && events.length === 0 && !error ? (
          filtersActive ? (
            <div className={cn(gdcUi.emptyPanel)} data-testid="quarantine-no-match-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No quarantined events match these filters
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Clear filters or widen the time range to broaden the queue.
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 inline-flex rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                data-testid="quarantine-no-match-clear"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className={cn(gdcUi.emptyPanel)} data-testid="quarantine-empty-state" role="status">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                No quarantined events found
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                Try a wider time range if you expected recent held events.
              </p>
            </div>
          )
        ) : (
          <div className={cn(gdcUi.cardShell, 'overflow-x-auto')}>
            <table className={opTable} data-testid="quarantine-table">
              <thead>
                <tr className={opThRow}>
                  {!readOnly ? (
                    <th className={opTh} scope="col">
                      <input
                        type="checkbox"
                        checked={events.length > 0 && selectedIds.size === events.length}
                        onChange={toggleSelectAll}
                        aria-label="Select all"
                        data-testid="quarantine-select-all"
                      />
                    </th>
                  ) : null}
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
                    Classification
                  </th>
                  <th className={opTh} scope="col">
                    Reason
                  </th>
                  <th className={opTh} scope="col">
                    Status
                  </th>
                  <th className={opTh} scope="col">
                    Quarantined
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && events.length === 0 ? (
                  <tr className={opTr}>
                    <td colSpan={readOnly ? 7 : 8} className={cn(opTd, 'py-8 text-center text-slate-500')}>
                      <span className="inline-flex items-center gap-2" data-testid="quarantine-loading">
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                        Loading quarantine events…
                      </span>
                    </td>
                  </tr>
                ) : (
                  events.map((row) => {
                    const selected = drawerId === row.id
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
                        aria-label={`Investigate ${row.policy_name} quarantine on ${row.stream_name}`}
                        aria-pressed={selected}
                        data-testid={`quarantine-row-${row.id}`}
                      >
                        {!readOnly ? (
                          <td className={opTd} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              onChange={() => toggleSelect(row.id)}
                              aria-label={`Select quarantine ${row.id}`}
                              data-testid={`quarantine-select-${row.id}`}
                            />
                          </td>
                        ) : null}
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
                        <td className={opTd}>{row.classification ?? '—'}</td>
                        <td className={cn(opTd, 'max-w-xs truncate')} title={row.reason}>
                          {humanizeQuarantineReason(row.reason)}
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
                          {formatTime(row.quarantined_at)}
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

      {drawerId != null ? (
        <InvestigationDrawer
          detail={detail}
          loading={detailLoading}
          actionLoading={actionLoading}
          readOnly={readOnly}
          onClose={closeDetail}
          onRelease={() => void runRelease([drawerId])}
          onDiscard={() => void runDiscard([drawerId])}
          onReplay={() => void runReplay([drawerId])}
        />
      ) : null}

      {pendingAction ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && !actionLoading) {
              setPendingAction(null)
              setActionError(null)
              setConfirmTypeValue('')
            }
          }}
          title={pendingTitle}
          targetName={
            pendingCount === 1
              ? `quarantine #${pendingAction.ids[0]}`
              : `${pendingCount} selected quarantine events`
          }
          risk={pendingAction.kind === 'discard' ? 'critical' : 'high'}
          confirmMode={pendingAction.kind === 'discard' && pendingCount > 1 ? 'type-name' : 'click'}
          expectedTypeName={pendingAction.kind === 'discard' && pendingCount > 1 ? 'DISCARD' : ''}
          typeNameValue={confirmTypeValue}
          onTypeNameChange={setConfirmTypeValue}
          impactBullets={pendingImpact}
          dependencies={[{ label: 'Selected items', count: pendingCount }]}
          reversibility={
            pendingAction.kind === 'discard'
              ? 'Discard is irreversible.'
              : pendingAction.kind === 'release'
                ? 'Release cannot be undone. Checkpoint movement and duplicate delivery are possible.'
                : 'Replay cannot be undone. Duplicate destination delivery is possible.'
          }
          primaryLabel={
            pendingAction.kind === 'release'
              ? pendingCount > 1
                ? 'Release selected'
                : 'Release event'
              : pendingAction.kind === 'discard'
                ? pendingCount > 1
                  ? 'Discard selected'
                  : 'Discard event'
                : pendingCount > 1
                  ? 'Replay selected'
                  : 'Replay event'
          }
          busy={actionLoading}
          error={actionError}
          onConfirm={() => void executePendingAction()}
          dataTestId={`quarantine-center-${pendingAction.kind}-dialog`}
        />
      ) : null}
    </div>
  )
}

export { quarantinePath }
