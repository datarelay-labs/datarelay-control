import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StreamsPageKpi } from '../../lib/stream-console-metrics'
import type { StreamOperationsSummary } from '../../lib/streams-console-operations'

type Posture = 'healthy' | 'warning' | 'critical'

function postureFromKpi(kpi: StreamsPageKpi): Posture {
  if (kpi.criticalStreams > 0) return 'critical'
  if (kpi.warningStreams > 0 || kpi.totalIssues > 0) return 'warning'
  return 'healthy'
}

function postureShellClass(posture: Posture): string {
  if (posture === 'critical') {
    return 'border-red-300/80 bg-red-50 dark:border-red-500/40 dark:bg-red-950/30'
  }
  if (posture === 'warning') {
    return 'border-amber-300/80 bg-amber-50 dark:border-amber-500/35 dark:bg-amber-950/25'
  }
  return 'border-emerald-300/80 bg-emerald-50 dark:border-emerald-500/35 dark:bg-emerald-950/25'
}

function postureLabel(posture: Posture): string {
  if (posture === 'critical') return 'Critical'
  if (posture === 'warning') return 'Warning'
  return 'Healthy'
}

function postureDescription(kpi: StreamsPageKpi, posture: Posture): string {
  if (posture === 'critical') {
    return `${kpi.criticalStreams} critical stream${kpi.criticalStreams === 1 ? '' : 's'} need attention`
  }
  if (posture === 'warning') {
    if (kpi.warningStreams > 0) {
      return `${kpi.warningStreams} stream${kpi.warningStreams === 1 ? '' : 's'} require attention`
    }
    return `${kpi.totalIssues} active issue${kpi.totalIssues === 1 ? '' : 's'} detected`
  }
  return 'All stream groups are operating normally'
}

type CountProps = {
  label: string
  value: number
  testId: string
  emphasize?: 'warning' | 'critical' | 'success'
}

function CompactCount({ label, value, testId, emphasize }: CountProps) {
  return (
    <div
      data-testid={testId}
      className="min-w-[4.5rem] rounded-lg border border-slate-200/70 bg-white/70 px-3 py-2 dark:border-gdc-border dark:bg-gdc-card/70"
    >
      <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50',
          emphasize === 'critical' && value > 0 && 'text-red-600 dark:text-red-400',
          emphasize === 'warning' && value > 0 && 'text-amber-600 dark:text-amber-400',
          emphasize === 'success' && value > 0 && 'text-emerald-600 dark:text-emerald-400',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function StreamsHealthOverview({
  kpi,
  summary,
  groupCount,
  loading,
}: {
  kpi: StreamsPageKpi
  summary: StreamOperationsSummary
  groupCount: number
  loading?: boolean
}) {
  if (loading) {
    return (
      <div
        className="h-28 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated"
        aria-hidden
        data-testid="streams-health-overview-loading"
      />
    )
  }

  const posture = postureFromKpi(kpi)
  const Icon = posture === 'healthy' ? CheckCircle2 : posture === 'critical' ? XCircle : AlertTriangle

  return (
    <section
      aria-label="Streams health overview"
      data-testid="streams-health-overview"
      className={cn('rounded-xl border px-5 py-4 shadow-sm', postureShellClass(posture))}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Icon
            className={cn(
              'mt-0.5 h-6 w-6 shrink-0',
              posture === 'critical' && 'text-red-600 dark:text-red-400',
              posture === 'warning' && 'text-amber-600 dark:text-amber-400',
              posture === 'healthy' && 'text-emerald-600 dark:text-emerald-400',
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-600 dark:text-slate-400">Stream groups</p>
            <p
              className={cn(
                'text-2xl font-semibold tracking-tight',
                posture === 'critical' && 'text-red-700 dark:text-red-300',
                posture === 'warning' && 'text-amber-700 dark:text-amber-300',
                posture === 'healthy' && 'text-emerald-700 dark:text-emerald-300',
              )}
              data-testid="streams-health-posture"
            >
              {postureLabel(posture)}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{postureDescription(kpi, posture)}</p>
            <p className="mt-1 text-sm text-slate-500 dark:text-gdc-muted">
              {groupCount} group{groupCount === 1 ? '' : 's'} · {kpi.totalStreams} stream
              {kpi.totalStreams === 1 ? '' : 's'}
              {kpi.totalEpsLabel !== '—' ? ` · ${kpi.totalEpsLabel} EPS` : ''}
            </p>
          </div>
        </div>

        <div
          className="flex flex-wrap gap-2"
          data-testid="streams-operations-summary"
          aria-label="Stream operations summary"
        >
          <CompactCount
            label="Healthy"
            value={summary.healthy}
            testId="streams-ops-summary-healthy"
            emphasize="success"
          />
          <CompactCount
            label="Warning"
            value={summary.warning}
            testId="streams-ops-summary-warning"
            emphasize="warning"
          />
          <CompactCount
            label="Critical"
            value={summary.critical}
            testId="streams-ops-summary-critical"
            emphasize="critical"
          />
          <CompactCount
            label="Issues"
            value={summary.issues}
            testId="streams-ops-summary-issues"
            emphasize="critical"
          />
        </div>
      </div>
    </section>
  )
}
