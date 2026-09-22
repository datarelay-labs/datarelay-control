import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchGovernanceOperationsQueue,
  fetchGovernanceOperationsSummary,
  type GovernanceOperationsActionRequiredItem,
  type GovernanceOperationsApprovalQueueItem,
  type GovernanceOperationsNotificationQueueItem,
  type GovernanceOperationsQuarantineQueueItem,
  type GovernanceOperationsReplayQueueItem,
  type GovernanceOperationsSummaryResponse,
  type GovernanceOperationsViolationQueueItem,
} from '../../api/gdcGovernanceOperations'
import { NAV_PATH } from '../../config/nav-paths'
import {
  canApprovePolicy,
  canDiscardQuarantine,
  canExecuteReplay,
  canReleaseQuarantine,
  canViewGovernanceOperations,
  governanceReadOnlyReason,
} from '../../lib/governance-rbac'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { GovernanceActionQueuePanel } from './governance-action-queue-panel'

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

const QUEUE_LINKS: readonly {
  key: keyof GovernanceOperationsSummaryResponse
  label: string
  testId: string
  to: string
  emphasize?: 'warning' | 'critical'
}[] = [
  { key: 'pending_approvals', label: 'Pending Approvals', testId: 'ops-queue-approvals', to: NAV_PATH.governanceApprovals, emphasize: 'warning' },
  { key: 'open_violations', label: 'Open Violations', testId: 'ops-queue-violations', to: NAV_PATH.governanceViolations, emphasize: 'warning' },
  { key: 'quarantined_events', label: 'Quarantined Events', testId: 'ops-queue-quarantine', to: NAV_PATH.governanceQuarantine },
  { key: 'failed_replays', label: 'Failed Replays', testId: 'ops-queue-failed-replays', to: `${NAV_PATH.governanceReplay}?status=FAILED`, emphasize: 'critical' },
  { key: 'failed_notifications', label: 'Failed Notifications', testId: 'ops-queue-notifications', to: NAV_PATH.governanceNotifications, emphasize: 'critical' },
]

function priorityClass(priority: string): string {
  switch (priority) {
    case 'critical':
      return 'border-red-200 bg-red-50/70 dark:border-red-500/30 dark:bg-red-500/10'
    case 'high':
      return 'border-orange-200 bg-orange-50/70 dark:border-orange-500/30 dark:bg-orange-500/10'
    default:
      return 'border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10'
  }
}

function ActionButton({
  label,
  to,
  testId,
  disabled,
}: {
  label: string
  to: string
  testId: string
  disabled?: boolean
}) {
  if (disabled) {
    return (
      <span
        data-testid={testId}
        className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-400 dark:border-gdc-border"
      >
        {label}
      </span>
    )
  }
  return (
    <Link
      to={to}
      data-testid={testId}
      className="inline-flex rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-card"
    >
      {label}
    </Link>
  )
}

