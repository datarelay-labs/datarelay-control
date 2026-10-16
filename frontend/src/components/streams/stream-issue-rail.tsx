import { AlertTriangle, Loader2, Play, Square } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { StreamConsoleRow } from '../../api/streamRows'
import { NAV_PATH, logsPath, streamEditPath } from '../../config/nav-paths'
import { OP_LABEL } from '../../lib/operator-vocabulary'
import { issueChipLabel, issueWhySummary, type StreamIssueContext } from '../../lib/stream-issue-context'
import { resolveSourceProductLabel } from '../../lib/source-product-group'
import { StatusBadge } from '../shell/status-badge'
import { cn } from '../../lib/utils'

export function streamIssueContextFromRow(row: StreamConsoleRow): StreamIssueContext {
  return {
    id: row.id,
    status: row.status,
    connectorName: row.connectorName,
    connectorProductGroup: row.connectorProductGroup,
    deliveryPctKnown: row.deliveryPctKnown,
    deliveryPct: row.deliveryPct,
    routesError: row.routesError,
    lastActivityRelative: row.lastActivityRelative,
    recentErrors: row.recentErrors ?? [],
  }
}

export function StreamIssueRail({
  ctx,
  numericId,
  controlBusy,
  runOnceBusy,
  onRunOnce,
  onStop,
}: {
  ctx: StreamIssueContext
  numericId: number | null
  controlBusy: boolean
  runOnceBusy: boolean
  onRunOnce: () => void
  onStop: () => void
}) {
  const product = resolveSourceProductLabel(ctx.connectorName, { product_group: ctx.connectorProductGroup })
  const why = issueWhySummary(ctx)
  const chip = issueChipLabel(ctx)
  const hasIssue = ctx.status === 'ERROR' || ctx.status === 'DEGRADED' || ctx.routesError > 0 ||
    (ctx.deliveryPctKnown && ctx.deliveryPct < 90)
  const verifiedHealthy = chip === 'Healthy'
  const lifecycleTone = ctx.status === 'ERROR'
    ? 'error'
    : ctx.status === 'DEGRADED' || (ctx.deliveryPctKnown && ctx.deliveryPct < 90)
      ? 'warning'
      : verifiedHealthy ? 'success' : 'neutral'

  return (
    <div className="space-y-3" data-testid="stream-issue-rail">
      <section className="rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.whatHappened}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={lifecycleTone}
            className="font-bold uppercase"
          >
            {ctx.status}
          </StatusBadge>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-semibold',
              hasIssue
                ? 'border-amber-300/80 bg-amber-50 text-amber-900 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100'
                : verifiedHealthy
                  ? 'border-emerald-300/80 bg-emerald-50 text-emerald-900 dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-100'
                  : 'border-slate-300/80 bg-slate-50 text-slate-700 dark:border-slate-500/35 dark:bg-slate-500/10 dark:text-slate-200',
            )}
          >
            {chip}
          </span>
        </div>
        <dl className="mt-2 space-y-1 text-[12px]">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500 dark:text-gdc-muted">{OP_LABEL.sourceProduct}</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{product}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500 dark:text-gdc-muted">Delivery success</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {ctx.deliveryPctKnown ? `${ctx.deliveryPct.toFixed(1)}%` : '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500 dark:text-gdc-muted">Last activity</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{ctx.lastActivityRelative}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.why}</p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">{why}</p>
        {ctx.recentErrors.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {ctx.recentErrors.slice(0, 2).map((err, i) => (
              <li key={`${err.message}-${i}`} className="flex items-start gap-1.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" aria-hidden />
                <span>{err.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{OP_LABEL.whatShouldIDo}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            to={logsPath(ctx.id)}
            className="inline-flex rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200"
          >
            View delivery records
          </Link>
          <Link
            to={streamEditPath(ctx.id)}
            className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
          >
            Stream setup
          </Link>
          {numericId != null ? (
            <Link
              to={`${NAV_PATH.analytics}?stream_id=${numericId}`}
              className="inline-flex rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
            >
              Delivery analytics
            </Link>
          ) : null}
          <button
            type="button"
            disabled={numericId == null || runOnceBusy}
            onClick={onRunOnce}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200"
          >
            {runOnceBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run now
          </button>
          {ctx.status === 'RUNNING' ? (
            <button
              type="button"
              disabled={numericId == null || controlBusy}
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded-md border border-red-300/60 px-2.5 py-1 text-[11px] font-semibold text-red-800 disabled:opacity-50 dark:border-red-500/35 dark:text-red-200"
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
