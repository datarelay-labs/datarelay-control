import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useLayoutEffect, useMemo, useState } from 'react'
import { loadDashboardRefreshMs, persistDashboardRefreshMs } from '../../localPreferences'
import { Link } from 'react-router-dom'
import { NAV_PATH, newStreamPath } from '../../config/nav-paths'
import { dashboardPriorityInvestigations } from './dashboard-priority-investigations'
import { cn } from '../../lib/utils'
import { useSessionCapabilities } from '../../lib/rbac'
import { DashboardFirstFlowSetup } from './dashboard-first-flow-setup'
import {
  deriveOperationalIssuesFromSnapshot,
  deriveOverallHealthFromSnapshot,
  deriveTrafficOverviewFromSnapshot,
  SNAPSHOT_KPI_BASIS_LABEL,
} from './dashboard-charter-metrics'
import {
  DashboardRunningBadge,
  DataModeBadge,
  OperationalIssuesPanel,
  OverallHealthHero,
  TrafficOverviewPanel,
} from './dashboard-visual-panels'
import { useDashboardOverviewData } from './use-dashboard-overview-data'
import { RuntimeFixtureModeBanner } from '../runtime/runtime-fixture-mode-banner'
import { PagePurposeHeader, type PageHelpContent } from '../ui/page-purpose-header'

const REFRESH_OPTIONS: { label: string; ms: number | null }[] = [
  { label: 'Off', ms: null },
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
]

function refreshLabel(ms: number | null): string {
  if (ms == null) return 'Refresh: Off'
  if (ms === 15_000) return 'Refresh: 15s'
  if (ms === 30_000) return 'Refresh: 30s'
  if (ms === 60_000) return 'Refresh: 1m'
  if (ms === 300_000) return 'Refresh: 5m'
  return `Refresh: ${ms / 1000}s`
}

const selectClass = cn(
  'appearance-none rounded-lg border border-slate-200/80 bg-white py-2 pl-3 pr-8 text-sm font-medium text-slate-700',
  'dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
)

const DASHBOARD_HELP: PageHelpContent = {
  docsHref: '/help/operations',
  title: 'Dashboard',
  intro: 'Start here to see whether DataRelay needs your attention. This page summarizes operational truth; use the linked workspaces to investigate or change configuration.',
  sections: [
    {
      title: 'What am I looking at?',
      bullets: [
        'Action needed prioritizes open operational signals from the current snapshot.',
        'Overall health summarizes Stream health without replacing Runtime diagnosis.',
        'Traffic summarizes recent ingest and delivery outcomes.',
      ],
    },
    {
      title: 'What should I do next?',
      body: 'Open the highest-priority action first. If no action is needed, continue monitoring or open Streams to inspect a specific data flow.',
    },
    {
      title: 'Where do I configure data delivery?',
      body: 'Create or edit Streams for collection, choose Destinations, then configure destination-specific Route Processing before deploy.',
    },
  ],
}

