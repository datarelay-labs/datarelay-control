import { useState } from 'react'
import { ArrowUpRight, Activity, Network } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { RuntimeFlowTopology } from '../routes/runtime-flow-topology'
import { snapshotIsFresh } from '../routes/runtime-flow-graph-model'

export type DashboardLiveFlowsPanelProps = {
  snapshot: OperationalSnapshotResponse
  requestFailed?: boolean
}

/** Operational dashboard summary of genuinely observed Stream/Route relations.
 * No synthetic traffic, new polling, or implicit delivery/receiver acknowledgement.
 */
export function DashboardLiveFlowsPanel({ snapshot, requestFailed = false }: DashboardLiveFlowsPanelProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const existingStreamIds = new Set(snapshot.routes
    .filter((route) => Number.isSafeInteger(route.route_id) && route.route_id > 0 &&
      Number.isSafeInteger(route.stream_id) && route.stream_id > 0)
    .map((route) => route.stream_id))
  const streams = snapshot.streams
    .filter((item) => Number.isSafeInteger(item.stream_id) && item.stream_id > 0 && existingStreamIds.has(item.stream_id))
    .sort((a, b) => {
      const rateA = Number.isFinite(a.eps_1m) && a.eps_1m >= 0 ? a.eps_1m : -1
      const rateB = Number.isFinite(b.eps_1m) && b.eps_1m >= 0 ? b.eps_1m : -1
      return rateB - rateA || a.stream_id - b.stream_id
    })
  if (streams.length === 0) return null

  const selected = streams.find((item) => item.stream_id === selectedId) ?? streams[0]!
  const routeCount = snapshot.routes.filter((item) => item.stream_id === selected.stream_id).length
  const fresh = !requestFailed && snapshotIsFresh(snapshot.updated_at)

  return (
    <section aria-label="Live data flow overview" data-testid="dashboard-live-data-flows"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 px-4 py-4 dark:border-gdc-border sm:px-6">
        <div className="flex items-start gap-3">
          <span aria-hidden className="rounded-lg border border-violet-200 bg-violet-100 p-2 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
            <Network className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Data flow activity</h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
              Observe real Stream → Route → Destination delivery. Motion means measured gateway delivery rate,
              not verified receiver receipt.
            </p>
          </div>
        </div>
        <Link to={`${NAV_PATH.routes}?stream_id=${selected.stream_id}`}
          className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50 dark:border-gdc-border dark:text-violet-300 dark:hover:bg-gdc-rowHover">
          Explore Data Flows <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 py-3 dark:bg-gdc-panel/20 sm:px-6">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="dashboard-live-flow-stream" className="block text-xs font-semibold text-slate-600 dark:text-gdc-mutedStrong">
            Select data flow Stream
          </label>
          <select id="dashboard-live-flow-stream" value={selected.stream_id}
            onChange={(event) => setSelectedId(Number(event.target.value))}
            className="mt-1.5 min-h-10 max-w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100">
            {streams.map((stream) => (
              <option value={stream.stream_id} key={stream.stream_id}>
                {stream.stream_name || `Stream #${stream.stream_id}`} · Stream #{stream.stream_id}
              </option>
            ))}
          </select>
        </div>
        <p role="status" data-testid="dashboard-live-flow-status"
          className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-gdc-mutedStrong">
          <Activity className="h-3.5 w-3.5" aria-hidden />
          {fresh ? 'Current snapshot' : 'Last reported / unknown freshness'} · {routeCount} paths ·
          {' '}{streams.length} Streams with Routes
        </p>
      </div>
      <RuntimeFlowTopology snapshot={snapshot} selectedStreamId={selected.stream_id} requestFailed={requestFailed} />
    </section>
  )
}
