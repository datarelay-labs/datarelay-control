import { Activity, AlertTriangle, CheckCircle2, Gauge, Layers, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StreamsPageKpi } from '../../lib/stream-console-metrics'

type KpiCardProps = {
  label: string
  value: string
  sub?: string
  icon: typeof Activity
  iconClassName: string
  tone?: 'default' | 'success' | 'warning' | 'error'
}

function KpiCard({ label, value, sub, icon: Icon, iconClassName, tone = 'default' }: KpiCardProps) {
  const valueClass =
    tone === 'error'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warning'
        ? 'text-status-warning'
        : tone === 'success'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-slate-900 dark:text-slate-50'

  return (
    <div
      className="flex min-h-[6.5rem] flex-col rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid={`streams-kpi-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
          <p className={cn('mt-1 text-2xl font-bold tabular-nums tracking-tight', valueClass)}>{value}</p>
          {sub ? <p className="mt-0.5 text-[11px] font-medium text-slate-500 dark:text-gdc-muted">{sub}</p> : null}
        </div>
        <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', iconClassName)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </div>
  )
}

export function StreamsGroupKpiStrip({ kpi, loading }: { kpi: StreamsPageKpi; loading?: boolean }) {
  if (loading) {
    return (
      <section aria-label="Streams KPI summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-[6.5rem] animate-pulse rounded-xl bg-slate-200/70 dark:bg-gdc-elevated" aria-hidden />
        ))}
      </section>
    )
  }

  const totalSub =
    kpi.runningStreams > 0 ? `${kpi.runningStreams} with runtime data` : kpi.totalStreams > 0 ? 'No runtime data yet' : '—'

  return (
    <section aria-label="Streams KPI summary" data-testid="streams-group-kpi-strip" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        label="Total Streams"
        value={String(kpi.totalStreams)}
        sub={totalSub}
        icon={Layers}
        iconClassName="bg-violet-500/15 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400"
      />
      <KpiCard
        label="Healthy"
        value={String(kpi.healthyStreams)}
        sub={kpi.healthyStreamsPct}
        icon={CheckCircle2}
        tone={kpi.healthyStreams > 0 ? 'success' : 'default'}
        iconClassName="bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
      />
      <KpiCard
        label="Warning"
        value={String(kpi.warningStreams)}
        sub={kpi.warningStreamsPct}
        icon={AlertTriangle}
        tone={kpi.warningStreams > 0 ? 'warning' : 'default'}
        iconClassName="bg-status-warning-subtle text-status-warning"
      />
      <KpiCard
        label="Critical"
        value={String(kpi.criticalStreams)}
        sub={kpi.criticalStreamsPct}
        icon={XCircle}
        tone={kpi.criticalStreams > 0 ? 'error' : 'default'}
        iconClassName="bg-red-500/15 text-red-600 dark:bg-red-500/20 dark:text-red-400"
      />
      <KpiCard
        label="Total EPS"
        value={kpi.totalEpsLabel}
        icon={Gauge}
        iconClassName="bg-sky-500/15 text-sky-600 dark:bg-sky-500/20 dark:text-sky-400"
      />
      <KpiCard
        label="Total Issues"
        value={String(kpi.totalIssues)}
        sub={kpi.totalIssues > 0 ? 'Warning + Critical streams' : 'No active issues'}
        icon={Activity}
        tone={kpi.totalIssues > 0 ? 'error' : 'default'}
        iconClassName={
          kpi.totalIssues > 0
            ? 'bg-red-500/15 text-red-600 dark:bg-red-500/20 dark:text-red-400'
            : 'bg-slate-500/15 text-slate-600 dark:bg-slate-500/20 dark:text-slate-400'
        }
      />
    </section>
  )
}
