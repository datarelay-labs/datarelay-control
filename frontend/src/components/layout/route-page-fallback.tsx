import { Loader2 } from 'lucide-react'

/** Suspense fallback for lazy-loaded route pages — matches App Shell card styling. */
export function RoutePageFallback() {
  return (
    <section
      role="status"
      aria-label="Loading page"
      aria-live="polite"
      className="flex min-h-[12rem] items-center justify-center rounded-xl border border-slate-200 bg-white p-8 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card"
      data-testid="route-page-fallback"
    >
      <Loader2 className="h-6 w-6 animate-spin text-slate-400 dark:text-gdc-muted" aria-hidden />
      <span className="sr-only">Loading…</span>
    </section>
  )
}
