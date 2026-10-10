import { ArrowRight, Clock3 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { deliveryStatusPresentation, destinationFromRouteLabel, formatLatencyMs, stageChipText } from './logs-console-helpers'
import { LevelBadge } from './logs-level-badge'
import type { LogExplorerRow } from './logs-types'

export function LogsCompactCards({
  rows,
  loading,
  apiUnavailable,
  selectedId,
  onSelect,
  onClearFilters,
  onShowAllStatusesForRoute,
}: {
  rows: readonly LogExplorerRow[]
  loading: boolean
  apiUnavailable: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onClearFilters: () => void
  /** Optional recovery from a failed-only deep link; preserves Route identity. */
  onShowAllStatusesForRoute?: () => void
}) {
  return (
    <section aria-label="Compact delivery logs" data-testid="logs-compact-list" className="space-y-3 p-3" aria-busy={loading}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Loaded delivery evidence</h3>
        <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-gdc-muted">
          {rows.length} on this page
        </span>
      </div>
      {loading && rows.length === 0 ? (
        <p role="status" className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600 dark:bg-gdc-panel dark:text-gdc-muted">
          Loading logs…
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-gdc-border dark:bg-gdc-panel">
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {apiUnavailable ? 'Runtime logs API failed' : 'No logs match the current filters'}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            {apiUnavailable
              ? 'This is missing evidence, not proof of healthy delivery. Retry after restoring API access.'
              : 'Widen the search to inspect more available delivery evidence.'}
          </p>
          {!apiUnavailable ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {onShowAllStatusesForRoute ? (
                <button
                  type="button"
                  onClick={onShowAllStatusesForRoute}
                  className="min-h-10 rounded-lg bg-gdc-primary px-3 py-2 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
                >
                  Show all statuses for this Route
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClearFilters}
                className="min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              >
                Clear log filters
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <ol className="space-y-2">
          {rows.map((row) => {
            const deliveryStatus = deliveryStatusPresentation(
              typeof row.contextJson.status === 'string' ? row.contextJson.status : null,
            )
            const latency = typeof row.contextJson.latency_ms === 'number' && Number.isFinite(row.contextJson.latency_ms)
              ? row.contextJson.latency_ms
              : row.durationMs
            return (
              <li key={row.id}>
                <button
                  type="button"
                  aria-label={`Inspect log ${row.eventId}`}
                  aria-pressed={selectedId === row.id}
                  onClick={() => onSelect(row.id)}
                  className={cn(
                    'group flex w-full min-w-0 flex-col gap-2 rounded-xl border bg-white px-3.5 py-3 text-left shadow-sm transition-colors',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500',
                    'dark:bg-gdc-card',
                    selectedId === row.id
                      ? 'border-violet-400 bg-violet-50 dark:border-violet-500 dark:bg-violet-950/25'
                      : row.level === 'ERROR'
                        ? 'border-red-200 hover:border-red-300 dark:border-red-800/50 dark:hover:border-red-600'
                        : 'border-slate-200 hover:border-violet-300 dark:border-gdc-border dark:hover:border-violet-500',
                  )}
                >
                  <span className="flex w-full flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <LevelBadge level={row.level} />
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-700 dark:bg-gdc-input dark:text-slate-200">
                        {stageChipText(row)}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-slate-500 dark:text-gdc-muted">
                      {row.timeIso.slice(0, 23).replace('T', ' ')}
                    </span>
                  </span>
                  <span className="min-w-0 break-words text-sm font-semibold leading-snug text-slate-900 dark:text-slate-100">
                    {row.message}
                  </span>
                  <span className="min-w-0 break-words text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
                    {row.stream} · {row.route}
                  </span>
                  <span className="flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-slate-100 pt-2 text-xs dark:border-gdc-border">
                    <span className="text-slate-600 dark:text-gdc-mutedStrong">
                      {deliveryStatus.label} · {destinationFromRouteLabel(row.route)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-300">
                      <Clock3 className="h-3 w-3" aria-hidden />
                      {formatLatencyMs(latency)}
                      <span className="ml-1 font-semibold">Inspect <ArrowRight className="inline h-3.5 w-3.5" aria-hidden /></span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {rows.length > 0 ? (
        <p className="text-[11px] leading-5 text-slate-500 dark:text-gdc-muted">
          Loaded gateway log outcomes are not downstream receiver acknowledgements. Open a card for the full evidence.
        </p>
      ) : null}
    </section>
  )
}
