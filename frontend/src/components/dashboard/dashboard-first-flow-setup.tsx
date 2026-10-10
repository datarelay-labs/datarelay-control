import { ArrowRight, Cable, CheckCircle2, CircleHelp, GitBranch, Send } from 'lucide-react'
import { Link } from 'react-router-dom'
import { NAV_PATH, newStreamPath } from '../../config/nav-paths'

type ResourceStatus = { label: string; tone: string }

function resourceStatus(count: number | null): ResourceStatus {
  if (count === null) return { label: 'Not verified', tone: 'text-slate-600 dark:text-gdc-mutedStrong' }
  if (count === 0) return { label: 'Not configured', tone: 'text-amber-800 dark:text-amber-300' }
  return { label: `${count} registered`, tone: 'text-emerald-700 dark:text-emerald-300' }
}

const setupLinkClass =
  'inline-flex min-h-10 items-center gap-1.5 text-sm font-semibold text-violet-700 underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300'

export function DashboardFirstFlowSetup({
  connectorCount,
  destinationCount,
  canConfigure,
}: {
  /** Null means the catalog has not been verified; never silently treat it as empty. */
  connectorCount: number | null
  destinationCount: number | null
  canConfigure: boolean
}) {
  const source = resourceStatus(connectorCount)
  const destination = resourceStatus(destinationCount)
  const next = !canConfigure
    ? { to: NAV_PATH.routes, label: 'View Data Flows' }
    : connectorCount === null || connectorCount === 0
      ? { to: NAV_PATH.connectors, label: connectorCount === null ? 'Inspect Connectors' : 'Review Connectors first' }
      : destinationCount === null || destinationCount === 0
        ? { to: NAV_PATH.destinations, label: destinationCount === null ? 'Inspect Destinations' : 'Review Destinations first' }
        : { to: newStreamPath(), label: 'Start Stream setup' }

  return (
    <section
      className="overflow-hidden rounded-2xl border border-violet-200/80 bg-gradient-to-br from-violet-50 via-white to-white shadow-sm dark:border-gdc-border dark:from-gdc-section dark:via-gdc-card dark:to-gdc-card"
      data-testid="dashboard-empty-state"
      aria-labelledby="dashboard-first-flow-title"
    >
      <div className="border-b border-violet-100 px-5 py-6 dark:border-gdc-border sm:px-7 sm:py-7">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-violet-700 dark:text-violet-300">
          Welcome to Data Relay · First-run guide
        </p>
        <h2 id="dashboard-first-flow-title" className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
          Set up your first data flow
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">
          No Streams are configured yet. Review reusable source and destination connections first,
          then use the existing Stream Wizard to configure collection and each delivery Route.
        </p>
        {!canConfigure ? (
          <p className="mt-3 text-sm font-semibold text-amber-800 dark:text-amber-200" data-testid="dashboard-first-flow-read-only">
            Read-only access. Ask an operator or administrator to configure the data flow.
          </p>
        ) : null}
      </div>
      <ol className="grid gap-3 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-4" aria-label="First data flow setup steps">
        <li className="min-w-0 rounded-xl border border-slate-200/80 bg-white/95 p-4 dark:border-gdc-border dark:bg-gdc-panel">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
              <Cable className="h-4 w-4" aria-hidden /> 01 · Source
            </span>
            <span data-testid="dashboard-first-flow-source-state" className={`text-xs font-semibold ${source.tone}`}>
              {source.label}
            </span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">Review Connectors</h3>
          <p className="mt-1 min-h-12 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            Register source access. A saved Connector is not proof the source can be read.
          </p>
          <Link to={NAV_PATH.connectors} className={setupLinkClass}>Review Connectors <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </li>
        <li className="min-w-0 rounded-xl border border-slate-200/80 bg-white/95 p-4 dark:border-gdc-border dark:bg-gdc-panel">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
              <Send className="h-4 w-4" aria-hidden /> 02 · Destination
            </span>
            <span data-testid="dashboard-first-flow-destination-state" className={`text-xs font-semibold ${destination.tone}`}>
              {destination.label}
            </span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">Review Destinations</h3>
          <p className="mt-1 min-h-12 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            Register receivers ahead of setup. Saved endpoints have not yet proven delivery.
          </p>
          <Link to={NAV_PATH.destinations} className={setupLinkClass}>Review Destinations <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </li>
        <li className="min-w-0 rounded-xl border border-slate-200/80 bg-white/95 p-4 dark:border-gdc-border dark:bg-gdc-panel">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
              <GitBranch className="h-4 w-4" aria-hidden /> 03 · Configure
            </span>
            <span className="text-xs font-semibold text-slate-500 dark:text-gdc-muted">Not started</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">Stream and Routes</h3>
          <p className="mt-1 min-h-12 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            Sample your source, select Destinations, then configure each Route's processing.
          </p>
          <span className="inline-flex min-h-10 items-center text-xs font-medium text-slate-500 dark:text-gdc-muted">
            {canConfigure ? 'Use the guided Stream Wizard' : 'Configuration permission required'}
          </span>
        </li>
        <li className="min-w-0 rounded-xl border border-slate-200/80 bg-white/95 p-4 dark:border-gdc-border dark:bg-gdc-panel">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-violet-700 dark:text-violet-300">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> 04 · Verify
            </span>
            <span className="text-xs font-semibold text-slate-500 dark:text-gdc-muted">Not verified</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">Inspect Data Flows</h3>
          <p className="mt-1 min-h-12 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            After deployment, inspect Stream collection and Route delivery separately.
          </p>
          <Link to={NAV_PATH.routes} className={setupLinkClass}>View Data Flows <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </li>
      </ol>
      <div className="flex flex-col gap-3 border-t border-violet-100 bg-slate-50/70 px-5 py-4 dark:border-gdc-border dark:bg-gdc-panel/60 sm:flex-row sm:items-center sm:justify-between sm:px-7">
        <p className="flex max-w-2xl items-start gap-2 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
          <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Registered resources do not prove that data is flowing. Verify actual collection and each Route's delivery after deployment.
        </p>
        <Link
          to={next.to}
          data-testid="dashboard-first-flow-next"
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-gdc-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
        >
          {next.label}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  )
}
