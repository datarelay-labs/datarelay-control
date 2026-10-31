import { Link } from 'react-router-dom'
import { routeEditPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { buildProblemRoutes, formatFlowEps, relativeShort, routePublicId, type RouteEvidenceState } from './routes-flow-helpers'
import type { RouteConsoleRow } from './routes-overview-helpers'

export type RoutesProblemRoutesPanelProps = {
  consoleRows: readonly RouteConsoleRow[]
  limit?: number
  evidenceState?: RouteEvidenceState
}

export function RoutesProblemRoutesPanel({ consoleRows, limit, evidenceState = 'current' }: RoutesProblemRoutesPanelProps) {
  const problems = buildProblemRoutes(consoleRows, limit)

  return (
    <section
      aria-label="Problem routes"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Problem Routes</h3>
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
          {evidenceState === 'current' ? 'Current health warnings and errors, plus recent delivery metric issues'
            : evidenceState === 'stale' ? 'Last reported Route conditions · snapshot stale or fetch failed'
              : 'Route conditions unavailable · no verified runtime snapshot'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Route</th>
              <th className={opTh}>Stream</th>
              <th className={opTh}>Destination</th>
              <th className={opTh}>Issue</th>
              <th className={opTh}>{evidenceState === 'stale' ? 'Throughput (last reported)' : 'Throughput'}</th>
              <th className={opTh}>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {problems.length === 0 ? (
              <tr className={opTr}>
                <td className={cn(opTd, 'py-6 text-center text-[12px] text-slate-500')} colSpan={6}>
                  {evidenceState === 'current' ? 'No problem routes in the current snapshot.'
                    : evidenceState === 'stale' ? 'No problems in the last reported snapshot · current state unverified.'
                      : 'Route issues not verified · runtime snapshot unavailable.'}
                </td>
              </tr>
            ) : (
              problems.map((p) => (
                <tr key={p.routeId} className={opTr}>
                  <td className={opTd}>
                    <Link
                      to={routeEditPath(String(p.routeId))}
                      className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {p.routeLabel !== routePublicId(p.routeId) ? p.routeLabel : routePublicId(p.routeId)}
                    </Link>
                  </td>
                  <td className={cn(opTd, 'text-[11px] text-slate-700 dark:text-gdc-mutedStrong')}>{p.streamName}</td>
                  <td className={cn(opTd, 'text-[11px] text-slate-700 dark:text-gdc-mutedStrong')}>{p.destinationName}</td>
                  <td className={opTd}>
                    <span
                      className={cn(
                        'inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                        p.issue === 'Error'
                          ? 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
                          : p.issue === 'Warning'
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100'
                            : 'border-slate-300/80 bg-slate-100 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong',
                      )}
                    >
                      {evidenceState === 'stale' ? `Last reported ${p.issue}` : p.issue}
                    </span>
                  </td>
                  <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold')}>{formatFlowEps(p.throughputEps)}</td>
                  <td className={cn(opTd, 'whitespace-nowrap text-[11px] text-slate-600 dark:text-gdc-muted')}>
                    {relativeShort(p.since)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
