import { Link } from 'react-router-dom'
import { destinationDetailPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  buildDestinationRouteMetrics,
  formatFlowEps,
  formatFlowSuccessRate,
  type RouteEvidenceState,
} from './routes-flow-helpers'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { RouteConsoleRow } from './routes-overview-helpers'

export type RoutesDestinationMetricsPanelProps = {
  snapshot: OperationalSnapshotResponse | null
  consoleRows: readonly RouteConsoleRow[]
  evidenceState?: RouteEvidenceState
}

export function RoutesDestinationMetricsPanel({ snapshot, consoleRows, evidenceState = 'current' }: RoutesDestinationMetricsPanelProps) {
  const rows = buildDestinationRouteMetrics(snapshot, consoleRows)

  return (
    <section
      aria-label="Route metrics by destination"
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="border-b border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Route Metrics by Destination</h3>
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
          {evidenceState === 'current' ? 'Aggregated delivery across connected routes'
            : evidenceState === 'stale' ? 'Last reported destination metrics · current delivery unverified'
              : 'Destination metrics unavailable · no verified runtime snapshot'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Destination</th>
              <th className={opTh}>Routes</th>
              <th className={opTh}>Throughput</th>
              <th className={opTh}>Success Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className={opTr}>
                <td className={cn(opTd, 'py-6 text-center text-[12px] text-slate-500')} colSpan={4}>
                  {evidenceState === 'unavailable' ? 'Destination delivery not verified · runtime snapshot unavailable.'
                    : evidenceState === 'stale' ? 'No activity in last reported snapshot · current delivery unverified.'
                      : 'No destination delivery activity yet.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.destinationId} className={opTr}>
                  <td className={opTd}>
                    <Link
                      to={destinationDetailPath(String(row.destinationId))}
                      className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {row.destinationName}
                    </Link>
                  </td>
                  <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold')}>{row.connectedRoutes}</td>
                  <td className={cn(opTd, 'tabular-nums text-[11px] font-semibold')}>
                    {formatFlowEps(row.throughputEps)}
                  </td>
                  <td className={cn(opTd, 'tabular-nums text-[11px]')}>{formatFlowSuccessRate(row.successRatePct)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
