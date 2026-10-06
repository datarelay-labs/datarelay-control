import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { useLayoutEffect, useMemo, useState } from 'react'
import { loadDashboardRefreshMs, persistDashboardRefreshMs } from '../../localPreferences'
import { Link } from 'react-router-dom'
import { NAV_PATH, newStreamPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
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

  const totalStreams = bundle?.operationalSnapshot?.global.total_streams ?? bundle?.streams.length ?? 0
  const isFreshInstall = !initialLoading && totalStreams === 0
  const attentionItems = useMemo(
    () =>
      [
        { count: operationalIssues.noDataStreams, label: 'Streams with no data', to: NAV_PATH.streams + '?filter=no-data' },
        { count: operationalIssues.lowVolumeStreams, label: 'Low-volume streams', to: NAV_PATH.streams + '?filter=low-volume' },
        { count: operationalIssues.schemaDriftCount, label: 'Schema changes to review', to: NAV_PATH.governance },
        { count: operationalIssues.destinationCapacityWarnings, label: 'Destination warnings', to: NAV_PATH.destinations + '?filter=warning' },
      ].filter((item) => item.count != null && item.count > 0),
    [operationalIssues],
  )
  const attentionDataPartial = Object.values(operationalIssues).some((value) => value == null)

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

      {isFreshInstall ? (
        <section
          className="rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
          data-testid="dashboard-empty-state"
        >
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Welcome to Data Relay</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-gdc-mutedStrong">
            No streams are configured yet. Create your first stream to start collecting, transforming, and delivering data.
          </p>
          <Link
            to={newStreamPath()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gdc-primary px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-700"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create First Stream
          </Link>
        </section>
      ) : (
        <div className={cn('space-y-5', initialLoading && 'opacity-80')} data-testid="dashboard-first-level">
          <section
            className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
            data-testid="dashboard-action-needed"
            aria-label="Action needed"
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  attentionItems.length > 0
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
                )}
                aria-hidden
              >
                {attentionItems.length > 0 ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {attentionItems.length > 0 ? 'Action needed' : 'No action needed'}
                </h2>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-gdc-muted">
                  {attentionItems.length > 0
                    ? 'Start with an open signal below; each link keeps you in the workspace that owns the next investigation step.'
                    : attentionDataPartial
                      ? 'No actionable signal is currently known from the available snapshot; some signal categories are unavailable.'
                      : 'No open operational signals are present in the current snapshot. Continue monitoring or inspect a Stream.'}
                </p>
              </div>
            </div>
            {attentionItems.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
