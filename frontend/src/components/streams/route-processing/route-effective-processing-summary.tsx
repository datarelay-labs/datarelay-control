import type { RouteProcessingStatus } from '../wizard/wizard-state'
import { ROUTE_PROCESSING_CONCERN_LABEL, ROUTE_PROCESSING_CONCERN_KEYS } from './route-processing-labels'
import { RouteProcessingStatusBadge } from './route-processing-status-badge'

type EffectiveStatuses = Record<(typeof ROUTE_PROCESSING_CONCERN_KEYS)[number], RouteProcessingStatus | null>

function deltaLabel(status: RouteProcessingStatus | null): string {
  if (status === 'Inherited') return 'No route delta — shared processing is effective'
  if (status === 'Overridden') return 'Route override replaces shared processing'
  if (status === 'Mixed') return 'Route override and shared processing are both effective'
  return 'Effective state unavailable'
}

export function RouteEffectiveProcessingSummary({
  statuses,
  pending,
}: {
  statuses: EffectiveStatuses | undefined
  pending: boolean
}) {
  return (
    <section
      className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-gdc-border dark:bg-gdc-section/60"
      data-testid="route-effective-processing-summary"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Effective processing</p>
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">
            Runtime-resolved shared + route processing for this route. This is effective state, not draft configuration.
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
          Runtime truth
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {ROUTE_PROCESSING_CONCERN_KEYS.map((concern) => {
          const status = statuses?.[concern] ?? null
          return (
            <div
              key={concern}
              className="rounded-md border border-slate-200/80 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card"
              data-testid={`route-effective-${concern}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-200">
                  {ROUTE_PROCESSING_CONCERN_LABEL[concern]}
                </span>
                {pending ? (
                  <span className="text-[10px] text-slate-400">…</span>
                ) : status ? (
                  <RouteProcessingStatusBadge status={status} />
                ) : (
                  <span className="text-[10px] text-slate-400">Unavailable</span>
                )}
              </div>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-muted">
                {pending ? 'Resolving effective state…' : deltaLabel(status)}
              </p>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-muted">
        Open Transform below to inspect the effective Final Event preview using the existing runtime preview path.
      </p>
    </section>
  )
}
