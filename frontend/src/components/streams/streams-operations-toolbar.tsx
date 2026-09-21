import { Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StreamsQuickFilter } from '../../lib/streams-console-operations'

const QUICK_FILTERS: readonly { id: StreamsQuickFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'healthy', label: 'Healthy' },
  { id: 'warning', label: 'Warning' },
  { id: 'critical', label: 'Critical' },
  { id: 'issues', label: 'Issues Only' },
]

type StreamsOperationsToolbarProps = {
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  quickFilter: StreamsQuickFilter
  onQuickFilterChange: (value: StreamsQuickFilter) => void
  groupFilter: string
  onGroupFilterChange: (value: string) => void
  groupOptions: readonly string[]
}

export function StreamsOperationsToolbar({
  searchQuery,
  onSearchQueryChange,
  quickFilter,
  onQuickFilterChange,
  groupFilter,
  onGroupFilterChange,
  groupOptions,
}: StreamsOperationsToolbarProps) {
  return (
    <section
      aria-label="Streams operations filters"
      data-testid="streams-operations-toolbar"
      className="space-y-3 rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Search streams, source products, destinations…"
          className="h-10 w-full rounded-lg border border-slate-200/90 bg-slate-50/80 py-2 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400/30 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-gdc-foreground dark:placeholder:text-gdc-placeholder"
          aria-label="Search streams"
          data-testid="streams-search-input"
        />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick filters" data-testid="streams-quick-filters">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid={`streams-quick-filter-${f.id}`}
              aria-pressed={quickFilter === f.id}
              onClick={() => onQuickFilterChange(f.id)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors',
                quickFilter === f.id
                  ? 'border-slate-700 bg-slate-900 text-white dark:border-slate-200 dark:bg-slate-100 dark:text-slate-900'
                  : 'border-slate-200/80 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-muted dark:hover:bg-gdc-elevated',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600 dark:text-gdc-muted">
          <span className="shrink-0">Group</span>
          <select
            value={groupFilter}
            onChange={(e) => onGroupFilterChange(e.target.value)}
            className="min-w-[10rem] rounded-lg border border-slate-200/90 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            aria-label="Filter by source product group"
            data-testid="streams-group-filter"
          >
            <option value="all">All Products</option>
            {groupOptions.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}
