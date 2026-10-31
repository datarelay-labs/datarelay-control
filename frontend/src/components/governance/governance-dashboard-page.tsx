import {
  AlertTriangle,
  Bell,
  ChevronRight,
  ClipboardCheck,
  FileSearch,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchGovernanceDashboardSummary,
  type GovernanceDashboardSummaryResponse,
} from '../../api/gdcGovernanceDashboard'
import {
  fetchGovernanceViolations,
  type GovernanceViolationEntry,
  type ViolationWindow,
} from '../../api/gdcGovernanceViolations'
import { clearOperationalSnapshotCache, getOperationalSnapshot } from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { buttonClassName } from '../ui/button-classes'
import { MetricTile } from '../ui/metric-tile'
import { SectionHeader } from '../ui/section-header'
import { StatusChip, type StatusChipStatus } from '../ui/status-chip'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'
import { formatPlatformRelative } from '../../lib/platform-timestamps'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  deriveGovernancePosture,
  GovernanceDashboardPostureOverview,
} from './governance-dashboard-posture-overview'
import { PagePurposeHeader, type PageHelpContent } from '../ui/page-purpose-header'

const governanceCardClass = 'rounded-lg border border-default bg-surface-card px-4 py-3'

const WINDOW_OPTIONS: ViolationWindow[] = ['24h', '7d', '30d']

const GOVERNANCE_HELP: PageHelpContent = {
  docsHref: '/help/governance',
  title: 'Governance Dashboard',
  intro:
    'Use this page to answer two questions first: Is governance healthy, and what needs attention now? Configuration belongs to the owning Stream or Route context; this dashboard is for operations and investigation.',
  sections: [
    {
      title: 'What to look at first',
      bullets: [
        'Overall posture tells you whether there is an active governance problem.',
        'Prioritized next steps points to the highest-value action.',
        'Recent open violations gives you concrete investigation targets.',
      ],
    },
    {
      title: 'Typical workflow',
      bullets: [
        'Check posture and the highest-priority open count.',
        'Open the linked violation, quarantine, or approval workspace.',
        'Investigate the affected Stream / Route context.',
        'Take the corrective action in the owning workspace.',
        'Return here to verify the operational state changed.',
      ],
    },
    {
      title: 'Where configuration happens',
      body:
        'Governance intent is owned by Stream defaults and destination-specific Route Processing. This dashboard intentionally does not create or edit policy configuration.',
    },
    {
      title: 'Key concepts',
      bullets: [
        'Violation: observed data or delivery behavior that conflicts with governance intent.',
        'Quarantine: events held for review instead of normal delivery.',
        'Approval: a pending governance decision that requires an authorized operator.',
        'Audit / Replay: evidence and recovery paths after an investigation.',
      ],
    },
  ],
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  return value.toLocaleString('en-US')
}

function formatRelativeTime(iso: string): string {
  return formatPlatformRelative(iso)
}

function severityChipStatus(severity: string): StatusChipStatus {
  const s = severity.toUpperCase()
  if (s === 'CRITICAL' || s === 'HIGH') return 'critical'
  if (s === 'MEDIUM') return 'warning'
  return 'neutral'
}

function severityDisplayLabel(severity: string): string {
  const s = severity.toUpperCase()
  if (s === 'HIGH') return 'High'
  if (s === 'MEDIUM') return 'Medium'
  if (s === 'LOW') return 'Low'
  if (s === 'CRITICAL') return 'Critical'
  return severity
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
  testId,
}: {
  count: number | null
  title: string
  description: string
  testId: string
}) {
  return (
    <MetricTile
      data-testid={testId}
      label={title}
      value={count == null ? null : formatCount(count)}
      unknownLabel="—"
      caption={count == null ? 'Data unavailable' : description}
    />
  )
}