export function DashboardOverview() {
  const canConfigure = useSessionCapabilities().workspace_mutations === true
  const [refreshMs, setRefreshMs] = useState<number | null>(null)

  useLayoutEffect(() => {
    setRefreshMs(loadDashboardRefreshMs())
  }, [])

  // Snapshot-backed charter metrics do not change with analytics window; keep a stable default for the data hook.
  const { bundle, loading, loadError, reload } = useDashboardOverviewData('24h', refreshMs)
  const initialLoading = loading && bundle == null

  const overallHealth = useMemo(
    () => deriveOverallHealthFromSnapshot(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const traffic = useMemo(
    () => deriveTrafficOverviewFromSnapshot(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const operationalIssues = useMemo(
    () =>
      deriveOperationalIssuesFromSnapshot(
        bundle?.operationalSnapshot ?? null,
        bundle?.dashboard ?? null,
        bundle?.destinations ?? null,
      ),
    [bundle?.operationalSnapshot, bundle?.dashboard, bundle?.destinations],
  )

  const hasOperationalSnapshot = bundle?.operationalSnapshot != null
  const isFreshInstall = bundle?.operationalSnapshot?.global.total_streams === 0
  const runtimeHealthAttention = useMemo(() => {
    const snapshot = bundle?.operationalSnapshot
    if (!snapshot) return { routes: 0, destinations: 0 }
    const needsReview = (status: string) => status === 'DEGRADED' || status === 'ERROR'
    return {
      routes: (snapshot.routes ?? []).filter((route) => route.enabled && needsReview(route.health_status)).length,
      destinations: (snapshot.destinations ?? []).filter(
        (destination) => destination.enabled && needsReview(destination.health_status),
      ).length,
    }
  }, [bundle?.operationalSnapshot])
  const priorityInvestigations = useMemo(
    () => dashboardPriorityInvestigations(bundle?.operationalSnapshot ?? null),
    [bundle?.operationalSnapshot],
  )
  const attentionItems = useMemo(
    () =>
      [
        {
          count: overallHealth.warning + overallHealth.critical,
          label: 'Streams needing health review',
          to: NAV_PATH.streams,
        },
        { count: operationalIssues.noDataStreams, label: 'Streams with no data', to: NAV_PATH.streams + '?filter=no-data' },
        { count: operationalIssues.lowVolumeStreams, label: 'Low-volume streams', to: NAV_PATH.streams + '?filter=low-volume' },
        { count: runtimeHealthAttention.routes, label: 'Routes needing health review', to: NAV_PATH.routes },
        { count: runtimeHealthAttention.destinations, label: 'Destinations needing health review', to: NAV_PATH.destinations },
        { count: operationalIssues.schemaDriftCount, label: 'Schema changes to review', to: NAV_PATH.governance },
        { count: operationalIssues.destinationCapacityWarnings, label: 'Destination capacity warnings', to: NAV_PATH.destinations + '?filter=warning' },
      ].filter((item) => item.count != null && item.count > 0),
    [operationalIssues, overallHealth.warning, overallHealth.critical, runtimeHealthAttention],
  )
  const attentionDataPartial = Object.values(operationalIssues).some((value) => value == null)
  const hasAnyAttention = priorityInvestigations.length > 0 || attentionItems.length > 0
  const attentionUnknown = !hasAnyAttention && attentionDataPartial

  return (
    <div className="w-full min-w-0 space-y-5" data-testid="dashboard-overview">
      <PagePurposeHeader
        title="Dashboard"
        showTitle={false}
        purpose="What needs attention right now? Start with Action needed, then drill into the affected Stream, Destination, Logs, or Governance workspace."
        help={DASHBOARD_HELP}
        testId="dashboard-purpose-header"
        actions={
          <>
            <DataModeBadge isFixtureMode={bundle?.isFixtureMode ?? false} />
            {!isFreshInstall ? (
              <DashboardRunningBadge
                engineStatus={bundle?.dashboard?.runtime_engine_status}
                dashboardFailed={bundle?.dashboardFailed}
                posture={overallHealth.posture}
              />
            ) : null}
            <div className="relative">
              <label htmlFor="dashboard-refresh-select" className="sr-only">Auto refresh interval</label>
              <select
                id="dashboard-refresh-select"
                value={refreshMs === null ? 'off' : String(refreshMs)}
                onChange={(e) => {
                  const val = e.target.value === 'off' ? null : Number(e.target.value)
                  setRefreshMs(val)
                  persistDashboardRefreshMs(val)
                }}
                className={selectClass}
                title={refreshLabel(refreshMs)}
              >
                {REFRESH_OPTIONS.map((o) => (
                  <option key={o.label} value={o.ms === null ? 'off' : String(o.ms)}>
                    {o.ms === null ? 'Auto-refresh: Off' : `Auto-refresh: ${o.label}`}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            </div>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={initialLoading}
              className={cn(
                'inline-flex items-center justify-center rounded-lg border p-2.5 transition-colors',
                'border-slate-200/80 text-slate-600 hover:border-slate-300 hover:bg-slate-50',
                'disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:text-gdc-muted dark:hover:bg-gdc-section/60',
              )}
              title="Refresh data now"
              aria-label="Refresh dashboard data now"
            >
              <RefreshCw className={cn('h-4 w-4', initialLoading && 'animate-spin')} aria-hidden />
            </button>
          </>
        }
      />

      <RuntimeFixtureModeBanner surface="dashboard" />

      {loadError ? (
        <div
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100"
          role="alert"
          data-testid="dashboard-load-error"
        >
          {loadError}
        </div>
      ) : null}

      {initialLoading ? (
        <p className="text-sm text-slate-500 dark:text-gdc-muted" role="status" data-testid="dashboard-loading">
          Loading dashboard data…
        </p>
      ) : null}

      {initialLoading ? null : !hasOperationalSnapshot ? (
        <section
          className="rounded-2xl border border-amber-300 bg-amber-50 px-5 py-6 dark:border-amber-500/40 dark:bg-amber-500/10 sm:px-7"
          role="status"
          data-testid="dashboard-snapshot-unavailable"
        >
          <h2 className="text-lg font-semibold text-amber-950 dark:text-amber-100">Operational status unavailable</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-amber-900 dark:text-amber-200">
            The operational snapshot could not be loaded. Stream count, health and delivery status have not been verified.
            No configuration was changed.
          </p>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-100 disabled:opacity-60 dark:border-amber-500/40 dark:bg-gdc-card dark:text-amber-100"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry status
          </button>
        </section>
      ) : isFreshInstall ? (
        <DashboardFirstFlowSetup
          connectorCount={bundle?.connectorsKnown === true ? bundle.connectors.length : null}
          destinationCount={bundle?.destinations?.length ?? null}
          canConfigure={canConfigure}
        />
      ) : (
        <div className={cn('space-y-5', initialLoading && 'opacity-80')} data-testid="dashboard-first-level">
          <section
            className="overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-white to-violet-50/60 p-5 shadow-sm dark:border-gdc-border dark:from-gdc-card dark:via-gdc-card dark:to-gdc-panel sm:p-6"
            data-testid="dashboard-action-needed"
            aria-label="Action needed"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  hasAnyAttention || attentionUnknown
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                )}
                aria-hidden
              >
                {hasAnyAttention || attentionUnknown ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-violet-600 dark:text-violet-300">Live operations</p>
                <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  {hasAnyAttention ? 'Action needed' : attentionUnknown ? 'Status partially available' : 'No action needed'}
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-gdc-muted">
                  {hasAnyAttention
                    ? 'Start with an affected resource below. Its link opens the workspace that owns the next investigation.'
                    : attentionDataPartial
                      ? 'No actionable signal is currently known from the available snapshot; some signal categories are unavailable.'
                      : 'No open operational signals are present in the current snapshot. Continue monitoring or inspect a Stream.'}
                </p>
              </div>
            </div>
            {priorityInvestigations.length > 0 ? (
              <section className="mt-4 space-y-3" data-testid="dashboard-priority-investigations" aria-label="Priority investigations">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Investigate these first</h3>
                  <span className="text-xs text-slate-500 dark:text-gdc-muted">Specific resources · current operational snapshot</span>
                </div>
                <ol className="grid gap-2 lg:grid-cols-3">
                  {priorityInvestigations.map((item) => (
                    <li key={item.key} className="min-w-0">
                      <Link
                        to={item.href}
                        data-testid={`dashboard-investigation-${item.key}`}
                        className="group flex min-h-24 flex-col justify-between gap-2 rounded-xl border border-slate-200/90 bg-white px-3.5 py-3 shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:hover:border-violet-500/40 dark:hover:bg-gdc-rowHover"
                      >
                        <div className="flex min-w-0 items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{item.kind}</p>
                            <p className="mt-0.5 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">{item.resource}</p>
                          </div>
                          <span className={cn(
                            'shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold',
                            item.severity === 'critical'
                              ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                              : 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
                          )}>{item.severity === 'critical' ? 'Critical' : 'Warning'}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs text-slate-600 dark:text-gdc-mutedStrong">
                          <span className="min-w-0 break-words">{item.reason}</span>
                          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-violet-700 dark:text-violet-300">
                            Investigate <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {attentionItems.length > 0 ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {attentionItems.map((item) => (
                  <Link
                    key={item.label}
                    to={item.to}
                    className="group flex items-center gap-2 rounded-lg border border-slate-200/80 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-rowHover"
                  >
                    <span className="font-semibold tabular-nums text-amber-600 dark:text-amber-300">{item.count}</span>
                    <span className="min-w-0 flex-1">{item.label}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-slate-600 dark:group-hover:text-slate-200" aria-hidden />
                  </Link>
                ))}
              </div>
            ) : null}
            <div className="mt-5 flex flex-col gap-4 rounded-xl bg-slate-900 px-4 py-4 text-white shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5 dark:bg-slate-950">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-violet-300">Recommended next step</p>
                <p className="mt-1 text-sm font-medium leading-relaxed text-slate-100" data-testid="dashboard-next-step-description">
                  {priorityInvestigations.length > 0
                    ? `Investigate ${priorityInvestigations[0].resource} — ${priorityInvestigations[0].reason.toLowerCase()}.`
                    : attentionItems.length > 0
                      ? `Investigate ${attentionItems[0].label.toLowerCase()}.`
                    : attentionDataPartial
                      ? 'Inspect your Streams while some operational signals are unavailable.'
                      : 'Explore Data Flows to review current collection and per-route delivery.'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Link
                  to={priorityInvestigations[0]?.href ?? attentionItems[0]?.to ?? (attentionDataPartial ? NAV_PATH.streams : NAV_PATH.routes)}
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
                  data-testid="dashboard-next-action"
                >
                  {hasAnyAttention ? 'Review issue' : attentionDataPartial ? 'Open Streams' : 'Open Data Flows'}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                {canConfigure ? (
                  <Link
                    to={newStreamPath()}
                    className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300"
                    data-testid="dashboard-create-stream"
                  >
                    New Stream
                  </Link>
                ) : null}
              </div>
            </div>
          </section>

          <OverallHealthHero health={overallHealth} basisLabel={SNAPSHOT_KPI_BASIS_LABEL} />

          <div className="grid gap-5 lg:grid-cols-2">
            <TrafficOverviewPanel traffic={traffic} />
            <OperationalIssuesPanel issues={operationalIssues} />
          </div>

          <nav
            aria-label="Dashboard drill-down"
            data-testid="dashboard-drilldown"
            className="flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-200/80 pt-4 text-sm dark:border-gdc-divider"
          >
            <Link
              to={NAV_PATH.routes}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-data-flows"
            >
              Data Flows
            </Link>
            <Link
              to={NAV_PATH.streams}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-streams"
            >
              Streams
            </Link>
            <Link
              to={NAV_PATH.streams + '?view=delivery-health'}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-delivery-health"
            >
              Delivery health
            </Link>
            <Link
              to={NAV_PATH.destinations}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-destinations"
            >
              Destinations
            </Link>
            <Link
              to={NAV_PATH.logs}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-logs"
            >
              Logs
            </Link>
            <Link
              to={NAV_PATH.governance}
              className="font-medium text-slate-700 underline-offset-2 hover:underline dark:text-slate-200"
              data-testid="dashboard-drilldown-governance"
            >
              Governance
            </Link>
          </nav>
        </div>
      )}
    </div>
  )
}
