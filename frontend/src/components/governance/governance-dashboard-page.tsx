import {
  AlertTriangle,
  Bell,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Edit2,
  FileSearch,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchGovernanceDashboardSummary,
  type GovernanceDashboardSummaryResponse,
} from '../../api/gdcGovernanceDashboard'
import { fetchGovernancePolicies, type GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import {
  fetchGovernanceViolations,
  type GovernanceViolationEntry,
  type ViolationWindow,
} from '../../api/gdcGovernanceViolations'
import { fetchHealthOverview } from '../../api/gdcRuntimeHealth'
import { NAV_PATH } from '../../config/nav-paths'
import { isOssReleaseMode } from '../../lib/feature-flags'
import { canEditPolicy } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'
import { formatPlatformRelative, formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { policyStatusBadgeClass, policyStatusLabel } from './policy-lifecycle'
import {
  deriveGovernancePosture,
  GovernanceDashboardPostureOverview,
} from './governance-dashboard-posture-overview'

const governanceCardClass = gdcUi.cardShell + ' px-4 py-3'

const WINDOW_OPTIONS: ViolationWindow[] = ['24h', '7d', '30d']

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function formatRelativeTime(iso: string): string {
  return formatPlatformRelative(iso)
}

function formatUpdatedAt(iso: string): string {
  return formatTimestampWithResolvedTimezone(iso)
}

function severityBadgeClass(severity: string): string {
  const s = severity.toUpperCase()
  if (s === 'CRITICAL' || s === 'HIGH') {
    return 'bg-red-500/15 text-red-700 ring-1 ring-red-500/30 dark:text-red-300'
  }
  if (s === 'MEDIUM') {
    return 'bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300'
  }
  return 'bg-sky-500/15 text-sky-800 ring-1 ring-sky-500/30 dark:text-sky-300'
}

function severityDisplayLabel(severity: string): string {
  const s = severity.toUpperCase()
  if (s === 'HIGH') return 'High'
  if (s === 'MEDIUM') return 'Medium'
  if (s === 'LOW') return 'Low'
  if (s === 'CRITICAL') return 'Critical'
  return severity
}

function policyTypeLabel(category: string): string {
  switch (category) {
    case 'DATA_PROTECTION':
      return 'Protection'
    case 'AI_GOVERNANCE':
      return 'Detection'
    case 'COMPLIANCE':
      return 'Prevention'
    case 'CUSTOM':
      return 'Classification'
    default:
      return category.replace(/_/g, ' ')
  }
}

function violationTitle(v: GovernanceViolationEntry): string {
  const stream = v.stream_name || 'Stream'
  const policy = v.policy_name || 'Policy'
  return `${policy} in ${stream}`
}

function OperationalSignalCard({
  count,
  title,
  description,
  tone,
  testId,
}: {
  count: number | null
  title: string
  description: string
  tone: 'sky' | 'amber' | 'violet' | 'orange'
  testId: string
}) {
  const toneClass = {
    sky: 'text-sky-600 dark:text-sky-400',
    amber: 'text-amber-600 dark:text-amber-400',
    violet: 'text-violet-600 dark:text-violet-400',
    orange: 'text-orange-600 dark:text-orange-400',
  }[tone]
  return (
    <div className={cn(governanceCardClass, 'flex min-h-[5.5rem] flex-col')} data-testid={testId}>
      <p className={cn('text-[1.5rem] font-bold tabular-nums leading-none', count == null ? 'text-slate-400' : toneClass)}>
        {count == null ? '—' : formatCount(count)}
      </p>
      <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
      <p className="mt-0.5 text-xs leading-snug text-slate-500 dark:text-gdc-muted">
        {count == null ? 'Data unavailable' : description}
      </p>
    </div>
  )
}

export function GovernanceDashboardPage() {
  const [summary, setSummary] = useState<GovernanceDashboardSummaryResponse | null>(null)
  const [violations, setViolations] = useState<GovernanceViolationEntry[]>([])
  const [policies, setPolicies] = useState<GovernancePolicyEntry[]>([])
  const [operationalIssues, setOperationalIssues] = useState<{
    noDataStreams: number
    lowVolumeStreams: number
    schemaDriftCount: number | null
    destinationCapacityWarnings: number
  }>({
    noDataStreams: 0,
    lowVolumeStreams: 0,
    schemaDriftCount: null,
    destinationCapacityWarnings: 0,
  })
  const [window, setWindow] = useState<ViolationWindow>('24h')
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const policiesLink = isOssReleaseMode() ? NAV_PATH.governanceApprovals : NAV_PATH.governanceDataProtection
  const canEdit = canEditPolicy()

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryError(null)
    try {
      const summaryResp = await fetchGovernanceDashboardSummary()
      setSummary(summaryResp)
    } catch (e) {
      setSummary(null)
      setSummaryError(e instanceof Error ? e.message : 'Failed to load governance dashboard summary')
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [violationsResp, policiesResp] = await Promise.all([
        fetchGovernanceViolations({ window, limit: 5, status: 'OPEN' }),
        fetchGovernancePolicies(),
      ])
      setViolations(violationsResp?.violations ?? [])
      setPolicies((policiesResp?.policies ?? []).slice(0, 5))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load governance dashboard')
    } finally {
      setLoading(false)
    }
  }, [window])

  const loadOperationalIssues = useCallback(async () => {
    try {
      const health = await fetchHealthOverview({ window: '24h' })
      setOperationalIssues(deriveGovernanceOperationalIssues(health, null, []))
    } catch {
      /* optional enrichment — ignore failures */
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([load(), loadSummary(), loadOperationalIssues()])
  }, [load, loadSummary, loadOperationalIssues])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadSummary()
    void loadOperationalIssues()
  }, [loadSummary, loadOperationalIssues])

  const recommendedActions = useMemo(() => {
    const critical = summary?.risk.critical ?? 0
    const pending = summary?.pending_approvals ?? 0
    const quarantined = summary?.quarantined_events ?? 0
    const schemaChanges = operationalIssues.schemaDriftCount
    const actions = [
      {
        label: `Review ${formatCount(critical)} critical violation${critical === 1 ? '' : 's'}`,
        to: NAV_PATH.governanceViolations,
        tone: 'red' as const,
        testId: 'gov-action-critical-violations',
        priority: critical > 0 ? 0 : 40,
        count: critical,
      },
      {
        label: `Process ${formatCount(pending)} pending approval${pending === 1 ? '' : 's'}`,
        to: NAV_PATH.governanceApprovals,
        tone: 'orange' as const,
        testId: 'gov-action-pending-approvals',
        priority: pending > 0 ? 1 : 41,
        count: pending,
      },
      {
        label: `Review ${formatCount(quarantined)} quarantined event${quarantined === 1 ? '' : 's'}`,
        to: NAV_PATH.governanceQuarantine,
        tone: 'blue' as const,
        testId: 'gov-action-quarantine',
        priority: quarantined > 0 ? 2 : 42,
        count: quarantined,
      },
      {
        label:
          schemaChanges != null
            ? `Check ${formatCount(schemaChanges)} schema change${schemaChanges === 1 ? '' : 's'}`
            : 'Schema change data unavailable',
        to: NAV_PATH.streams,
        tone: 'green' as const,
        testId: 'gov-action-schema-drift',
        priority: schemaChanges != null && schemaChanges > 0 ? 3 : 43,
        count: schemaChanges ?? 0,
      },
    ]
    return actions.sort((a, b) => a.priority - b.priority)
  }, [summary, operationalIssues.schemaDriftCount])

  const quickActions = [
    {
      title: 'Policy Builder',
      description: 'Create and manage policies',
      to: policiesLink,
      icon: Shield,
      testId: 'gov-quick-policy-builder',
    },
    {
      title: 'Violation Center',
      description: 'Review and triage violations',
      to: NAV_PATH.governanceViolations,
      icon: ShieldAlert,
      testId: 'gov-quick-violations',
    },
    {
      title: 'Quarantine Center',
      description: 'Manage quarantined events',
      to: NAV_PATH.governanceQuarantine,
      icon: Lock,
      testId: 'gov-quick-quarantine',
    },
    {
      title: 'Approval Center',
      description: 'Review pending approvals',
      to: NAV_PATH.governanceApprovals,
      icon: ClipboardCheck,
      testId: 'gov-quick-approvals',
    },
  ] as const

  const notificationCount = summary?.notification_failures ?? 0
  const posture = deriveGovernancePosture(summary)

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="governance-dashboard-page">
      <header className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Governance Overview
          </h1>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted">
            What needs attention, and where do I investigate? Scan policy posture, prioritize the next issue, then open
            Violations, Quarantine, or Approvals with context preserved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={NAV_PATH.governanceNotifications}
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/90 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-300 dark:hover:bg-gdc-rowHover"
            aria-label="Governance notifications"
            data-testid="gov-dashboard-notifications"
          >
            <Bell className="h-4 w-4" />
            {notificationCount > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                {notificationCount > 9 ? '9+' : notificationCount}
              </span>
            ) : null}
          </Link>
          <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-2.5 text-sm shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <span className="sr-only">Time window</span>
            <select
              value={window}
              onChange={(e) => setWindow(e.target.value as ViolationWindow)}
              className="cursor-pointer bg-transparent text-slate-700 outline-none dark:text-slate-200"
              data-testid="gov-dashboard-window"
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w === '24h' ? 'Last 24 Hours' : w === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loading || summaryLoading}
            data-testid="dashboard-refresh"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200/90 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-300 dark:hover:bg-gdc-rowHover"
            aria-label="Refresh governance dashboard"
          >
            {loading || summaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {error ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          data-testid="governance-dashboard-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {summaryError ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="governance-dashboard-summary-error"
          role="alert"
        >
          {summaryError}
        </p>
      ) : null}

      <GovernanceDashboardPostureOverview summary={summary} loading={summaryLoading} />

      <div className="grid gap-4 lg:grid-cols-12">
        <section
          className={cn(governanceCardClass, 'lg:col-span-5')}
          data-testid="governance-recommended-actions"
          aria-label="Prioritized next steps"
        >
          <div className="mb-1">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Next steps
            </p>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Prioritized investigation path</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
              Posture is {posture}. Start with the highest-priority open count, then open the linked workspace.
            </p>
          </div>
          <ul className="mt-3 space-y-2">
            {recommendedActions.map((action) => {
              const toneClass =
                action.tone === 'red'
                  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                  : action.tone === 'orange'
                    ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
                    : action.tone === 'blue'
                      ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              return (
                <li key={action.testId}>
                  <Link
                    to={action.to}
                    data-testid={action.testId}
                    className="group flex items-center gap-3 rounded-lg border border-slate-200/70 bg-slate-50/50 px-3 py-2.5 transition hover:border-slate-300 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-section/40 dark:hover:bg-gdc-card"
                  >
                    <span className={cn('inline-flex rounded-lg p-2', toneClass)} aria-hidden>
                      {action.tone === 'red' ? (
                        <AlertTriangle className="h-4 w-4" />
                      ) : action.tone === 'orange' ? (
                        <ClipboardCheck className="h-4 w-4" />
                      ) : action.tone === 'blue' ? (
                        <Lock className="h-4 w-4" />
                      ) : (
                        <FileSearch className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">{action.label}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-slate-600 dark:group-hover:text-slate-200" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>

        <section
          className={cn(governanceCardClass, 'lg:col-span-7')}
          data-testid="dashboard-recent-activity"
          aria-label="Recent violations"
        >
          <div className="mb-3 flex items-baseline justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Investigation targets
              </p>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent open violations</h2>
            </div>
            <Link
              to={NAV_PATH.governanceViolations}
              className="text-xs font-semibold text-slate-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-200"
            >
              View all
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className={opTable} data-testid="gov-recent-violations-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh} scope="col">
                    Violation
                  </th>
                  <th className={opTh} scope="col">
                    Policy
                  </th>
                  <th className={opTh} scope="col">
                    Severity
                  </th>
                  <th className={opTh} scope="col">
                    Time
                  </th>
                  <th className={opTh} scope="col">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {violations.length === 0 && !loading ? (
                  <tr className={opTr}>
                    <td className={opTd} colSpan={5}>
                      No recent open violations in this window.
                    </td>
                  </tr>
                ) : (
                  violations.map((v) => (
                    <tr key={v.id} className={opTr} data-testid={`gov-violation-row-${v.id}`}>
                      <td className={cn(opTd, 'font-medium text-slate-900 dark:text-slate-100')}>{violationTitle(v)}</td>
                      <td className={opTd}>{v.policy_name}</td>
                      <td className={opTd}>
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', severityBadgeClass(v.severity))}>
                          {severityDisplayLabel(v.severity)}
                        </span>
                      </td>
                      <td className={cn(opTd, 'whitespace-nowrap text-slate-500 dark:text-gdc-muted')}>
                        {formatRelativeTime(v.event_time)}
                      </td>
                      <td className={opTd}>
                        <Link
                          to={`${NAV_PATH.governanceViolations}?id=${encodeURIComponent(v.id)}`}
                          className="inline-flex rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-card"
                          data-testid={`gov-investigate-${v.id}`}
                        >
                          Investigate
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section aria-label="Secondary governance evidence" className="space-y-4 border-t border-slate-200/70 pt-4 dark:border-gdc-divider">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Evidence</p>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Operational signals, policies, and links</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">
            Supporting detail stays available after posture and investigation targets — not removed for cosmetic simplicity.
          </p>
        </div>

        <section aria-label="What happened summary" data-testid="governance-what-happened">
          <div className="mb-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Operational signals</h3>
            <p className="text-xs text-slate-500 dark:text-gdc-muted">
              Runtime health enrichment for streams and destinations — separate from policy violation counts above.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <OperationalSignalCard
              count={operationalIssues.noDataStreams}
              title="No Data Streams"
              description="Streams with no detected data in the enrichment window."
              tone="sky"
              testId="gov-issue-no-data"
            />
            <OperationalSignalCard
              count={operationalIssues.lowVolumeStreams}
              title="Low Volume Streams"
              description="Streams below their usual transfer volume."
              tone="amber"
              testId="gov-issue-low-volume"
            />
            <OperationalSignalCard
              count={operationalIssues.schemaDriftCount}
              title="Schema Drift Detected"
              description="Schema changes observed in runtime health enrichment."
              tone="violet"
              testId="gov-issue-schema-drift"
            />
            <OperationalSignalCard
              count={operationalIssues.destinationCapacityWarnings}
              title="Destination Warnings"
              description="Destination capacity or error warnings from runtime health."
              tone="orange"
              testId="gov-issue-destination-warnings"
            />
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-12">
          <section className={cn(governanceCardClass, 'lg:col-span-8')} data-testid="dashboard-policy-health" aria-label="Policy list">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Policy list</h3>
                <p className="text-xs text-slate-500 dark:text-gdc-muted">Recent policies for quick navigation into the catalog.</p>
              </div>
              {canEdit ? (
                <Link
                  to={policiesLink}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100"
                  data-testid="gov-new-policy"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Policy
                </Link>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <table className={opTable} data-testid="gov-policy-list-table">
                <thead>
                  <tr className={opThRow}>
                    <th className={opTh} scope="col">
                      Policy Name
                    </th>
                    <th className={opTh} scope="col">
                      Type
                    </th>
                    <th className={opTh} scope="col">
                      Applies To
                    </th>
                    <th className={opTh} scope="col">
                      Status
                    </th>
                    <th className={opTh} scope="col">
                      Last Updated
                    </th>
                    <th className={opTh} scope="col">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {policies.length === 0 && !loading ? (
                    <tr className={opTr}>
                      <td className={opTd} colSpan={6}>
                        No policies configured yet.
                      </td>
                    </tr>
                  ) : (
                    policies.map((policy) => (
                      <tr key={policy.id} className={opTr} data-testid={`gov-policy-row-${policy.id}`}>
                        <td className={cn(opTd, 'font-semibold text-slate-900 dark:text-slate-100')}>{policy.name}</td>
                        <td className={opTd}>{policyTypeLabel(policy.category)}</td>
                        <td className={opTd}>
                          {policy.assigned_stream_count} Stream{policy.assigned_stream_count === 1 ? '' : 's'}
                        </td>
                        <td className={opTd}>
                          <span
                            className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', policyStatusBadgeClass(policy.status))}
                          >
                            {policyStatusLabel(policy.status)}
                          </span>
                        </td>
                        <td className={cn(opTd, 'whitespace-nowrap text-slate-500 dark:text-gdc-muted')}>
                          {formatUpdatedAt(policy.updated_at)}
                        </td>
                        <td className={opTd}>
                          <div className="flex items-center gap-1">
                            <Link
                              to={policiesLink}
                              className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                              aria-label={`Edit ${policy.name}`}
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </Link>
                            <button
                              type="button"
                              className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                              aria-label={`Copy ${policy.name}`}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              className="inline-flex rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:hover:bg-gdc-rowHover dark:hover:text-slate-200"
                              aria-label={`More actions for ${policy.name}`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 border-t border-slate-200/70 pt-2 dark:border-gdc-border">
              <Link
                to={policiesLink}
                className="text-xs font-semibold text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              >
                View all policies →
              </Link>
            </div>
          </section>

          <section className={cn(governanceCardClass, 'lg:col-span-4')} data-testid="governance-quick-actions">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Quick links</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-gdc-muted">Jump to existing governance workspaces.</p>
            <ul className="mt-3 space-y-2">
              {quickActions.map((action) => {
                const Icon = action.icon
                return (
                  <li key={action.testId}>
                    <Link
                      to={action.to}
                      data-testid={action.testId}
                      className="group flex items-center gap-3 rounded-lg border border-slate-200/70 px-3 py-2.5 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
                    >
                      <span className="inline-flex rounded-lg bg-slate-100 p-2 text-slate-600 dark:bg-gdc-section dark:text-slate-300" aria-hidden>
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{action.title}</span>
                        <span className="block text-xs text-slate-500 dark:text-gdc-muted">{action.description}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-slate-600" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      </section>

      <div className="hidden" aria-hidden data-testid="dashboard-risk-overview">
        {summary ? `${summary.risk.critical}-${summary.risk.high}` : '0-0'}
      </div>
      <div className="hidden" aria-hidden data-testid="dashboard-compliance-snapshot">
        {summary ? `${summary.compliance_snapshot.violations_24h}` : '0'}
      </div>
    </div>
  )
}
