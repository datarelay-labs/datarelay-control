import { Activity, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StreamOperationsSummary } from '../../lib/streams-console-operations'

type SummaryCardProps = {
  label: string
  value: number
  icon: typeof Activity
  iconClassName: string
  testId: string
}

function SummaryCard({ label, value, icon: Icon, iconClassName, testId }: SummaryCardProps) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-[4.5rem] flex-col rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
        </div>
        <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg', iconClassName)}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </div>
  )
}

export function StreamsOperationsSummaryStrip({
  summary,
  loading,
}: {
  summary: StreamOperationsSummary
  loading?: boolean
}) {
  if (loading) {
    return (
      <section aria-label="Stream operations summary" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[4.5rem] animate-pulse rounded-xl bg-slate-200/70 dark:bg-gdc-elevated" aria-hidden />
        ))}
      </section>
    )
  }

  return (
    <section
      aria-label="Stream operations summary"
      data-testid="streams-operations-summary"
      className="grid grid-cols-2 gap-3 xl:grid-cols-4"
    >
      <SummaryCard
        label="Healthy Streams"
        value={summary.healthy}
        icon={CheckCircle2}
        iconClassName="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
        testId="streams-ops-summary-healthy"
      />
      <SummaryCard
        label="Warning Streams"
        value={summary.warning}
        icon={AlertTriangle}
        iconClassName="bg-status-warning-subtle text-status-warning"
        testId="streams-ops-summary-warning"
      />
      <SummaryCard
        label="Critical Streams"
        value={summary.critical}
        icon={XCircle}
        iconClassName="bg-red-500/15 text-red-600 dark:text-red-400"
        testId="streams-ops-summary-critical"
      />
      <SummaryCard
        label="Issues Streams"
        value={summary.issues}
        icon={Activity}
        iconClassName="bg-red-500/15 text-red-600 dark:text-red-400"
        testId="streams-ops-summary-issues"
      />
    </section>
  )
}
