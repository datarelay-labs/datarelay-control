import { Link } from 'react-router-dom'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { cn } from '../../../lib/utils'
import type { KpiCard } from '../../../api/dashboardKpi'

export type KpiSummaryWidgetProps = {
  cards: KpiCard[]
  loading?: boolean
}

export function KpiSummaryWidget({ cards, loading }: KpiSummaryWidgetProps) {
  return (
    <section
      aria-label="Operational KPI summary"
      aria-busy={loading}
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6',
        loading && 'opacity-80',
      )}
    >
      {cards.map((k) => (
        <Link
          key={k.label}
          to={k.linkTo}
          title={k.title}
          className={cn(
            'flex min-h-[6.25rem] flex-col rounded-lg border border-slate-200/70 bg-white/90 p-3 shadow-none transition-colors hover:border-violet-300/80 hover:bg-violet-500/[0.03] dark:border-gdc-border/90 dark:bg-gdc-card dark:hover:border-violet-500/30',
          )}
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{k.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums leading-none tracking-tight text-slate-900 dark:text-slate-50">
            {k.value}
          </p>
          <p className={cn('mt-auto pt-1 text-[11px] font-medium leading-snug', k.subClass)}>{k.sub}</p>
          {k.sparkline && k.sparkline.length > 1 ? (
            <div className="mt-1.5 h-10 w-full shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={k.sparkline.map((y, i) => ({ i, y }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                  <Line
                    type="monotone"
                    dataKey="y"
                    stroke="var(--gdc-chart-primary)"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </Link>
      ))}
    </section>
  )
}
