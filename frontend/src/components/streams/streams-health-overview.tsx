import { AlertTriangle, CheckCircle2, CircleHelp, Minus, XCircle } from 'lucide-react'
import { semanticCn } from '../ui/semantic-cn'
import type { StreamsPageKpi } from '../../lib/stream-console-metrics'
import type { StreamOperationsSummary } from '../../lib/streams-console-operations'

/** `unknown`: active streams without a verdict yet. `inactive`: nothing active to judge (never Healthy). */
type Posture = 'healthy' | 'warning' | 'critical' | 'unknown' | 'inactive'

function postureFromKpi(kpi: StreamsPageKpi, summary: StreamOperationsSummary): Posture {
  // Critical and warning always win; an unobserved stream never masks them (and never reads Healthy).
  if (kpi.criticalStreams > 0) return 'critical'
  if (kpi.warningStreams > 0 || kpi.totalIssues > 0) return 'warning'
  if ((summary.unknown ?? 0) > 0) return 'unknown'
  if (kpi.healthyStreams === 0) return 'inactive'
  return 'healthy'
}

function postureShellClass(posture: Posture): string {
  if (posture === 'critical') return 'border-status-critical-border bg-status-critical-subtle'
  if (posture === 'warning') return 'border-status-warning-border bg-status-warning-subtle'
  if (posture === 'unknown' || posture === 'inactive') return 'border-status-unknown-border bg-status-unknown-subtle'
  return 'border-status-success-border bg-status-success-subtle'
}

function postureTextClass(posture: Posture): string {
  if (posture === 'critical') return 'text-status-critical'
  if (posture === 'warning') return 'text-status-warning'
  if (posture === 'unknown' || posture === 'inactive') return 'text-status-unknown'
  return 'text-status-success'
}

function postureLabel(posture: Posture): string {
  if (posture === 'critical') return 'Critical'
  if (posture === 'warning') return 'Warning'
  if (posture === 'unknown') return 'Not verified'
  if (posture === 'inactive') return 'No active streams'
  return 'Healthy'
}

function postureDescription(kpi: StreamsPageKpi, summary: StreamOperationsSummary, posture: Posture): string {
  if (posture === 'unknown') {
    const n = summary.unknown
    return `${n} active stream${n === 1 ? '' : 's'} not observed yet`
  }
  if (posture === 'inactive') {
    return kpi.totalStreams === 0 ? 'No streams are configured yet' : 'All streams are stopped or have no data yet'
  }
  if (posture === 'critical') {
    return `${kpi.criticalStreams} critical stream${kpi.criticalStreams === 1 ? '' : 's'} need attention`
  }
  if (posture === 'warning') {
    if (kpi.warningStreams > 0) {
      return `${kpi.warningStreams} stream${kpi.warningStreams === 1 ? '' : 's'} require attention`
    }
    return `${kpi.totalIssues} active issue${kpi.totalIssues === 1 ? '' : 's'} detected`
  }
  if (kpi.noDataStreams > 0) {
    return `${kpi.healthyStreams} healthy stream${kpi.healthyStreams === 1 ? '' : 's'} · ${kpi.noDataStreams} stopped or without data`
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
      className="min-w-[4.5rem] rounded-lg border border-default bg-surface-card px-3 py-2"
    >
      <p className="text-caption font-medium text-fg-muted">{label}</p>
      <p
        className={semanticCn(
          'mt-0.5 text-title font-semibold tabular-nums text-fg',
          emphasize === 'critical' && value > 0 && 'text-status-critical',
          emphasize === 'warning' && value > 0 && 'text-status-warning',
          emphasize === 'success' && value > 0 && 'text-status-success',
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
        className="h-28 animate-pulse rounded-xl bg-surface-section"
        aria-hidden
        data-testid="streams-health-overview-loading"
      />
    )
  }

  const posture = postureFromKpi(kpi, summary)
  const Icon =
    posture === 'healthy'
      ? CheckCircle2
      : posture === 'critical'
        ? XCircle
        : posture === 'unknown'
          ? CircleHelp
          : posture === 'inactive'
            ? Minus
            : AlertTriangle

  return (
    <section
      aria-label="Streams health overview"
      data-testid="streams-health-overview"
      className={semanticCn('rounded-xl border px-5 py-4 shadow-sm', postureShellClass(posture))}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className={semanticCn('mt-0.5 h-6 w-6 shrink-0', postureTextClass(posture))} aria-hidden />
          <div className="min-w-0">
            <p className="text-body-sm font-medium text-fg-secondary">Stream groups</p>
            <p
              className={semanticCn('text-page-title font-semibold tracking-tight', postureTextClass(posture))}
              data-testid="streams-health-posture"
            >
              {postureLabel(posture)}
            </p>
            <p className="mt-1 text-body-sm text-fg-secondary">{postureDescription(kpi, summary, posture)}</p>
            <p className="mt-1 text-body-sm text-fg-muted">
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
          {summary.unknown > 0 ? (
            <CompactCount
              label="Not verified"
              value={summary.unknown}
              testId="streams-ops-summary-unknown"
            />
          ) : null}
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
