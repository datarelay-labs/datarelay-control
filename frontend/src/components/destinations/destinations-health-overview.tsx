/**
 * Calm Destinations posture overview — mirrors StreamsHealthOverview density.
 * Uses existing KPI math only; does not invent capacity/health semantics.
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { DestinationsKpi } from './destination-kpi-strip'

type Posture = 'healthy' | 'warning' | 'critical'

function postureFromKpi(kpi: DestinationsKpi): Posture {
  if (kpi.criticalCount > 0 || kpi.deliveryFailures > 0) return 'critical'
  if (kpi.warningCount > 0 || kpi.capacityWarnings > 0 || kpi.totalAlerts > 0) return 'warning'
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

function postureDescription(kpi: DestinationsKpi, posture: Posture): string {
  if (posture === 'critical') {
    return `${kpi.criticalCount} critical destination${kpi.criticalCount === 1 ? '' : 's'} need attention`
  }
  if (posture === 'warning') {
    if (kpi.capacityWarnings > 0) {
      return `${kpi.capacityWarnings} destination${kpi.capacityWarnings === 1 ? '' : 's'} near configured capacity`
    }
    if (kpi.warningCount > 0) {
      return `${kpi.warningCount} destination${kpi.warningCount === 1 ? '' : 's'} require attention`
    }
    return `${kpi.totalAlerts} active alert${kpi.totalAlerts === 1 ? '' : 's'} detected`
  }
  if (kpi.activeCount === 0) return 'No active destinations yet'
  return 'Destinations are operating within expected delivery posture'
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

export function DestinationsHealthOverview({
  kpi,
  loading,
}: {
  kpi: DestinationsKpi
  loading?: boolean
}) {
  if (loading) {
    return (
      <div
        className="h-28 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated"
        aria-hidden
        data-testid="destinations-health-overview-loading"
      />
    )
  }

  const posture = postureFromKpi(kpi)
  const Icon = posture === 'healthy' ? CheckCircle2 : posture === 'critical' ? XCircle : AlertTriangle

  return (
    <section
      aria-label="Destinations health overview"
      data-testid="destinations-health-overview"
      className={cn('rounded-xl border px-5 py-4 shadow-sm', postureShellClass(posture))}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
              posture === 'healthy' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
              posture === 'warning' && 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
              posture === 'critical' && 'bg-red-500/15 text-red-700 dark:text-red-300',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-slate-300">
              Delivery posture
            </p>
            <p
              className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-50"
              data-testid="destinations-health-posture"
            >
              {postureLabel(posture)}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">{postureDescription(kpi, posture)}</p>
            {kpi.overallCapacityPct != null ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted" data-testid="destinations-capacity-summary">
                Aggregate capacity usage {kpi.overallCapacityPct}%
                {kpi.overallLimitEps != null
                  ? ` · ${kpi.overallCurrentEps.toLocaleString()} / ${kpi.overallLimitEps.toLocaleString()} EPS`
                  : null}
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted" data-testid="destinations-capacity-summary">
                No capacity limits configured
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <CompactCount label="Active" value={kpi.activeCount} testId="destinations-overview-active" />
          <CompactCount
            label="Healthy"
            value={kpi.healthyCount}
            testId="destinations-overview-healthy"
            emphasize="success"
          />
          <CompactCount
            label="Warning"
            value={kpi.warningCount}
            testId="destinations-overview-warning"
            emphasize="warning"
          />
          <CompactCount
            label="Critical"
            value={kpi.criticalCount}
            testId="destinations-overview-critical"
            emphasize="critical"
          />
          <CompactCount
            label="Streams"
            value={kpi.connectedStreamCount}
            testId="destinations-overview-streams"
          />
        </div>
      </div>
    </section>
  )
}