export function GovernanceDashboardPage() {
  const [summary, setSummary] = useState<GovernanceDashboardSummaryResponse | null>(null)
  const [violations, setViolations] = useState<GovernanceViolationEntry[]>([])
  const [operationalIssues, setOperationalIssues] = useState<{
    noDataStreams: number | null
    lowVolumeStreams: number | null
    schemaDriftCount: number | null
    destinationCapacityWarnings: number | null
  }>({
    noDataStreams: null,
    lowVolumeStreams: null,
    schemaDriftCount: null,
    destinationCapacityWarnings: null,
  })
  const [window, setWindow] = useState<ViolationWindow>('24h')
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)

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
      const violationsResp = await fetchGovernanceViolations({ window, limit: 5, status: 'OPEN' })
      setViolations(violationsResp?.violations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load governance dashboard')
    } finally {
      setLoading(false)
    }
  }, [window])

  const loadOperationalIssues = useCallback(async () => {
    try {
      const snapshot = await getOperationalSnapshot()
      setOperationalIssues(deriveGovernanceOperationalIssues(snapshot, null))
    } catch {
      setOperationalIssues(deriveGovernanceOperationalIssues(null, null))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    clearOperationalSnapshotCache()
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
    {
      title: 'Audit Trail',
      description: 'Review governance decisions and evidence',
      to: NAV_PATH.governanceAudit,
      icon: FileSearch,
      testId: 'gov-quick-audit',
    },
  ] as const

  const notificationCount = summary?.notification_failures ?? 0
  const posture = deriveGovernancePosture(summary)

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-4" data-testid="governance-dashboard-page">
      <PagePurposeHeader
        title="Governance Dashboard"
        purpose="Is governance healthy, and what needs attention now? Start with posture and the highest-priority next step, then investigate the affected Stream or Route context."
        help={GOVERNANCE_HELP}
        actions={
          <>
            <Link
              to={NAV_PATH.governanceNotifications}
              className={buttonClassName({ variant: 'secondary', className: 'relative w-9 px-0' })}
              aria-label="Governance notifications"
              data-testid="gov-dashboard-notifications"
            >
              <Bell className="h-4 w-4" />
              {notificationCount > 0 ? (
                <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-status-critical-border bg-status-critical-subtle px-1 text-caption font-semibold text-status-critical">
                  {notificationCount > 9 ? '9+' : notificationCount}
                </span>
              ) : null}
            </Link>
            <label className="inline-flex h-control-md items-center gap-1.5 rounded-md border border-default bg-surface-card px-2.5 text-body">
              <span className="sr-only">Time window</span>
              <select
                value={window}
                onChange={(e) => setWindow(e.target.value as ViolationWindow)}
                className="cursor-pointer bg-transparent text-fg outline-none"
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
              className={buttonClassName({ variant: 'secondary', className: 'w-9 px-0' })}
              aria-label="Refresh governance dashboard"
            >
              {loading || summaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </>
        }
      />

      {error ? (
        <p
          className="rounded-lg border border-status-critical-border bg-status-critical-subtle px-3 py-2 text-body text-status-critical"
          data-testid="governance-dashboard-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {summaryError ? (
        <p
          className="rounded-lg border border-status-warning-border bg-status-warning-subtle px-3 py-2 text-body text-status-warning"
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
          <SectionHeader
            title="Prioritized investigation path"
            description={`Posture is ${posture}. Start with the highest-priority open count, then open the linked workspace.`}
          />
          <ul className="mt-3 space-y-2">
            {recommendedActions.map((action) => {
              const toneClass =
                action.count <= 0
                  ? 'bg-surface-section text-fg-muted'
                  : action.tone === 'red'
                    ? 'bg-status-critical-subtle text-status-critical'
                    : action.tone === 'orange'
                      ? 'bg-status-warning-subtle text-status-warning'
                      : 'bg-status-info-subtle text-status-info'
              return (
                <li key={action.testId}>
                  <Link
                    to={action.to}
                    data-testid={action.testId}
                    className="group flex items-center gap-3 rounded-lg border border-default bg-surface-section px-3 py-2.5 transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
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
                    <span className="min-w-0 flex-1 text-body text-fg">{action.label}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted transition group-hover:text-fg" />
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
          <SectionHeader
            className="mb-3"
            title="Recent open violations"
            actions={
              <Link
                to={NAV_PATH.governanceViolations}
                className="text-body-sm font-semibold text-fg underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                View all
              </Link>
            }
          />
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
                      <td className={cn(opTd, 'font-medium text-fg')}>{violationTitle(v)}</td>
                      <td className={opTd}>{v.policy_name}</td>
                      <td className={opTd}>
                        <StatusChip status={severityChipStatus(v.severity)}>{severityDisplayLabel(v.severity)}</StatusChip>
                      </td>
                      <td className={cn(opTd, 'whitespace-nowrap text-fg-muted')}>
                        {formatRelativeTime(v.event_time)}
                      </td>
                      <td className={opTd}>
                        <Link
                          to={`${NAV_PATH.governanceViolations}?id=${encodeURIComponent(v.id)}`}
                          className={buttonClassName({ variant: 'secondary', size: 'sm' })}
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

      <section aria-label="Secondary governance evidence" className="space-y-4 border-t border-default pt-4">
        <SectionHeader
          title="Operational signals and investigation shortcuts"
          description="Supporting runtime evidence stays below the primary posture and investigation path. Use the shortcuts only when you need to investigate or act."
        />

        <section aria-label="What happened summary" data-testid="governance-what-happened">
          <SectionHeader
            as="h3"
            className="mb-2"
            title="Operational signals"
            description="Runtime health enrichment for streams and destinations — separate from policy violation counts above."
          />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <OperationalSignalCard
              count={operationalIssues.noDataStreams}
              title="No Data Streams"
              description="Streams with no detected data in the enrichment window."
              testId="gov-issue-no-data"
            />
            <OperationalSignalCard
              count={operationalIssues.lowVolumeStreams}
              title="Low Volume Streams"
              description="Streams with observed transfer volume below the low-volume threshold."
              testId="gov-issue-low-volume"
            />
            <OperationalSignalCard
              count={operationalIssues.schemaDriftCount}
              title="Schema Drift Detected"
              description="Schema changes observed in runtime health enrichment."
              testId="gov-issue-schema-drift"
            />
            <OperationalSignalCard
              count={operationalIssues.destinationCapacityWarnings}
              title="Destination Warnings"
              description="Destination capacity or error warnings from runtime health."
              testId="gov-issue-destination-warnings"
            />
          </div>
        </section>

        <section className={governanceCardClass} data-testid="governance-quick-actions">
          <SectionHeader
            as="h3"
            title="Investigation shortcuts"
            description="Open the workspace that matches the issue you are investigating. Configuration stays with the owning Stream or Route."
          />
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {quickActions.map((action) => {
              const Icon = action.icon
              return (
                <li key={action.testId}>
                  <Link
                    to={action.to}
                    data-testid={action.testId}
                    className="group flex h-full items-center gap-3 rounded-lg border border-default px-3 py-2.5 transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <span className="inline-flex rounded-lg bg-surface-section p-2 text-fg-secondary" aria-hidden>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-label text-fg">{action.title}</span>
                      <span className="block text-body-sm text-fg-muted">{action.description}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-fg-muted transition group-hover:text-fg" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>

        <div
          className="flex flex-col gap-3 rounded-lg border border-default bg-surface-section px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="governance-advanced-entry"
          aria-label="Advanced governance context"
        >
          <div className="min-w-0">
            <p className="text-label text-fg">Advanced · Stream and Route governance</p>
            <p className="mt-1 text-body-sm text-fg-secondary">
              Read-only view of effective protection, classification and policy context. Edit settings in the owning Stream or Route.
            </p>
          </div>
          <Link
            to={NAV_PATH.governanceWorkspace}
            aria-label="Open advanced Governance Workspace"
            className={buttonClassName({ variant: 'secondary', className: 'gap-1.5 self-start sm:self-auto' })}
          >
            Open Governance Workspace
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
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
