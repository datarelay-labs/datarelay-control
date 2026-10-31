import { AlertTriangle } from 'lucide-react'
import { deriveStreamHeroHeadline, issueWhySummary, type StreamIssueContext } from '../../lib/stream-issue-context'
import type { IssueWhyStep, OperationalIssue } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'

type WhyVerdict = 'critical' | 'warning' | 'healthy' | 'stopped' | 'not-verified'

/** No issues is Healthy only when delivery was actually observed; otherwise it is Stopped or Not verified. */
function whyVerdict(ctx: StreamIssueContext, issues: readonly OperationalIssue[]): WhyVerdict {
  if (issues.some((i) => i.tone === 'critical')) return 'critical'
  if (issues.length > 0) return 'warning'
  const headline = deriveStreamHeroHeadline(ctx.status, ctx.routesError, ctx.deliveryPctKnown, ctx.deliveryPct)
  if (headline === 'Stream Healthy') return 'healthy'
  if (headline === 'Stream Stopped') return 'stopped'
  if (headline === 'Delivery Failures Detected') return 'critical'
  if (headline === 'Delivery Delayed' || headline === 'Protection Violations Detected') return 'warning'
  return 'not-verified'
}

function severityBadgeClass(verdict: WhyVerdict): string {
  if (verdict === 'critical') return 'border-red-400/50 bg-red-500/10 text-red-300'
  if (verdict === 'warning') return 'border-status-warning-border bg-status-warning-subtle text-status-warning'
  if (verdict === 'healthy') return 'border-emerald-400/50 bg-emerald-500/10 text-emerald-300'
  return 'border-slate-300/70 bg-slate-500/10 text-slate-600 dark:border-slate-500/50 dark:text-slate-300'
}

function severityBadgeLabel(verdict: WhyVerdict): string {
  if (verdict === 'critical') return 'Critical'
  if (verdict === 'warning') return 'Warning'
  if (verdict === 'healthy') return 'Healthy'
  return verdict === 'stopped' ? 'Stopped' : 'Not verified'
}

function buildSummary(
  ctx: StreamIssueContext,
  verdict: WhyVerdict,
  issues: readonly OperationalIssue[],
  whyChain: readonly IssueWhyStep[],
): string {
  if (!issues.length) {
    if (verdict === 'healthy') {
      return 'No delivery, schema, or protection issues detected for this stream in the current window.'
    }
    if (verdict === 'stopped') return 'Stream is stopped or paused. No failure is indicated.'
    if (verdict === 'not-verified') {
      return 'Health is not verified: no delivery has been observed for this stream in the current window.'
    }
    return issueWhySummary(ctx)
  }
  const parts: string[] = []
  const primary = issues[0]
  if (primary.detail) parts.push(primary.detail)
  else parts.push(primary.label)
  for (const step of whyChain.slice(1, 3)) {
    if (step.detail) parts.push(step.detail)
  }
  return parts.join('. ')
}

function recommendedActions(issues: readonly OperationalIssue[]): string[] {
  if (!issues.length) return []
  const actions: string[] = []
  const keys = new Set(issues.map((i) => i.key))
  if (keys.has('destination') || keys.has('destination-degraded') || keys.has('low-success')) {
    actions.push('Review destination rate limits and retry policy configuration.')
    actions.push('Check delivery logs for HTTP 429 or timeout patterns.')
  }
  if (keys.has('schema-drift')) {
    actions.push('Acknowledge or resolve open schema drift findings.')
  }
  if (keys.has('sensitive') || keys.has('quarantine')) {
    actions.push('Review sensitive data findings and protection rules.')
  }
  if (keys.has('failover')) {
    actions.push('Verify failover route configuration and destination health.')
  }
  if (!actions.length) {
    actions.push('Open delivery records for the latest failure context.')
  }
  return actions.slice(0, 3)
}

export function StreamWhyPanel({
  ctx,
  issues,
  whyChain,
}: {
  ctx: StreamIssueContext
  issues: OperationalIssue[]
  whyChain: IssueWhyStep[]
}) {
  const verdict = whyVerdict(ctx, issues)
  const summary = buildSummary(ctx, verdict, issues, whyChain)
  const actions = recommendedActions(issues)

  return (
    <section
      aria-label="Why is this happening"
      data-testid="stream-why-panel"
      className="flex flex-col rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Why is this happening?</h3>
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase', severityBadgeClass(verdict))}>
          {severityBadgeLabel(verdict)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 py-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Summary</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">{summary}</p>
        </div>
        {actions.length > 0 ? (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Recommended actions</p>
            <ul className="mt-1.5 space-y-1.5">
              {actions.map((action) => (
                <li key={action} className="flex items-start gap-1.5 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-status-warning" aria-hidden />
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}
