/**
 * Calm Governance Dashboard posture — mirrors Destinations/Logs overview density.
 * Uses backend summary risk/health counts only; does not invent severity semantics.
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { GovernanceDashboardSummaryResponse } from '../../api/gdcGovernanceDashboard'
import { NAV_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'

export type GovernancePosture = 'healthy' | 'warning' | 'critical'

export function deriveGovernancePosture(summary: GovernanceDashboardSummaryResponse | null): GovernancePosture {
  if (!summary) return 'healthy'
  const { risk, policy_health: health } = summary
  if (risk.critical > 0 || health.critical > 0) return 'critical'
  if (risk.high > 0 || risk.medium > 0 || health.warning > 0) return 'warning'
  return 'healthy'
}

function postureShellClass(posture: GovernancePosture): string {
  if (posture === 'critical') {
    return 'border-red-300/80 bg-red-50 dark:border-red-500/40 dark:bg-red-950/30'
  }
  if (posture === 'warning') {
    return 'border-amber-300/80 bg-amber-50 dark:border-amber-500/35 dark:bg-amber-950/25'
  }
  return 'border-emerald-300/80 bg-emerald-50 dark:border-emerald-500/35 dark:bg-emerald-950/25'
}

function postureLabel(posture: GovernancePosture): string {
  if (posture === 'critical') return 'Critical'
  if (posture === 'warning') return 'Warning'
  return 'Healthy'
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
  value: string
  testId: string
  emphasize?: 'warning' | 'critical' | 'success'
  to?: string
}

function CompactCount({ label, value, testId, emphasize, to }: CountProps) {
  const body = (
    <div
      data-testid={testId}
      className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 dark:border-gdc-border dark:bg-gdc-card/70"
    >
      <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
          emphasize === 'critical' && value !== '0' && 'text-red-600 dark:text-red-400',
          emphasize === 'warning' && value !== '0' && 'text-amber-600 dark:text-amber-400',
          emphasize === 'success' && value !== '0' && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
    </div>
  )
  if (to) {
    return (
      <Link to={to} className="block transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40">
        {body}
      </Link>
    )
  }
  return body
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
        className="h-28 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated"
        aria-hidden
        data-testid="governance-posture-overview-loading"
      />
    )
  }

  const posture = deriveGovernancePosture(summary)
  const Icon = posture === 'healthy' ? CheckCircle2 : posture === 'critical' ? XCircle : AlertTriangle
  const openViolations = summary?.open_violations ?? 0
  const criticalViolations = summary?.risk.critical ?? 0
  const quarantined = summary?.quarantined_events ?? 0
  const pendingApprovals = summary?.pending_approvals ?? 0

  return (
    <section
      aria-label="Governance policy posture"
      data-testid="governance-posture-overview"
      className={cn('rounded-xl border px-5 py-4 shadow-sm', postureShellClass(posture))}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              posture === 'healthy' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
              posture === 'warning' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              posture === 'critical' && 'bg-red-500/15 text-red-700 dark:text-red-300',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300">
              Policy posture
            </p>
            <p
              className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-50"
              data-testid="dashboard-kpi-overall-risk"
            >
              {postureLabel(posture)}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted" data-testid="governance-posture-summary">
              {postureDescription(summary, posture)}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
              Counts come from the governance summary API · open a target below to investigate
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" data-testid="dashboard-kpi-strip">
          <CompactCount
            label="Open"
            value={formatCount(openViolations)}
            testId="dashboard-kpi-violations"
            emphasize="warning"
            to={NAV_PATH.governanceViolations}
          />
          <CompactCount
            label="Critical"
            value={formatCount(criticalViolations)}
            testId="dashboard-kpi-critical-violations"
            emphasize="critical"
            to={NAV_PATH.governanceViolations}
          />
          <CompactCount
            label="Quarantine"
            value={formatCount(quarantined)}
            testId="dashboard-kpi-quarantine"
            to={NAV_PATH.governanceQuarantine}
          />
          <CompactCount
            label="Approvals"
            value={formatCount(pendingApprovals)}
            testId="dashboard-kpi-pending-approvals"
            emphasize="warning"
            to={NAV_PATH.governanceApprovals}
          />
        </div>
      </div>
    </section>
  )
}
