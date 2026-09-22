/**
 * Calm Logs diagnosis posture — mirrors Streams/Destinations health overview density.
 * Uses existing loaded-window and observability totals only; does not invent delivery semantics.
 */

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'

export type LogsDiagnosisSnapshot = {
  loadedFailedDeliveries: number
  loadedSuccessfulDeliveries: number
  errorRows: number
  warningRows: number
  loadedRows: number
  globalFailed: number | null
  globalSuccess: number | null
  lifecycleRows: number | null
  windowLabel: string
}

type Posture = 'healthy' | 'warning' | 'critical'

function postureFromSnapshot(s: LogsDiagnosisSnapshot): Posture {
  if (s.loadedFailedDeliveries > 0 || (s.globalFailed != null && s.globalFailed > 0 && s.errorRows > 0)) {
    return 'critical'
  }
  if (s.errorRows > 0 || s.warningRows > 0 || (s.globalFailed != null && s.globalFailed > 0)) {
    return 'warning'
  }
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
  if (posture === 'critical') return 'Needs recovery'
  if (posture === 'warning') return 'Needs diagnosis'
  return 'Clear'
}

function postureDescription(s: LogsDiagnosisSnapshot, posture: Posture): string {
  if (posture === 'critical') {
    if (s.loadedFailedDeliveries > 0) {
      return `${s.loadedFailedDeliveries} failed deliver${s.loadedFailedDeliveries === 1 ? 'y' : 'ies'} in the loaded sample — open a row to diagnose and recover`
    }
    return `${s.errorRows} ERROR row${s.errorRows === 1 ? '' : 's'} in the loaded sample need attention`
  }
  if (posture === 'warning') {
    if (s.errorRows > 0) {
      return `${s.errorRows} ERROR · ${s.warningRows} WARN in the loaded sample`
    }
    if (s.globalFailed != null && s.globalFailed > 0) {
      return `${s.globalFailed} failed delivery event${s.globalFailed === 1 ? '' : 's'} in the full ${s.windowLabel} window`
    }
    return `${s.warningRows} warning${s.warningRows === 1 ? '' : 's'} in the loaded sample`
  }
  if (s.loadedRows === 0) return 'No delivery logs loaded yet — adjust filters or wait for runtime activity'
  return 'Loaded sample shows no failed deliveries or ERROR rows'
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
        {value.toLocaleString()}
      </p>
    </div>
  )
}

export function LogsDiagnosisOverview({
  snapshot,
  loading,
}: {
  snapshot: LogsDiagnosisSnapshot
  loading?: boolean
}) {
  if (loading) {
    return (
      <div
        className="h-28 animate-pulse rounded-xl bg-slate-200/60 dark:bg-gdc-elevated"
        aria-hidden
        data-testid="logs-diagnosis-overview-loading"
      />
    )
  }

  const posture = postureFromSnapshot(snapshot)
  const Icon = posture === 'healthy' ? CheckCircle2 : posture === 'critical' ? XCircle : AlertTriangle

  return (
    <section
      aria-label="Logs diagnosis overview"
      data-testid="logs-diagnosis-overview"
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
              Diagnosis posture
            </p>
            <p
              className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-50"
              data-testid="logs-diagnosis-posture"
            >
              {postureLabel(posture)}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted" data-testid="logs-diagnosis-summary">
              {postureDescription(snapshot, posture)}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted" data-testid="logs-diagnosis-window-hint">
              Loaded sample vs full {snapshot.windowLabel} window · sample counts are not full-window totals
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2" data-testid="logs-diagnosis-counts">
          <CompactCount
            label="Failed (sample)"
            value={snapshot.loadedFailedDeliveries}
            testId="logs-overview-failed"
            emphasize="critical"
          />
          <CompactCount
            label="Success (sample)"
            value={snapshot.loadedSuccessfulDeliveries}
            testId="logs-overview-success"
            emphasize="success"
          />
          <CompactCount
            label="ERROR"
            value={snapshot.errorRows}
            testId="logs-overview-errors"
            emphasize="critical"
          />
          <CompactCount
            label="WARN"
            value={snapshot.warningRows}
            testId="logs-overview-warnings"
            emphasize="warning"
          />
          <CompactCount label="Loaded" value={snapshot.loadedRows} testId="logs-overview-loaded" />
        </div>
      </div>
    </section>
  )
}
