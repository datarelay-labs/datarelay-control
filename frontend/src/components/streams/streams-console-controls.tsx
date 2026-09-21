import type { StreamsMetricsWindow } from '../../constants/streamConsoleFilters'
import { streamsTimeRangeLabel, AUTO_REFRESH_OPTIONS } from '../../constants/streamConsoleFilters'
import type { StreamsAutoRefreshOption } from '../../localPreferences'
import { cn } from '../../lib/utils'

type StreamsConsoleControlsProps = {
  autoRefresh: StreamsAutoRefreshOption
  onAutoRefreshChange: (value: StreamsAutoRefreshOption) => void
  timeRange: StreamsMetricsWindow
  onTimeRangeChange: (value: StreamsMetricsWindow) => void
  onManualRefresh: () => void
  refreshing?: boolean
}

export function StreamsConsoleControls({
  autoRefresh,
  onAutoRefreshChange,
  timeRange,
  onTimeRangeChange,
  onManualRefresh,
  refreshing,
}: StreamsConsoleControlsProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      data-testid="streams-console-controls"
      aria-label="Streams refresh and time range"
    >
      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-gdc-muted">
        <span className="shrink-0">Time range</span>
        <select
          value={timeRange}
          onChange={(e) => onTimeRangeChange(e.target.value as StreamsMetricsWindow)}
          className="rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          aria-label="Metrics time range"
          data-testid="streams-time-range"
        >
          {(['15m', '1h', '24h', '7d', '30d'] as const).map((w) => (
            <option key={w} value={w}>
              {streamsTimeRangeLabel(w)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-gdc-muted">
        <span className="shrink-0">Auto refresh</span>
        <select
          value={autoRefresh}
          onChange={(e) => onAutoRefreshChange(e.target.value as StreamsAutoRefreshOption)}
          className="rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          aria-label="Auto refresh interval"
          data-testid="streams-auto-refresh"
        >
          {AUTO_REFRESH_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={onManualRefresh}
        disabled={refreshing}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-elevated',
        )}
        aria-label="Refresh streams now"
        data-testid="streams-manual-refresh"
      >
        Refresh
      </button>
    </div>
  )
}
