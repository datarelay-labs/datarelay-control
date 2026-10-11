import { AlertTriangle, CheckCircle2, CircleHelp, Info, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { logsPath } from '../../config/nav-paths'
import type { StreamIssueContext } from '../../lib/stream-issue-context'
import type { IssueWhyStep, OperationalIssue, StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'

type StatusRow = {
  key: string
  label: string
  detail: string
  tone: 'ok' | 'warn' | 'critical' | 'unknown' | 'info'
}

function issueToStatusRow(issue: OperationalIssue): StatusRow {
  return {
    key: issue.key,
    label: issue.label,
    detail: issue.detail ?? 'Active on this stream',
    tone: issue.tone === 'critical' ? 'critical' : issue.tone === 'warning' ? 'warn' : 'info',
  }
}

function buildStatusRows(
  ctx: StreamIssueContext,
  issues: OperationalIssue[],
  gov?: StreamGovernanceSnapshot | null,
): StatusRow[] {
  const byKey = new Map(issues.map((i) => [i.key, i]))
  const rows: StatusRow[] = []

  const destIssue = byKey.get('destination') ?? byKey.get('destination-degraded') ?? byKey.get('low-success')
  rows.push(
    destIssue
      ? issueToStatusRow(destIssue)
      : {
          key: 'destination',
          label: 'Destination delivery',
          detail: ctx.routesError > 0
            ? `${ctx.routesError} path error`
            : ctx.status === 'ERROR'
              ? 'Stream reports an error'
              : ctx.status === 'DEGRADED'
                ? 'Stream reports degraded delivery'
                : ctx.deliveryPctKnown
                  ? `Success rate ${ctx.deliveryPct.toFixed(1)}% in loaded runtime evidence`
                  : 'Delivery outcomes not verified',
          tone: ctx.routesError > 0 || ctx.status === 'ERROR'
            ? 'critical'
            : ctx.status === 'DEGRADED'
              ? 'warn'
              : !ctx.deliveryPctKnown ? 'unknown' : 'ok',
        },
  )

  const errorRateIssue = issues.find((i) => i.key === 'low-success' || i.label.toLowerCase().includes('error'))
  rows.push(
    errorRateIssue
      ? issueToStatusRow(errorRateIssue)
      : {
          key: 'error-rate',
          label: 'High error rate',
          detail: !ctx.deliveryPctKnown
            ? 'Delivery success rate not verified'
            : `Success rate ${ctx.deliveryPct.toFixed(1)}%`,
          tone: !ctx.deliveryPctKnown
            ? 'unknown'
            : ctx.deliveryPct < 85 ? 'critical' : ctx.deliveryPct < 95 ? 'warn' : 'ok',
        },
  )

  // No expected EPS/volume baseline is available in this panel's evidence contract.
  rows.push({
    key: 'volume',
    label: 'Ingest volume',
    detail: 'Expected ingest range not verified',
    tone: 'unknown',
  })

  const schemaIssue = byKey.get('schema-drift')
  rows.push(
    schemaIssue
      ? issueToStatusRow(schemaIssue)
      : {
          key: 'schema-drift',
          label: 'Schema drift',
          detail: gov?.schemaDrift == null
            ? 'Schema drift summary not verified'
            : gov.schemaDrift.open_count > 0
              ? `${gov.schemaDrift.open_count} open`
              : 'No open schema drift findings in loaded summary',
          tone: gov?.schemaDrift == null ? 'unknown' : gov.schemaDrift.open_count > 0 ? 'warn' : 'ok',
        },
  )

  const sensitiveIssue = byKey.get('sensitive')
  rows.push(
    sensitiveIssue
      ? issueToStatusRow(sensitiveIssue)
      : {
          key: 'sensitive',
          label: 'Sensitive detection',
          detail: gov?.sensitive == null
            ? 'Sensitive findings summary not verified'
            : gov.sensitive.open_count > 0
              ? `${gov.sensitive.open_count} open`
              : 'No open sensitive findings in loaded summary',
          tone: gov?.sensitive == null ? 'unknown' : gov.sensitive.open_count > 0 ? 'warn' : 'ok',
        },
  )

  return rows
}

function StatusIcon({ tone }: { tone: StatusRow['tone'] }) {
  if (tone === 'critical') return <XCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden />
  if (tone === 'warn') return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
  if (tone === 'unknown') return <CircleHelp className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
  if (tone === 'info') return <Info className="h-4 w-4 shrink-0 text-sky-500" aria-hidden />
  return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
}

export function StreamRecentIssuesPanel({
  ctx,
  issues,
  whyChain: _whyChain,
  governance,
}: {
  ctx: StreamIssueContext
  issues: OperationalIssue[]
  whyChain: IssueWhyStep[]
  governance?: StreamGovernanceSnapshot | null
}) {
  const statusRows = buildStatusRows(ctx, issues, governance)
  const activeCount = statusRows.filter((r) => r.tone === 'warn' || r.tone === 'critical').length
  const unverifiedCount = statusRows.filter((r) => r.tone === 'unknown').length

  return (
    <section
      aria-label="Recent issues"
      data-testid="stream-recent-issues-panel"
      className="flex min-h-[280px] flex-col rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
        <div>
          <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recent Issues</h3>
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">
            {activeCount > 0
              ? `${activeCount} item${activeCount === 1 ? '' : 's'} need attention${unverifiedCount > 0 ? ` · ${unverifiedCount} not verified` : ''}`
              : unverifiedCount > 0
                ? `${unverifiedCount} categories not verified`
                : 'Operational status by category'}
          </p>
        </div>
        <Link to={logsPath(ctx.id)} className="text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-400">
          View all →
        </Link>
      </div>

      <ul className="flex-1 divide-y divide-slate-200/70 dark:divide-gdc-divider">
        {statusRows.map((row) => (
          <li key={row.key} data-evidence-status={row.tone} className="flex items-start gap-3 px-4 py-3">
            <StatusIcon tone={row.tone} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[12px] font-semibold',
                  row.tone === 'critical' && 'text-red-700 dark:text-red-300',
                  row.tone === 'warn' && 'text-amber-800 dark:text-amber-200',
                  row.tone === 'ok' && 'text-slate-800 dark:text-slate-100',
                  row.tone === 'unknown' && 'text-slate-600 dark:text-slate-300',
                  row.tone === 'info' && 'text-slate-700 dark:text-slate-200',
                )}
              >
                {row.label}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-gdc-muted">{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
