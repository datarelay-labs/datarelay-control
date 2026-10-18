import { Link } from 'react-router-dom'
import { logsPath, streamEditPath, streamMappingPath } from '../../config/nav-paths'
import { OP_LABEL } from '../../lib/operator-vocabulary'
import {
  deriveStreamHeroHeadline,
  issueWhatHappenedSummary,
  issueWhySummary,
  type StreamHeroHeadline,
  type StreamIssueContext,
} from '../../lib/stream-issue-context'
import { StatusBadge } from '../shell/status-badge'
import { cn } from '../../lib/utils'

function heroTone(headline: StreamHeroHeadline): 'success' | 'warning' | 'error' | 'neutral' {
  if (headline === 'Stream Healthy') return 'success'
  if (headline === 'Stream Stopped' || headline === 'Stream Idle' || headline === 'Health Not Verified') return 'neutral'
  if (headline === 'Protection Violations Detected') return 'warning'
  return 'error'
}

export function StreamDetailHero({
  ctx,
  protectionViolations,
  analyticsHref,
}: {
  ctx: StreamIssueContext
  protectionViolations?: boolean
  analyticsHref?: string | null
}) {
  const headline = deriveStreamHeroHeadline(
    ctx.status,
    ctx.routesError,
    ctx.deliveryPctKnown,
    ctx.deliveryPct,
    protectionViolations,
  )
  const whatHappened = issueWhatHappenedSummary(ctx, headline)
  const why = issueWhySummary(ctx)
  const tone = heroTone(headline)

  return (
    <section
      data-testid="stream-detail-hero"
      className={cn(
        'rounded-xl border px-5 py-4',
        tone === 'success' && 'border-emerald-200/80 bg-emerald-500/[0.06] dark:border-emerald-500/30 dark:bg-emerald-500/10',
        tone === 'warning' && 'border-amber-200/80 bg-amber-500/[0.07] dark:border-amber-500/30 dark:bg-amber-500/10',
        tone === 'error' && 'border-red-200/80 bg-red-500/[0.06] dark:border-red-500/30 dark:bg-red-500/10',
        tone === 'neutral' && 'border-slate-200/80 bg-slate-50/80 dark:border-gdc-border dark:bg-gdc-card',
      )}
    >
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.whatHappened}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{headline}</h2>
        <StatusBadge tone={tone} className="font-bold uppercase">
          {ctx.status}
        </StatusBadge>
      </div>
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">{whatHappened}</p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200/60 bg-white/70 px-3 py-2 dark:border-gdc-border dark:bg-gdc-elevated/50">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.why}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">{why}</p>
        </div>
        <div className="rounded-lg border border-slate-200/60 bg-white/70 px-3 py-2 dark:border-gdc-border dark:bg-gdc-elevated/50">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.requiredAction}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Link
              to={logsPath(ctx.id)}
              className="inline-flex rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200"
            >
              Delivery records
            </Link>
            <Link
              to={streamEditPath(ctx.id)}
              className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
            >
              Setup
            </Link>
            {ctx.status === 'ERROR' || ctx.status === 'DEGRADED' ? (
              <Link
                to={streamMappingPath(ctx.id)}
                className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
              >
                Mapping
              </Link>
            ) : null}
            {analyticsHref ? (
              <Link
                to={analyticsHref}
                className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
              >
                Analytics
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
