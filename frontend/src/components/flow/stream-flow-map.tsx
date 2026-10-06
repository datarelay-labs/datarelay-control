import { Link } from 'react-router-dom'
import { destinationDetailPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'
import type { RouteRuntimeMetricsRow } from '../../api/types/gdcApi'

export type StreamFlowMapProps = {
  streamId: number
  streamName: string
  routes: readonly RouteRuntimeMetricsRow[]
  loading?: boolean
  showStreamLink?: boolean
}

const fmtEps = (value: number) => Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)} EPS` : '—'
const tone = (state: string) => state === 'HEALTHY'
  ? 'border-emerald-400/50 bg-emerald-500/10'
  : state === 'DEGRADED'
    ? 'border-amber-400/50 bg-amber-500/10'
    : state === 'ERROR'
      ? 'border-red-400/50 bg-red-500/10'
      : 'border-slate-300 bg-slate-50 dark:border-gdc-border dark:bg-gdc-section'

export function StreamFlowMap({ streamId, streamName, routes, loading = false, showStreamLink = true }: StreamFlowMapProps) {
  return (
    <section aria-label={`Delivery flow for ${streamName}`} className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid={`stream-flow-map-${streamId}`}>
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Stream → Routes → Destinations</h3>
        <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Runtime facts only · health and throughput appear only when reported by the runtime snapshot.</p>
      </div>
      {loading && routes.length === 0 ? <div className="h-20 animate-pulse rounded-lg bg-slate-100 dark:bg-gdc-elevated" /> : null}
      {!loading && routes.length === 0 ? <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500 dark:border-gdc-border">No routes configured for this stream.</p> : null}
      {routes.length > 0 ? (
        <div className="space-y-2">
          {showStreamLink ? <Link to={streamRuntimePath(String(streamId))} className="inline-flex rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100">{streamName}</Link> : <span className="inline-flex rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-900 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100">{streamName}</span>}
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" role="list" aria-label={`Routes from ${streamName}`}>
            {routes.map((route) => (
              <div key={route.route_id} role="listitem" className={`rounded-lg border p-2.5 ${tone(route.connectivity_state)}`}>
                <div className="flex items-center gap-1 text-slate-400" aria-hidden><span>↓</span><span className="h-px flex-1 bg-current opacity-40" /></div>
                <Link to={routeEditPath(String(route.route_id))} className="mt-1 block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">Route #{route.route_id}</Link>
                <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">{fmtEps(route.eps_current)} · {route.success_rate.toFixed(1)}% success · {route.connectivity_state}</p>
                <div className="mt-2 border-t border-current/10 pt-2">
                  {route.destination_id > 0 ? <Link to={destinationDetailPath(String(route.destination_id))} className="text-[11px] font-semibold text-slate-800 hover:underline dark:text-slate-100">{route.destination_name || `Destination #${route.destination_id}`}</Link> : <span className="text-[11px] text-slate-500">Destination metadata unavailable</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="sr-only" data-testid={`stream-flow-map-accessible-summary-${streamId}`}>Stream {streamName} has {routes.length} routes. {routes.map((route) => `Route ${route.route_id} to ${route.destination_name || `destination ${route.destination_id}`}: ${route.connectivity_state}.`).join(' ')}</div>
        </div>
      ) : null}
    </section>
  )
}
