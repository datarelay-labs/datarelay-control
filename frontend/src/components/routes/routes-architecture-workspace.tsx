import { ArrowRight, GitBranch, Layers3, Network, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import {
  destinationDetailPath,
  logsExplorerPath,
  routeEditPath,
  streamRuntimePath,
  newStreamPath,
  NAV_PATH,
} from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { useSessionCapabilities } from '../../lib/rbac'
import {
  buildRouteFlowTree,
  formatFlowEps,
  isRouteSnapshotStale,
  listRouteFlowAttention,
  formatFlowSuccessRate,
  routeHealthBadgeClass,
  routePublicId,
} from './routes-flow-helpers'
import { formatFailurePolicy, uiStatusFromOperationalHealth, type RouteConsoleRow } from './routes-overview-helpers'

export type RoutesArchitectureWorkspaceProps = {
  snapshot: OperationalSnapshotResponse | null
  consoleRows: readonly RouteConsoleRow[]
  loading?: boolean
  requestFailed?: boolean
  selectedStreamId: number | null
  onSelectStream: (id: number) => void
}

const validId = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * Route ownership, not another Stream creation flow:
 * Streams collect; each route processes and delivers to one Destination.
 * Read-only topology from the existing operational snapshot. No invented edges.
 */
export function RoutesArchitectureWorkspace({
  snapshot,
  consoleRows,
  loading = false,
  requestFailed = false,
  selectedStreamId,
  onSelectStream,
}: RoutesArchitectureWorkspaceProps) {
  const canCreateFlow = useSessionCapabilities().workspace_mutations === true
  const groups = useMemo(() => buildRouteFlowTree(snapshot, consoleRows), [snapshot, consoleRows])
  const selectedGroup = groups.find((group) => group.streamId === selectedStreamId) ?? groups[0]
  const [inspectedRouteId, setInspectedRouteId] = useState<number | null>(null)
  const selectedRoute = selectedGroup?.routes.find((route) => route.routeId === inspectedRouteId) ??
    selectedGroup?.routes[0]
  const selectedRow = consoleRows.find((row) => row.route.id === selectedRoute?.routeId)
  const inspectedMetric = snapshot?.routes.find((route) =>
    route.route_id === selectedRoute?.routeId && route.stream_id === selectedGroup?.streamId)
  const receivingDestination = snapshot?.destinations.find((destination) =>
    destination.destination_id === selectedRoute?.destinationId)
  const receivingDestinationHealth = receivingDestination
    ? uiStatusFromOperationalHealth(receivingDestination.health_status, receivingDestination.enabled)
    : null
  const evidenceStale = requestFailed || isRouteSnapshotStale(snapshot?.updated_at)
  // An empty graph is not proof of a fresh installation: the Route list may
  // be incomplete while a healthy Stream exists, or the read may be stale.
  const verifiedEmptyRoutes = !loading && !evidenceStale &&
    snapshot?.global?.total_routes === 0 && snapshot.routes.length === 0
  const verifiedNoStreams = verifiedEmptyRoutes &&
    snapshot?.global?.total_streams === 0 && snapshot.streams.length === 0
  const verifiedExistingStreams = verifiedEmptyRoutes &&
    Number.isSafeInteger(snapshot?.global?.total_streams) &&
    (snapshot?.global?.total_streams ?? 0) > 0 &&
    snapshot?.streams.some((stream) => validId(stream.stream_id)) === true
  const attention = useMemo(() => listRouteFlowAttention(groups), [groups])
  const [visibleAttentionCount, setVisibleAttentionCount] = useState(4)
  const [visiblePathCount, setVisiblePathCount] = useState(12)
  const [visibleStreamCount, setVisibleStreamCount] = useState(12)
  const [streamQuery, setStreamQuery] = useState('')
  const normalizedStreamQuery = streamQuery.trim().toLocaleLowerCase()
  const matchingStreams = normalizedStreamQuery
    ? groups.filter((group) =>
        group.streamName.toLocaleLowerCase().includes(normalizedStreamQuery) ||
        String(group.streamId).includes(normalizedStreamQuery))
    : groups
  const firstStreams = matchingStreams.slice(0, visibleStreamCount)
  const allStreamsVisible = visibleStreamCount >= matchingStreams.length
  // A selected low-throughput Stream must remain discoverable when the
  // topology has many higher-throughput Streams, without rendering them all.
  const visibleStreams = !normalizedStreamQuery && selectedGroup &&
    !firstStreams.some((group) => group.streamId === selectedGroup.streamId)
    ? [...firstStreams, selectedGroup]
    : firstStreams
  const attentionVisible = attention.slice(0, visibleAttentionCount)
  const allAttentionVisible = visibleAttentionCount >= attention.length
  // Keep the selected Route visible without forcing hundreds of unrelated
  // paths into the DOM when an operator reviews a deep/low-throughput issue.
  const firstPaths = selectedGroup?.routes.slice(0, visiblePathCount) ?? []
  const allPathsVisible = selectedGroup != null && visiblePathCount >= selectedGroup.routes.length
  const visiblePaths = selectedRoute && !firstPaths.some((route) => route.routeId === selectedRoute.routeId)
    ? [...firstPaths, selectedRoute]
    : firstPaths
  const disabledPaths = groups.reduce((total, group) => total + group.routes.filter((route) => !route.enabled).length, 0)
  const connectedRouteCount = groups.reduce((total, group) => total + group.routes.length, 0)
  const reportedStreamCount = snapshot?.global?.total_streams
  const streamCounterConsistent = Number.isSafeInteger(reportedStreamCount) &&
    reportedStreamCount! >= Math.max(groups.length, snapshot?.streams.length ?? 0)
  const reportedRouteCount = snapshot?.global?.total_routes
  const routeCounterConsistent = Number.isSafeInteger(reportedRouteCount) &&
    reportedRouteCount! >= Math.max(connectedRouteCount, snapshot?.routes.length ?? 0)
  const streamCountSummary = streamCounterConsistent
    ? `${reportedStreamCount} total Streams`
    : 'Stream count not verified'
  const routeCountSummary = !routeCounterConsistent
    ? 'Route count not verified'
    : reportedRouteCount === connectedRouteCount
      ? `${reportedRouteCount} Routes`
      : `${reportedRouteCount} reported Routes (${connectedRouteCount} shown)`

  function reviewAttention(item: (typeof attention)[number]) {
    // Numeric Route and Stream IDs prevent same-name entities from leaking into each other's inspector.
    setInspectedRouteId(item.routeId)
    setVisiblePathCount(12)
    setVisibleStreamCount(12)
    setStreamQuery('')
    onSelectStream(item.streamId)
  }

  return (
    <section
      data-testid="routes-architecture-workspace"
      aria-label="Delivery architecture"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 bg-gradient-to-r from-slate-50 via-white to-violet-50/50 px-4 py-3.5 dark:border-gdc-border dark:from-gdc-panel dark:via-gdc-card dark:to-gdc-card sm:px-6">
        <div className="space-y-2">
          <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-violet-700 dark:text-violet-300">
            <Network className="h-4 w-4" aria-hidden /> Delivery workspace
          </p>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50 sm:text-xl">
            Delivery architecture
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">
            Follow a Stream through its Routes to the receiving Destinations. Review paths that need
            attention, or select any Route for details; collection setup stays in Streams.
          </p>
        </div>
        <span data-testid="routes-architecture-count-summary" className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200">
          {snapshot
            ? `${streamCountSummary} · ${groups.length} with Routes · ${routeCountSummary} · ${evidenceStale ? 'Stale snapshot' : 'Snapshot received'}`
            : 'Runtime snapshot unavailable'}
        </span>
      </div>

      <details className="border-b border-slate-200/80 px-5 py-2 dark:border-gdc-border sm:px-6" data-testid="routes-mental-model">
        <summary className="cursor-pointer py-1 text-xs font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 dark:text-violet-300">
          How delivery paths work
        </summary>
        <p className="pb-2 pt-1 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
          <strong className="text-slate-800 dark:text-slate-100">Stream</strong> collects data →
          <strong className="text-slate-800 dark:text-slate-100"> Route Processing</strong> applies destination-specific rules →
          <strong className="text-slate-800 dark:text-slate-100"> Destination</strong> receives the result.
          One Stream can fan out through many Routes to many Destinations without collecting the same source twice.
        </p>
      </details>

      {snapshot && groups.length > 0 ? (
        <section
          aria-label="Route delivery attention"
          data-testid="routes-architecture-attention"
          className="space-y-2 border-b border-slate-200/80 bg-white px-4 py-3 dark:border-gdc-border dark:bg-gdc-card sm:px-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Delivery attention</h3>
              <p className="mt-0.5 text-xs text-slate-600 dark:text-gdc-mutedStrong">
                {evidenceStale ? 'Last reported Route conditions · snapshot stale or fetch failed' : 'Route warnings and errors from the current snapshot'}
                {' · '}{attention.length} need attention
                {' · '}{disabledPaths} disabled
              </p>
            </div>
            {attention.length > 0 ? (
              <button
                type="button"
                onClick={() => reviewAttention(attention[0]!)}
                data-testid="routes-architecture-review-first"
                className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
              >
                Review highest priority <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : (
              <span className="text-xs text-slate-500 dark:text-gdc-muted">
                No Route errors or warnings reported; receiver ingestion is not thereby verified.
              </span>
            )}
          </div>
          {attention.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="routes-architecture-issue-list">
              {attentionVisible.map((item) => (
                <button
                  key={item.routeId}
                  type="button"
                  onClick={() => reviewAttention(item)}
                  aria-label={`Inspect ${item.status} Route ${routePublicId(item.routeId)} in Stream #${item.streamId}`}
                  className={cn(
                    'inline-flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500',
                    item.status === 'Error'
                      ? 'border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200'
                      : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
                  )}
                >
                  <span>{evidenceStale ? 'Last reported ' : ''}{item.status}</span>
                  <span className="truncate font-medium">{item.streamName} #{item.streamId} · {routePublicId(item.routeId)} → {item.destinationName}</span>
                </button>
              ))}
              {attention.length > 4 ? (
                <button
                  type="button"
                  aria-expanded={allAttentionVisible}
                  onClick={() => setVisibleAttentionCount((current) => current >= attention.length ? 4 : Math.min(attention.length, current + 20))}
                  className="min-h-9 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-violet-300"
                >
                  {allAttentionVisible
                    ? 'Show fewer issues'
                    : attention.length <= 24
                      ? `Show all ${attention.length} issues`
                      : `Show next issues (${attentionVisible.length} of ${attention.length} shown)`}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {!snapshot ? (
        <div className="px-6 py-12 text-center text-sm text-slate-600 dark:text-gdc-muted" role="status">
          {loading ? 'Loading current delivery connections…' : 'The operational snapshot is unavailable. Refresh before trusting Route status or topology.'}
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="routes-architecture-empty-state">
          <GitBranch className="h-8 w-8 text-slate-400" aria-hidden />
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {verifiedNoStreams
              ? 'Start your first Data Flow'
              : verifiedExistingStreams
                ? 'No Route delivery paths configured'
                : 'Route inventory not verified'}
          </h3>
          <p className="max-w-lg text-sm text-slate-600 dark:text-gdc-muted">
            {verifiedNoStreams
              ? canCreateFlow
                ? 'No Streams or Routes are configured in this verified snapshot. Start with a Source, sample its events, select Destinations, configure Route Processing, then deploy.'
                : 'No Streams or Routes are configured in this verified snapshot. Creating a Data Flow requires workspace write access; ask an administrator for access.'
              : verifiedExistingStreams
                ? canCreateFlow
                  ? 'Streams already exist, but none of their Routes are configured. Create a Route for an existing Stream and Destination without duplicating collection.'
                  : 'Streams exist, but there are no configured delivery Routes. Creating a Route requires workspace write access.'
                : 'Current Stream and Route inventory cannot be confirmed. Refresh the snapshot or review the Streams catalog before attempting creation.'}
          </p>
          {canCreateFlow && verifiedNoStreams ? (
            <Link to={newStreamPath()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
              Start a Data Flow <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : canCreateFlow && verifiedExistingStreams ? (
            <Link to={routeEditPath('new')} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
              Create Route <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          ) : (
            <Link to={NAV_PATH.streams} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:border-gdc-border dark:text-violet-300">
              View Streams <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
      ) : (
        <div className="grid min-w-0 xl:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Choose a Stream for delivery" className="border-b border-slate-200/80 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section/40 xl:border-b-0 xl:border-r">
            <p className="px-2 pb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-gdc-muted">
              Streams with Routes
            </p>
            <label className="mb-2 block px-2">
              <span className="sr-only">Find Stream by name or ID</span>
              <input
                type="search"
                aria-label="Find Stream by name or ID"
                value={streamQuery}
                onChange={(event) => { setStreamQuery(event.target.value); setVisibleStreamCount(12) }}
                placeholder="Find Stream…"
                className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              />
            </label>
            <p role="status" className="px-2 pb-2 text-[11px] text-slate-500 dark:text-gdc-muted">
              {visibleStreams.length} of {matchingStreams.length} matching Streams shown
              {normalizedStreamQuery ? ` · filtered from ${groups.length}` : ''}
            </p>
            <div id="routes-architecture-stream-list" className="flex gap-2 overflow-x-auto pb-1 xl:max-h-[420px] xl:flex-col xl:overflow-x-hidden xl:overflow-y-auto">
              {visibleStreams.map((group) => {
                const selected = selectedGroup?.streamId === group.streamId
                return (
                  <button
                    key={group.streamId}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Inspect delivery for ${group.streamName} (Stream #${group.streamId})`}
                    data-testid={`routes-architecture-stream-${group.streamId}`}
                    onClick={() => { setInspectedRouteId(null); setVisiblePathCount(12); setVisibleStreamCount(12); onSelectStream(group.streamId) }}
                    className={cn(
                      'flex min-w-[160px] flex-1 items-center justify-between gap-3 rounded-lg border px-3 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 xl:min-w-0 xl:flex-none',
                      selected
                        ? 'border-violet-400 bg-white shadow-sm dark:border-violet-500/60 dark:bg-violet-500/10'
                        : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-white/80 dark:hover:border-gdc-border dark:hover:bg-gdc-card',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-slate-900 dark:text-slate-100" title={group.streamName}>
                        {group.streamName}
                      </span>
                      <span className="mt-1 block text-[11px] text-slate-500 dark:text-gdc-muted">
                        #{group.streamId} · {group.routes.length} route{group.routes.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    <ChevronIndicator selected={selected} />
                  </button>
                )
              })}
            </div>
            {matchingStreams.length === 0 ? (
              <p className="px-2 py-3 text-xs text-slate-600 dark:text-gdc-mutedStrong">
                No matching Streams. Search by display name or numeric Stream ID.
              </p>
            ) : null}
            {matchingStreams.length > 12 ? (
              <button
                type="button"
                aria-expanded={visibleStreamCount > 12}
                aria-controls="routes-architecture-stream-list"
                data-testid="routes-architecture-show-streams"
                onClick={() => setVisibleStreamCount((current) =>
                  current >= matchingStreams.length ? 12 : Math.min(matchingStreams.length, current + 20))}
                className="mt-2 min-h-10 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-violet-300 dark:hover:bg-gdc-card"
              >
                {allStreamsVisible
                  ? 'Show fewer Streams'
                  : matchingStreams.length <= 32
                    ? `Show all ${matchingStreams.length} Streams`
                    : `Show next Streams (${visibleStreams.length} of ${matchingStreams.length} shown)`}
              </button>
            ) : null}
          </nav>

          {selectedGroup ? (
            <div className="min-w-0 space-y-5 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{selectedGroup.streamName}</h3>
                  <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">One collection path · {selectedGroup.routes.length} delivery connection{selectedGroup.routes.length === 1 ? '' : 's'}</p>
                </div>
                <Link to={streamRuntimePath(String(selectedGroup.streamId))} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-violet-300 hover:text-violet-700 dark:border-gdc-border dark:text-slate-200 dark:hover:text-violet-300">
                  View Stream runtime <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </div>

              <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(250px,1fr)]">
              <div className="grid min-w-0 items-start gap-4 sm:grid-cols-[minmax(120px,0.75fr)_minmax(0,2fr)]" data-testid="routes-architecture-graph">
                <div className="relative rounded-xl border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-500/30 dark:bg-violet-500/5">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-violet-700 dark:text-violet-300">
                    01 · Collection
                  </p>
                  <p className="mt-3 text-[11px] leading-5 text-slate-600 dark:text-gdc-mutedStrong">
                    Source access: {selectedGroup.connectorId != null ? `Connector #${selectedGroup.connectorId}` : 'Connector not resolved'}
                    {selectedGroup.sourceId != null ? ` · Source #${selectedGroup.sourceId}` : ''}
                  </p>
                  <Layers3 className="mt-3 h-6 w-6 text-violet-600 dark:text-violet-300" aria-hidden />
                  <p className="mt-3 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {selectedGroup.streamName}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-mutedStrong">Stream #{selectedGroup.streamId}</p>
                  <p className="mt-4 text-xs text-slate-600 dark:text-gdc-mutedStrong">
                    Source ingest: <strong className="font-semibold text-slate-800 dark:text-slate-200">{formatFlowEps(selectedGroup.totalEps)}</strong>
                  </p>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-gdc-muted">
                    Source setup, schedules, and checkpoints belong to Streams.
                  </p>
                </div>

                <div className="min-w-0">
                  <div className="grid grid-cols-2 gap-3 px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-gdc-muted">
                    <p>02 · Route Processing</p>
                    <p>03 · Destination</p>
                  </div>
                  <ol id="routes-architecture-delivery-paths" aria-label={`Delivery paths from ${selectedGroup.streamName} (Stream #${selectedGroup.streamId})`} className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
                    {visiblePaths.map((route) => {
                      const selected = route.routeId === selectedRoute?.routeId
                      const hasDestination = validId(route.destinationId)
                      return (
                        <li key={route.routeId} className={cn('min-w-0', !route.enabled && 'opacity-65')}>
                          <div className="grid min-w-0 grid-cols-1 items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)]">
                            <button
                              type="button"
                              aria-pressed={selected}
                              aria-controls="routes-architecture-inspector-panel"
                              onClick={() => setInspectedRouteId(route.routeId)}
                              data-testid={`routes-architecture-route-${route.routeId}`}
                              className={cn(
                                'min-w-0 rounded-xl border px-3 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500',
                                selected
                                  ? 'border-violet-400 bg-violet-50 shadow-sm dark:border-violet-500/60 dark:bg-violet-500/10'
                                  : 'border-slate-200 bg-slate-50/60 hover:border-violet-300 dark:border-gdc-border dark:bg-gdc-section dark:hover:border-violet-500/40',
                              )}
                            >
                              <span className="flex flex-wrap items-center justify-between gap-1.5">
                                <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                  Route {routePublicId(route.routeId)}
                                </span>
                                <span className={cn(
                                  'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                                  !route.enabled
                                    ? routeHealthBadgeClass('Disabled')
                                    : !hasDestination
                                      ? routeHealthBadgeClass('Idle')
                                      : evidenceStale
                                        ? 'border-amber-400/70 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200'
                                        : routeHealthBadgeClass(route.health),
                                )}>
                                  {!route.enabled ? 'Disabled' : !hasDestination ? 'Not verified' : evidenceStale ? 'Stale' : route.health}
                                </span>
                              </span>
                              <span className="mt-1.5 block text-[11px] text-slate-500 dark:text-gdc-mutedStrong">
                                {!route.enabled
                                  ? 'Delivery path disabled'
                                  : !hasDestination
                                    ? 'Destination unresolved · delivery not verified'
                                    : 'Delivery path enabled'} · {formatFlowEps(route.eps)}
                              </span>
                            </button>
                            <span className="flex h-6 items-center justify-center text-slate-400 dark:text-gdc-muted" aria-hidden>
                              <ArrowRight className="h-4 w-4 rotate-90 sm:rotate-0" />
                            </span>
                            {hasDestination ? (
                              <Link
                                to={destinationDetailPath(String(route.destinationId))}
                                data-testid={`routes-architecture-destination-${route.destinationId}`}
                                className="flex min-h-[76px] min-w-0 flex-col justify-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 transition hover:border-violet-400 hover:bg-violet-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:hover:border-violet-500/50"
                              >
                                <span className="break-words text-xs font-semibold text-slate-900 dark:text-slate-100">{route.destinationName}</span>
                                <span className="text-[11px] text-slate-500 dark:text-gdc-muted">Destination #{route.destinationId} · Open details</span>
                              </Link>
                            ) : (
                              <div className="flex min-h-[76px] items-center rounded-xl border border-dashed border-amber-400/60 bg-amber-50/50 px-3 text-xs font-medium text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                                Destination not resolved
                              </div>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                  {selectedGroup.routes.length > 12 ? (
                    <button
                      type="button"
                      onClick={() => setVisiblePathCount((current) =>
                        current >= selectedGroup.routes.length ? 12 : Math.min(selectedGroup.routes.length, current + 20))}
                      aria-expanded={visiblePathCount > 12}
                      aria-controls="routes-architecture-delivery-paths"
                      data-testid="routes-architecture-show-paths"
                      className="mt-2 w-full min-h-9 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-violet-300 dark:hover:bg-gdc-rowHover"
                    >
                      {allPathsVisible
                        ? 'Show fewer delivery paths'
                        : selectedGroup.routes.length <= 32
                          ? `Show all ${selectedGroup.routes.length} delivery paths (${visiblePaths.length} shown)`
                          : `Show next delivery paths (${visiblePaths.length} of ${selectedGroup.routes.length} shown)`}
                    </button>
                  ) : null}
                  {visiblePathCount > 12 && !allPathsVisible ? (
                    <button
                      type="button"
                      data-testid="routes-architecture-show-fewer"
                      onClick={() => setVisiblePathCount(12)}
                      className="mt-2 w-full min-h-9 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:text-gdc-mutedStrong"
                    >
                      Show fewer delivery paths
                    </button>
                  ) : null}
                </div>
              </div>

              {selectedRoute ? (
                <section id="routes-architecture-inspector-panel" data-testid="routes-architecture-inspector" aria-label="Selected Route details" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-gdc-border dark:bg-gdc-section/60">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500 dark:text-gdc-muted">Selected delivery path</p>
                      <h4 aria-live="polite" className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Stream #{selectedGroup.streamId} · Route {routePublicId(selectedRoute.routeId)} · {selectedRoute.destinationName}
                      </h4>
                      <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
                        This Route owns destination-specific Transform, Protection, Policy and delivery settings.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link to={routeEditPath(String(selectedRoute.routeId))} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">
                        <Settings2 className="h-3.5 w-3.5" aria-hidden /> Route settings
                      </Link>
                      <Link to={logsExplorerPath({ route_id: selectedRoute.routeId })} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-violet-300 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100">
                        Delivery logs <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </div>
                  </div>
                  {evidenceStale ? (
                    <p role="status" className="mt-3 rounded-lg border border-amber-400/50 bg-amber-50 p-2 text-xs font-medium text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                      Stale or unavailable snapshot. Values below are last reported, not confirmed current health.
                    </p>
                  ) : null}
                  <dl className="mt-4 grid gap-3 border-t border-slate-200/80 pt-4 sm:grid-cols-2 dark:border-gdc-border">
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Route health</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {!selectedRoute.enabled
                          ? (evidenceStale ? 'Stale · last reported Disabled' : 'Disabled')
                          : !validId(selectedRoute.destinationId)
                            ? 'Not verified · Destination unresolved'
                            : evidenceStale
                              ? `Stale · last reported ${selectedRoute.health}`
                              : selectedRoute.health}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Destination health (snapshot)</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {receivingDestinationHealth
                          ? evidenceStale
                            ? `Stale · last reported ${receivingDestinationHealth}`
                            : receivingDestinationHealth
                          : 'Not verified by this snapshot'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Route output (1m, gateway-reported)</dt>
                      <dd className="mt-1 text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatFlowEps(selectedRoute.eps)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Delivery success (5m)</dt>
                      <dd className="mt-1 text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatFlowSuccessRate(selectedRoute.successRatePct)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Failed output (1m)</dt>
                      <dd className="mt-1 text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatFlowEps(inspectedMetric?.failed_eps_1m)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Retry rate (5m)</dt>
                      <dd className="mt-1 text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">{formatFlowSuccessRate(inspectedMetric?.retry_rate_5m)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Average latency</dt>
                      <dd className="mt-1 text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-100">{Number.isFinite(inspectedMetric?.avg_latency_ms) ? `${inspectedMetric!.avg_latency_ms} ms` : 'Not available'}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Receiver-confirmed ingestion</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">Not verified by this snapshot</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Destination capacity</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">Not available in snapshot</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-slate-500 dark:text-gdc-muted">Failure policy</dt>
                      <dd className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                        {selectedRow?.route.failure_policy ? formatFailurePolicy(selectedRow.route.failure_policy) : 'Not available'}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[11px] leading-5 text-slate-500 dark:text-gdc-muted">
                    Health and rates reflect the latest operational snapshot, not receiver acknowledgment. Use the Route editor for configuration and delivery logs for observed outcomes.
                  </p>
                </section>
              ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

function ChevronIndicator({ selected }: { selected: boolean }) {
  return (
    <ArrowRight className={cn('h-3.5 w-3.5 shrink-0', selected ? 'text-violet-700 dark:text-violet-300' : 'text-slate-400')} aria-hidden />
  )
}
