/**
 * Calm Governance Dashboard posture — mirrors Destinations/Logs overview density.
 * Uses backend summary risk/health counts only; does not invent severity semantics.
 */

import { Link } from 'react-router-dom'
import type { GovernanceDashboardSummaryResponse } from '../../api/gdcGovernanceDashboard'
import { NAV_PATH } from '../../config/nav-paths'
import { MetricTile } from '../ui/metric-tile'
import { StatusChip, type StatusChipStatus } from '../ui/status-chip'

export type GovernancePosture = 'healthy' | 'warning' | 'critical' | 'unknown'

export function deriveGovernancePosture(summary: GovernanceDashboardSummaryResponse | null): GovernancePosture {
  // A missing or failed summary is not evidence of a healthy posture.
  if (!summary) return 'unknown'
  const { risk, policy_health: health } = summary
  if (risk.critical > 0 || health.critical > 0) return 'critical'
  if (risk.high > 0 || risk.medium > 0 || health.warning > 0) return 'warning'
  return 'healthy'
}

function postureLabel(posture: GovernancePosture): string {
  if (posture === 'critical') return 'Critical'
  if (posture === 'warning') return 'Warning'
  if (posture === 'unknown') return 'Not verified'
  return 'Healthy'
}

const POSTURE_CHIP_STATUS: Record<GovernancePosture, StatusChipStatus> = {
  healthy: 'healthy',
  warning: 'warning',
  critical: 'critical',
  unknown: 'unknown',
}

function postureDescription(summary: GovernanceDashboardSummaryResponse | null, posture: GovernancePosture): string {
  if (!summary) {
    return 'Policy posture summary is still loading or unavailable'
  }
  if (posture === 'critical') {
    const critical = summary.risk.critical
    return `${critical} critical violation${critical === 1 ? '' : 's'} need investigation`
  }
  if (posture === 'warning') {
    const open = summary.open_violations
    if (open > 0) {
      return `${open} open violation${open === 1 ? '' : 's'} · prioritize investigation targets below`
    }
    if (summary.pending_approvals > 0) {
      return `${summary.pending_approvals} pending approval${summary.pending_approvals === 1 ? '' : 's'} waiting for review`
    }
    return 'Policy health warnings detected — review recommended next steps'
  }
  if (summary.open_violations === 0 && summary.pending_approvals === 0) {
    return 'No open violations or pending approvals in the current summary'
  }
  return 'Policy posture is within normal bounds'
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

type CountProps = {
  label: string
  /** null means the summary is not available: rendered as unknown, never as 0. */
  value: string | null
  testId: string
  to: string
}

function CompactCount({ label, value, testId, to }: CountProps) {
  return (
    <Link
      to={to}
      className="block min-w-[5.5rem] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <MetricTile data-testid={testId} label={label} value={value} unknownLabel="—" />
    </Link>
  )
}

export function GovernanceDashboardPostureOverview({
  summary,
  loading,
}: {
  summary: GovernanceDashboardSummaryResponse | null
  loading?: boolean
}) {
  if (loading && !summary) {
    return (
      <div
        className="h-28 animate-pulse rounded-lg bg-surface-hover"
        aria-hidden
        data-testid="governance-posture-overview-loading"
      />
    )
  }

  const posture = deriveGovernancePosture(summary)
  const countOf = (pick: (s: GovernanceDashboardSummaryResponse) => number): string | null =>
    summary ? formatCount(pick(summary)) : null

  return (
    <section
      aria-label="Governance policy posture"
      data-testid="governance-posture-overview"
      className="rounded-lg border border-default bg-surface-card px-4 py-3"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-label text-fg-muted">Policy posture</p>
          <StatusChip status={POSTURE_CHIP_STATUS[posture]} size="md" data-testid="dashboard-kpi-overall-risk">
            {postureLabel(posture)}
          </StatusChip>
          <p className="text-body-sm text-fg-secondary" data-testid="governance-posture-summary">
            {postureDescription(summary, posture)}
          </p>
          <p className="text-caption text-fg-muted">
            Counts come from the governance summary API · open a target below to investigate
          </p>
        </div>

        <div className="flex flex-wrap gap-2" data-testid="dashboard-kpi-strip">
          <CompactCount
            label="Open"
            value={countOf((s) => s.open_violations)}
            testId="dashboard-kpi-violations"
            to={NAV_PATH.governanceViolations}
          />
          <CompactCount
            label="Critical"
            value={countOf((s) => s.risk.critical)}
            testId="dashboard-kpi-critical-violations"
            to={NAV_PATH.governanceViolations}
          />
          <CompactCount
            label="Quarantine"
            value={countOf((s) => s.quarantined_events)}
            testId="dashboard-kpi-quarantine"
            to={NAV_PATH.governanceQuarantine}
          />
          <CompactCount
            label="Approvals"
            value={countOf((s) => s.pending_approvals)}
            testId="dashboard-kpi-pending-approvals"
            to={NAV_PATH.governanceApprovals}
          />
        </div>
      </div>
    </section>
  )
}
