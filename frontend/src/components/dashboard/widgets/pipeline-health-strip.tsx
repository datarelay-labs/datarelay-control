import { Link } from 'react-router-dom'
import { NAV_PATH } from '../../../config/nav-paths'
import { cn } from '../../../lib/utils'
import { RuntimeChartCard } from '../../shell/runtime-chart-card'
import type { DashboardSummaryNumbers, HealthOverviewResponse } from '../../../api/types/gdcApi'

const SEG = {
  healthy: '#16a34a',
  warning: '#d97706',
  error: '#dc2626',
  inactive: 'var(--gdc-chart-muted)',
} as const

export type PipelineHealthStripProps = {
  health: HealthOverviewResponse | null
  summary: DashboardSummaryNumbers | null
  loading: boolean
}

export function PipelineHealthStrip({ health, summary, loading }: PipelineHealthStripProps) {
  const healthy = health?.streams.healthy ?? 0
  const warning = health?.streams.degraded ?? 0
  const error = (health?.streams.unhealthy ?? 0) + (health?.streams.critical ?? 0)
  const inactive =
    summary != null ? Math.max(0, summary.stopped_streams + summary.paused_streams) : 0
  const total = healthy + warning + error + inactive
  const score = health?.average_stream_score

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)

  return (
    <RuntimeChartCard
      className="w-full"
      title="Pipeline health"
      subtitle="Streams by live runtime health (recent posture + recovery). Inactive = stopped or paused in configuration."
      actions={
        <Link
          to={NAV_PATH.analytics}
          className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          Analytics
        </Link>
      }
    >
      <div
        className={cn(
          'flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between',
          loading && 'opacity-80',
        )}
        aria-busy={loading}
      >
        <div className="min-w-0 flex-1 space-y-2">
          {!health && !loading ? (
            <p className="text-[12px] text-slate-500 dark:text-gdc-muted">
              Health scoring is not available. Ensure runtime health API is deployed.
            </p>
          ) : null}
          <p className="text-[11px] leading-snug text-slate-600 dark:text-gdc-muted">
            Stream hierarchy (best → worst): <span className="font-semibold text-emerald-800 dark:text-emerald-300">Healthy</span>
            {' → '}
            <span className="font-semibold text-amber-800 dark:text-amber-300">Warning (degraded)</span>
            {' → '}
            <span className="font-semibold text-red-800 dark:text-red-300">Error / critical</span>
            {' → '}
            <span className="font-semibold text-slate-600 dark:text-slate-300">Inactive (paused/stopped)</span>.
          </p>
          {health ? (
            <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
              Routes scored: {health.routes.healthy + health.routes.degraded + health.routes.unhealthy + health.routes.critical} · Idle:{' '}
              {health.routes.idle ?? 0} · Disabled: {health.routes.disabled ?? 0} ·
              Destinations scored:{' '}
              {health.destinations.healthy +
                health.destinations.degraded +
                health.destinations.unhealthy +
                health.destinations.critical}
            </p>
          ) : null}
          <div className="flex h-8 w-full overflow-hidden rounded-md border border-slate-200/80 dark:border-gdc-divider">
            {total <= 0 ? (
              <div className="flex w-full items-center justify-center bg-slate-100 text-[11px] text-slate-500 dark:bg-gdc-elevated dark:text-gdc-muted">
                No stream health breakdown for this window
              </div>
            ) : (
              <>
                {healthy > 0 ? (
                  <div
                    className="flex items-center justify-center text-[10px] font-semibold text-white"
                    style={{ width: `${(healthy / total) * 100}%`, backgroundColor: SEG.healthy }}
                    title={`Healthy ${healthy}`}
                  >
                    {healthy > 0 && (healthy / total) * 100 > 12 ? healthy : ''}
                  </div>
                ) : null}
                {warning > 0 ? (
                  <div
                    className="flex items-center justify-center text-[10px] font-semibold text-white"
                    style={{ width: `${(warning / total) * 100}%`, backgroundColor: SEG.warning }}
                    title={`Warning ${warning}`}
                  >
                    {warning > 0 && (warning / total) * 100 > 12 ? warning : ''}
                  </div>
                ) : null}
                {error > 0 ? (
                  <div
                    className="flex items-center justify-center text-[10px] font-semibold text-white"
                    style={{ width: `${(error / total) * 100}%`, backgroundColor: SEG.error }}
                    title={`Error ${error}`}
                  >
                    {error > 0 && (error / total) * 100 > 12 ? error : ''}
                  </div>
                ) : null}
                {inactive > 0 ? (
                  <div
                    className="flex items-center justify-center text-[10px] font-semibold text-white"
                    style={{ width: `${(inactive / total) * 100}%`, backgroundColor: SEG.inactive }}
                    title={`Inactive ${inactive}`}
                  >
                    {inactive > 0 && (inactive / total) * 100 > 12 ? inactive : ''}
                  </div>
                ) : null}
              </>
            )}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-gdc-muted">
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SEG.healthy }} />
              Healthy {healthy} ({pct(healthy)}%)
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SEG.warning }} />
              Warning {warning} ({pct(warning)}%)
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SEG.error }} />
              Error {error} ({pct(error)}%)
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SEG.inactive }} />
              Inactive {inactive} ({pct(inactive)}%)
            </li>
          </ul>
        </div>

        <div className="flex shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-slate-200/80 bg-slate-50/80 px-5 py-3 dark:border-gdc-divider dark:bg-gdc-card">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Overall health score
          </p>
          {score != null ? (
            <>
              <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                {Math.round(score)}
                <span className="text-sm font-medium text-slate-400">/100</span>
              </p>
              <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Average stream score</p>
            </>
          ) : (
            <p className="text-[12px] font-medium text-slate-500 dark:text-gdc-muted">Not available</p>
          )}
        </div>
      </div>
    </RuntimeChartCard>
  )
}
