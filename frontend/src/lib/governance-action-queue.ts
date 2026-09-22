import type { GovernanceOperationsQueueResponse } from '../api/gdcGovernanceOperations'
import { NAV_PATH } from '../config/nav-paths'

export type GovernanceActionPriority = 'critical' | 'high' | 'medium' | 'low'

export type GovernanceActionCtaLabel =
  | 'Acknowledge'
  | 'Resolve'
  | 'Replay'
  | 'Release'
  | 'View details'

export type GovernanceActionQueueItem = {
  id: string
  priority: GovernanceActionPriority
  category: string
  title: string
  subtitle: string
  ctas: ReadonlyArray<{
    label: GovernanceActionCtaLabel
    to: string
    testId: string
    disabled?: boolean
  }>
}

const PRIORITY_ORDER: Record<GovernanceActionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

function severityToPriority(severity: string): GovernanceActionPriority {
  switch (severity.toUpperCase()) {
    case 'HIGH':
      return 'high'
    case 'MEDIUM':
      return 'medium'
    case 'LOW':
      return 'low'
    default:
      return 'medium'
  }
}

function replayPriority(status: string): GovernanceActionPriority {
  if (status === 'FAILED') return 'critical'
  if (status === 'PENDING' || status === 'RUNNING') return 'high'
  return 'medium'
}

export function sortGovernanceActionQueue(items: GovernanceActionQueueItem[]): GovernanceActionQueueItem[] {
  return [...items].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
}

export function buildGovernanceActionQueue(
  queue: GovernanceOperationsQueueResponse | null,
  options?: { readOnly?: boolean; canApprove?: boolean; canRelease?: boolean; canReplay?: boolean },
): GovernanceActionQueueItem[] {
  if (!queue) return []

  const readOnly = options?.readOnly ?? false
  const items: GovernanceActionQueueItem[] = []

  for (const row of queue.action_required) {
    const priority = row.priority === 'critical' || row.priority === 'high' || row.priority === 'medium'
      ? row.priority
      : 'medium'
    items.push({
      id: `attention-${row.category}-${row.priority}`,
      priority,
      category: row.category,
      title: row.label,
      subtitle: row.recommended_action,
      ctas: [
        {
          label: 'View details',
          to: NAV_PATH.governanceOperations,
          testId: `gov-queue-view-${row.category}`,
        },
      ],
    })
  }

  for (const row of queue.pending_approvals) {
    items.push({
      id: `approval-${row.policy_id}`,
      priority: 'medium',
      category: 'approval',
      title: row.policy_name,
      subtitle: row.requester ? `Requested by ${row.requester}` : 'Awaiting review',
      ctas: [
        {
          label: 'Acknowledge',
          to: `${NAV_PATH.governanceApprovals}?policy=${row.policy_id}`,
          testId: `gov-queue-ack-${row.policy_id}`,
          disabled: readOnly || options?.canApprove === false,
        },
        {
          label: 'View details',
          to: `${NAV_PATH.governanceApprovals}?policy=${row.policy_id}`,
          testId: `gov-queue-approval-detail-${row.policy_id}`,
        },
      ],
    })
  }

  for (const row of queue.violations) {
    items.push({
      id: `violation-${row.violation_id}`,
      priority: severityToPriority(row.severity),
      category: 'violation',
      title: row.policy_name ?? 'Policy violation',
      subtitle: `${row.stream_name ?? '—'} · ${row.severity} · ${row.status}`,
      ctas: [
        {
          label: 'Resolve',
          to: `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(row.violation_id)}`,
          testId: `gov-queue-resolve-${row.violation_id}`,
        },
        {
          label: 'View details',
          to: `${NAV_PATH.governanceViolations}?id=${encodeURIComponent(row.violation_id)}`,
          testId: `gov-queue-violation-detail-${row.violation_id}`,
        },
      ],
    })
  }

  for (const row of queue.quarantine) {
    items.push({
      id: `quarantine-${row.quarantine_id}`,
      priority: 'high',
      category: 'quarantine',
      title: row.stream_name ?? 'Quarantined event',
      subtitle: row.quarantine_reason ?? row.status,
      ctas: [
        {
          label: 'Release',
          to: `${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(row.quarantine_id))}`,
          testId: `gov-queue-release-${row.quarantine_id}`,
          disabled: readOnly || options?.canRelease === false,
        },
        {
          label: 'Replay',
          to: NAV_PATH.governanceReplay,
          testId: `gov-queue-replay-${row.quarantine_id}`,
          disabled: readOnly || options?.canReplay === false,
        },
        {
          label: 'View details',
          to: `${NAV_PATH.governanceQuarantine}?id=${encodeURIComponent(String(row.quarantine_id))}`,
          testId: `gov-queue-quarantine-detail-${row.quarantine_id}`,
        },
      ],
    })
  }

  for (const row of queue.replays) {
    items.push({
      id: `replay-${row.replay_id}`,
      priority: replayPriority(row.status),
      category: 'replay',
      title: row.stream_name ?? 'Replay job',
      subtitle: `${row.status}${row.outcome ? ` · ${row.outcome}` : ''}`,
      ctas: [
        {
          label: 'Replay',
          to: `${NAV_PATH.governanceReplay}?id=${row.replay_id}`,
          testId: `gov-queue-replay-exec-${row.replay_id}`,
          disabled: readOnly || options?.canReplay === false,
        },
        {
          label: 'View details',
          to: `${NAV_PATH.governanceReplay}?id=${row.replay_id}`,
          testId: `gov-queue-replay-detail-${row.replay_id}`,
        },
      ],
    })
  }

  for (const row of queue.notifications) {
    items.push({
      id: `notification-${row.notification_id}`,
      priority: row.severity.toUpperCase() === 'HIGH' ? 'high' : 'medium',
      category: 'notification',
      title: row.event_type.replace(/_/g, ' '),
      subtitle: `${row.severity} · ${row.status}`,
      ctas: [
        {
          label: 'Acknowledge',
          to: NAV_PATH.governanceNotifications,
          testId: `gov-queue-notify-ack-${row.notification_id}`,
        },
        {
          label: 'View details',
          to: NAV_PATH.governanceNotifications,
          testId: `gov-queue-notify-detail-${row.notification_id}`,
        },
      ],
    })
  }

  return sortGovernanceActionQueue(items)
}

export function priorityBadgeClass(priority: GovernanceActionPriority): string {
  switch (priority) {
    case 'critical':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    case 'high':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200'
    case 'medium':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
  }
}
