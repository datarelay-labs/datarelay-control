import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
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

function statusBadgeClass(status: QuarantineDisplayStatus) {
  switch (status) {
    case 'QUARANTINED':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    case 'RELEASED':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    case 'DISCARDED':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
    case 'REPLAYED':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
}

function severityBadgeClass(severity: QuarantineSeverity) {
  switch (severity) {
    case 'HIGH':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    case 'MEDIUM':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
  }
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

  return (
    <GovernanceInvestigationDrawer
      title="Investigation"
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
      whatHappened={
        detail && entry ? (
          <>
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{detail.policy_summary.policy_name}</p>
            {detail.policy_summary.rule_summary ? (
              <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{detail.policy_summary.rule_summary}</p>
            ) : null}
            <p className="text-[13px] text-slate-800 dark:text-slate-200">{detail.violation_reason}</p>
            <p className="text-[12px] text-slate-500">
              {entry.stream_name} · {formatTime(entry.quarantined_at)}
            </p>
          </>
        ) : null
      }
      why={
        detail ? (
          <>
            {detail.classification ? (
              <p className="text-[13px] text-slate-800 dark:text-slate-200">
                Classification: <span className="font-medium">{detail.classification}</span>
              </p>
            ) : null}
            {detail.sensitive_findings.length > 0 ? (
              <div>
                <p className="text-[11px] text-slate-500">Sensitive findings</p>
                <ul className="mt-1 space-y-0.5 text-[12px] text-slate-700 dark:text-gdc-muted">
                  {detail.sensitive_findings.map((f) => (
                    <li key={`${f.field_path}-${f.sensitivity_class}`}>
                      {f.field_path} · {f.sensitivity_class}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {detail.protection_actions.length > 0 ? (
              <div>
                <p className="text-[11px] text-slate-500">Protection actions</p>
                <ul className="mt-1 space-y-0.5 text-[12px] text-slate-700 dark:text-gdc-muted">
                  {detail.protection_actions.map((a) => (
                    <li key={`${a.field_path}-${a.protection_mode}`}>
                      {a.field_path} → {a.protection_mode.replace('_', ' ')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
              Policy decision: {detail.policy_decision.action}
              {detail.policy_decision.summary ? ` — ${detail.policy_decision.summary}` : ''}
            </p>
          </>
        ) : null
      }
      related={
        detail && entry ? (
          <>
            {detail.related_replay.length > 0 ? (
              <ul className="space-y-0.5 text-[12px] text-slate-700 dark:text-gdc-muted">
                {detail.related_replay.map((r) => (
                  <li key={r.replay_event_id}>
                    Replay #{r.replay_event_id} · {r.status} · {r.event_count} events
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-slate-500">No related replay events in window.</p>
            )}
            {detail.related_violation ? (
              <p className="mt-2 text-[12px] text-slate-700 dark:text-gdc-muted">
                Violation{' '}
                <Link
                  to={NAV_PATH.governanceViolations}
                  className="text-violet-600 hover:underline dark:text-violet-400"
                  data-testid="quarantine-open-violation"
                >
                  {detail.related_violation.violation_id}
                </Link>{' '}
                · {detail.related_violation.status}
              </p>
            ) : null}
            <p className="text-[12px] text-slate-700 dark:text-gdc-muted">
              Quarantine #{detail.related_quarantine.quarantine_event_id} · {detail.related_quarantine.event_count}{' '}
              events
            </p>
            <Link
              to={logsExplorerPath({ stream_id: entry.stream_id, stage: 'quarantine_event_created' })}
              className="inline-block text-[12px] text-violet-600 hover:underline dark:text-violet-400"
              data-testid="quarantine-view-logs"
            >
              View in Logs
            </Link>
          </>
        ) : null
      }
      whatShouldIDo={
        !readOnly && entry ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionLoading || entry.status !== 'QUARANTINED'}
              onClick={onRelease}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              data-testid="quarantine-action-release"
            >
              Release
            </button>
            <button
              type="button"
              disabled={actionLoading || entry.status !== 'QUARANTINED'}
              onClick={onDiscard}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              data-testid="quarantine-action-discard"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={actionLoading}
              onClick={onReplay}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
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

  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<GovernanceQuarantineEntry[]>([])
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [window, setWindow] = useState<QuarantineWindow>('24h')
  const [policyId, setPolicyId] = useState<number | ''>('')
  const [streamId, setStreamId] = useState<number | ''>('')
  const [status, setStatus] = useState<QuarantineDisplayStatus | ''>('')
  const [severity, setSeverity] = useState<QuarantineSeverity | ''>('')
  const [classification, setClassification] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [drawerId, setDrawerId] = useState<number | null>(null)
  const [detail, setDetail] = useState<GovernanceQuarantineDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<PendingQuarantineCenterAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmTypeValue, setConfirmTypeValue] = useState('')

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

  const openDetail = async (id: number) => {
    setDrawerId(id)
    setDetailLoading(true)
    setDetail(null)
    try {
      const d = await fetchGovernanceQuarantineDetail(id, window === '24h' ? '7d' : window)
      setDetail(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
    <div className="space-y-4" data-testid="quarantine-center-page">
      {readOnlyReason ? (
        <div
          role="status"
          data-testid="quarantine-read-only-banner"
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-[12px] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200/90 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="inline-flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-slate-100">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
              Quarantine Operations
            </p>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">
              Review quarantined events, investigate causes, and release or discard from one workflow.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            data-testid="quarantine-refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" data-testid="quarantine-filters">
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value as QuarantineWindow)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="quarantine-filter-window"
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
          <select
            value={streamId}
            onChange={(e) => setStreamId(e.target.value === '' ? '' : Number(e.target.value))}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
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
          <select
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
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
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as QuarantineSeverity | '')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="quarantine-filter-severity"
            aria-label="Severity"
          >
            <option value="">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as QuarantineDisplayStatus | '')}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs dark:border-gdc-border dark:bg-gdc-card"
            data-testid="quarantine-filter-status"
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

        {!readOnly && selectedIds.size > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2" data-testid="quarantine-bulk-actions">
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runBulk('release')}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              data-testid="quarantine-bulk-release"
            >
              Release Selected ({selectedIds.size})
            </button>
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void runBulk('discard')}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200"
              data-testid="quarantine-bulk-discard"
            >
              Discard Selected ({selectedIds.size})
            </button>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {!loading && events.length === 0 && !error ? (
        <div
          className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center dark:border-gdc-border dark:bg-gdc-card/50"
          data-testid="quarantine-empty-state"
        >
          <p className="text-[13px] font-medium text-slate-700 dark:text-slate-200">No quarantined events found</p>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-gdc-muted">Try a wider time range or adjust filters.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200/90 bg-white dark:border-gdc-border dark:bg-gdc-card">
          <table className={opTable} data-testid="quarantine-table">
            <thead>
              <tr className={opThRow}>
                {!readOnly ? (
                  <th className={opTh}>
                    <input
                      type="checkbox"
                      checked={events.length > 0 && selectedIds.size === events.length}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                      data-testid="quarantine-select-all"
                    />
                  </th>
                ) : null}
                <th className={opTh}>Policy</th>
                <th className={opTh}>Stream</th>
                <th className={opTh}>Classification</th>
                <th className={opTh}>Severity</th>
                <th className={opTh}>Reason</th>
                <th className={opTh}>Status</th>
                <th className={opTh}>Quarantined At</th>
              </tr>
            </thead>
            <tbody>
              {loading && events.length === 0 ? (
                <tr className={opTr}>
                  <td colSpan={readOnly ? 7 : 8} className={cn(opTd, 'text-center text-slate-500')}>
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden />
                  </td>
                </tr>
              ) : (
                events.map((row) => (
                  <tr
                    key={row.id}
                    className={cn(opTr, 'cursor-pointer hover:bg-slate-50 dark:hover:bg-gdc-rowHover')}
                    onClick={() => void openDetail(row.id)}
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
                      <span className="font-medium text-slate-900 dark:text-slate-100">{row.policy_name}</span>
                    </td>
                    <td className={opTd}>{row.stream_name}</td>
                    <td className={opTd}>{row.classification ?? '—'}</td>
                    <td className={opTd}>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                          severityBadgeClass(row.severity),
                        )}
                      >
                        {row.severity}
                      </span>
                    </td>
                    <td className={cn(opTd, 'max-w-xs truncate')} title={row.reason}>
                      {row.reason}
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
                    <td className={cn(opTd, 'whitespace-nowrap text-slate-500')}>{formatTime(row.quarantined_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

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