function ActionRequiredCard({ item }: { item: GovernanceOperationsActionRequiredItem }) {
  return (
    <div
      className={cn('rounded-lg border p-3', priorityClass(item.priority))}
      data-testid={`ops-action-required-${item.category}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.label}</p>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-gdc-mutedStrong">{item.recommended_action}</p>
        </div>
      </div>
    </div>
  )
}

function ApprovalCard({ item, readOnly }: { item: GovernanceOperationsApprovalQueueItem; readOnly: boolean }) {
  const to = `${NAV_PATH.governanceApprovals}?policy=${item.policy_id}`
  return (
    <div className={cn(gdcUi.innerWell, 'p-3')} data-testid={`ops-approval-${item.policy_id}`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.policy_name}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
        {item.requester ? `Requested by ${item.requester}` : 'Awaiting review'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton label="Approve" to={to} testId={`ops-approve-${item.policy_id}`} disabled={readOnly || !canApprovePolicy()} />
        <ActionButton label="Reject" to={to} testId={`ops-reject-${item.policy_id}`} disabled={readOnly || !canApprovePolicy()} />
      </div>
    </div>
  )
}

function ViolationCard({ item }: { item: GovernanceOperationsViolationQueueItem }) {
  const detailTo = `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(item.violation_id)}`
  return (
    <div className={cn(gdcUi.innerWell, 'p-3')} data-testid={`ops-violation-${item.violation_id}`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.policy_name ?? 'Unknown policy'}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
        {item.stream_name ?? '—'} · {item.severity} · {item.status}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton label="Investigate" to={detailTo} testId={`ops-investigate-${item.violation_id}`} />
        <ActionButton label="Open Detail" to={detailTo} testId={`ops-violation-detail-${item.violation_id}`} />
      </div>
    </div>
  )
}

function QuarantineCard({ item, readOnly }: { item: GovernanceOperationsQuarantineQueueItem; readOnly: boolean }) {
  return (
    <div className={cn(gdcUi.innerWell, 'p-3')} data-testid={`ops-quarantine-${item.quarantine_id}`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.stream_name ?? 'Stream'}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">{item.quarantine_reason ?? item.status}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton label="Release" to={NAV_PATH.governanceQuarantine} testId={`ops-release-${item.quarantine_id}`} disabled={readOnly || !canReleaseQuarantine()} />
        <ActionButton label="Discard" to={NAV_PATH.governanceQuarantine} testId={`ops-discard-${item.quarantine_id}`} disabled={readOnly || !canDiscardQuarantine()} />
        <ActionButton label="Replay" to={NAV_PATH.governanceReplay} testId={`ops-quarantine-replay-${item.quarantine_id}`} disabled={readOnly || !canExecuteReplay()} />
      </div>
    </div>
  )
}

function ReplayCard({ item, readOnly }: { item: GovernanceOperationsReplayQueueItem; readOnly: boolean }) {
  const isFailed = item.status === 'FAILED'
  return (
    <div className={cn(gdcUi.innerWell, 'p-3')} data-testid={`ops-replay-${item.replay_id}`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.stream_name ?? 'Stream'}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">{item.status}{item.outcome ? ` · ${item.outcome}` : ''}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton label="Execute" to={`${NAV_PATH.governanceReplay}?id=${item.replay_id}`} testId={`ops-replay-execute-${item.replay_id}`} disabled={readOnly || !canExecuteReplay()} />
        {isFailed ? (
          <ActionButton label="Retry" to={`${NAV_PATH.governanceReplay}?id=${item.replay_id}&retry=1`} testId={`ops-replay-retry-${item.replay_id}`} disabled={readOnly || !canExecuteReplay()} />
        ) : null}
      </div>
    </div>
  )
}

function NotificationCard({ item }: { item: GovernanceOperationsNotificationQueueItem }) {
  return (
    <div className={cn(gdcUi.innerWell, 'p-3')} data-testid={`ops-notification-${item.notification_id}`}>
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.event_type.replace(/_/g, ' ')}</p>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">{item.severity} · {item.status}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ActionButton label="View Failure" to={NAV_PATH.governanceNotifications} testId={`ops-notification-view-${item.notification_id}`} />
        <ActionButton label="Retry Delivery" to={NAV_PATH.governanceNotifications} testId={`ops-notification-retry-${item.notification_id}`} />
      </div>
    </div>
  )
}

function deriveOpsPosture(summary: GovernanceOperationsSummaryResponse | null): 'healthy' | 'warning' | 'critical' {
  if (!summary) return 'healthy'
  if (summary.failed_replays > 0 || summary.failed_notifications > 0) return 'critical'
  if (summary.open_violations > 0 || summary.pending_approvals > 0 || summary.quarantined_events > 0) return 'warning'
  return 'healthy'
}

function opsPostureShell(posture: 'healthy' | 'warning' | 'critical'): string {
  if (posture === 'critical') return 'border-red-300/80 bg-red-50 dark:border-red-500/40 dark:bg-red-950/30'
  if (posture === 'warning') return 'border-amber-300/80 bg-amber-50 dark:border-amber-500/35 dark:bg-amber-950/25'
  return 'border-emerald-300/80 bg-emerald-50 dark:border-emerald-500/35 dark:bg-emerald-950/25'
}

function opsPostureLabel(posture: 'healthy' | 'warning' | 'critical'): string {
  if (posture === 'critical') return 'Needs recovery'
  if (posture === 'warning') return 'Needs action'
  return 'Clear'
}

function opsPostureDescription(summary: GovernanceOperationsSummaryResponse | null, posture: 'healthy' | 'warning' | 'critical'): string {
  if (!summary) return 'Operations summary is still loading or unavailable'
  if (posture === 'critical') {
    if (summary.failed_replays > 0) {
      return `${formatCount(summary.failed_replays)} failed replay job${summary.failed_replays === 1 ? '' : 's'} need execute or retry`
    }
    return `${formatCount(summary.failed_notifications)} failed notification${summary.failed_notifications === 1 ? '' : 's'} need attention`
  }
  if (posture === 'warning') {
    const parts: string[] = []
    if (summary.open_violations > 0) parts.push(`${formatCount(summary.open_violations)} open violation${summary.open_violations === 1 ? '' : 's'}`)
    if (summary.pending_approvals > 0) parts.push(`${formatCount(summary.pending_approvals)} pending approval${summary.pending_approvals === 1 ? '' : 's'}`)
    if (summary.quarantined_events > 0) parts.push(`${formatCount(summary.quarantined_events)} quarantined event${summary.quarantined_events === 1 ? '' : 's'}`)
    return parts.length > 0 ? `${parts.join(' · ')} — start with the action queue` : 'Attention items detected in the queue summary'
  }
  return 'No pending approvals, open violations, failed replays, or failed notifications in the summary'
}

export function OperationsCenterPage() {
  const readOnlyReason = governanceReadOnlyReason()
  const readOnly = Boolean(readOnlyReason)
  const [summary, setSummary] = useState<GovernanceOperationsSummaryResponse | null>(null)
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof fetchGovernanceOperationsQueue>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [summaryResp, queueResp] = await Promise.all([
        fetchGovernanceOperationsSummary(),
        fetchGovernanceOperationsQueue(),
      ])
      setSummary(summaryResp)
      setQueue(queueResp)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load operations data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const posture = useMemo(() => deriveOpsPosture(summary), [summary])

  if (!canViewGovernanceOperations()) {
    return (
      <section
        className="rounded-xl border border-amber-300/70 bg-amber-500/[0.06] p-6 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        data-testid="operations-unauthorized"
        role="alert"
      >
        <h2 className="text-base font-semibold">Governance Operations unavailable</h2>
        <p className="mt-2">Governance Operations requires Governance Operator role or higher. Use the Executive Dashboard for read-only visibility.</p>
        <Link
          to={NAV_PATH.governance}
          className="mt-3 inline-block text-sm font-medium text-slate-800 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-100"
        >
          Go to Dashboard
        </Link>
      </section>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="operations-center-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Operational Governance Center
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            What should I act on first? Scan queue posture, work the prioritized action queue, then open the matching
            investigation target with existing deep links preserved.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          data-testid="ops-refresh"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          aria-label="Refresh operations center"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </header>

      {readOnlyReason ? (
        <div
          className="rounded-lg border border-amber-300/70 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="ops-read-only-banner"
          role="status"
        >
          <span className="font-semibold">Read-only view.</span> {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          role="alert"
          data-testid="ops-error"
        >
          {error}
        </div>
      ) : null}

      <section
        aria-label="Operations queue posture"
        data-testid="ops-posture-overview"
        className={cn('rounded-xl border px-5 py-4 shadow-sm', opsPostureShell(posture))}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300">Queue posture</p>
            <p className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-50" data-testid="ops-posture-label">
              {opsPostureLabel(posture)}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted" data-testid="ops-posture-summary">
              {opsPostureDescription(summary, posture)}
            </p>
          </div>
          <dl className="flex flex-wrap gap-2" data-testid="ops-queue-summary">
            {QUEUE_LINKS.map((item) => {
              const value = summary?.[item.key] ?? 0
              return (
                <Link
                  key={item.testId}
                  to={item.to}
                  data-testid={item.testId}
                  className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card/70"
                >
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{item.label}</dt>
                  <dd
                    className={cn(
                      'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
                      item.emphasize === 'critical' && value > 0 && 'text-red-600 dark:text-red-400',
                      item.emphasize === 'warning' && value > 0 && 'text-amber-600 dark:text-amber-400',
                    )}
                    data-testid={`${item.testId}-value`}
                  >
                    {formatCount(value)}
                  </dd>
                </Link>
              )
            })}
          </dl>
        </div>
      </section>

      <section
        className={cn(gdcUi.cardShell, 'p-4')}
        aria-label="Action Queue"
        data-testid="ops-action-queue"
      >
        <div className="mb-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Start here</p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Prioritized action queue</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Sorted by priority. Each item links into the existing approval, violation, quarantine, or replay workspace.
          </p>
        </div>
        <GovernanceActionQueuePanel
          queue={queue}
          readOnly={readOnly}
          canApprove={canApprovePolicy()}
          canRelease={canReleaseQuarantine()}
          canReplay={canExecuteReplay()}
          testId="gov-action-queue-panel"
        />
      </section>

      <section className="space-y-4 border-t border-slate-200/70 pt-4 dark:border-gdc-divider" data-testid="ops-detail-cards">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Investigation targets</p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Violations · Replay · Quarantine · Approvals · Notifications
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Detail cards preserve existing deep-link and RBAC action contracts after the queue.
          </p>
        </div>

        <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-action-required">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Attention signals</h3>
          {(queue?.action_required.length ?? 0) === 0 ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-gdc-muted" data-testid="ops-action-required-empty">
              No attention signals
            </p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {queue?.action_required.map((item) => <ActionRequiredCard key={`${item.category}-${item.priority}`} item={item} />)}
            </div>
          )}
        </section>

        <div className="grid gap-3 xl:grid-cols-2">
          <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-pending-approvals">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Pending Approvals</h3>
            {(queue?.pending_approvals.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No pending approvals</p>
            ) : (
              <div className="mt-3 space-y-2">
                {queue?.pending_approvals.map((item) => <ApprovalCard key={item.policy_id} item={item} readOnly={readOnly} />)}
              </div>
            )}
          </section>

          <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-violation-actions">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Violations</h3>
            {(queue?.violations.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No open violations in queue</p>
            ) : (
              <div className="mt-3 space-y-2">
                {queue?.violations.map((item) => <ViolationCard key={item.violation_id} item={item} />)}
              </div>
            )}
          </section>

          <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-quarantine-actions">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Quarantine</h3>
            {(queue?.quarantine.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No quarantined events in queue</p>
            ) : (
              <div className="mt-3 space-y-2">
                {queue?.quarantine.map((item) => <QuarantineCard key={item.quarantine_id} item={item} readOnly={readOnly} />)}
              </div>
            )}
          </section>

          <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-replay-actions">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Replay</h3>
            {(queue?.replays.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No replay jobs in queue</p>
            ) : (
              <div className="mt-3 space-y-2">
                {queue?.replays.map((item) => <ReplayCard key={item.replay_id} item={item} readOnly={readOnly} />)}
              </div>
            )}
          </section>
        </div>

        <section className={cn(gdcUi.cardShell, 'p-4')} data-testid="ops-notification-actions">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Notifications</h3>
          {(queue?.notifications.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No failed notifications</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {queue?.notifications.map((item) => <NotificationCard key={item.notification_id} item={item} />)}
            </div>
          )}
        </section>
      </section>
    </div>
  )
}
