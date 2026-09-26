import { Loader2, RefreshCw, Shield } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  fetchGovernanceWorkspaceSnapshot,
  type GovernanceWorkspaceSnapshot,
} from '../../api/gdcGovernanceWorkspaceSnapshot'
import { fetchRoutesList, type RouteRead } from '../../api/gdcRoutes'
import { fetchStreamsList } from '../../api/gdcStreams'
import { mapBackendStreamStatus } from '../../api/streamRows'
import type { StreamRead } from '../../api/types/gdcApi'
import {
  resolveGovernanceWorkspaceContext,
  type GovernanceWorkspaceContext,
} from '../../lib/governance-workspace-context'
import {
  buildStreamGovernanceSummary,
  type GovernanceProcessingStatus,
  type RouteGovernanceSnapshot,
  type StreamGovernanceSummary,
} from '../../lib/governance-workspace-summary'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { StatusBadge, type StatusTone } from '../shell/status-badge'

type ProcessingStatus = GovernanceProcessingStatus

function processingTone(status: ProcessingStatus | null): StatusTone {
  if (status === 'Overridden' || status === 'Mixed') return 'warning'
  if (status === 'Inherited') return 'neutral'
  return 'neutral'
}

function streamStatusTone(status: string): StatusTone {
  switch (status) {
    case 'RUNNING':
      return 'success'
    case 'DEGRADED':
      return 'warning'
    case 'ERROR':
      return 'error'
    case 'STOPPED':
      return 'neutral'
    default:
      return 'neutral'
  }
}

function ProcessingStatusBadge({ status }: { status: ProcessingStatus | null }) {
  if (!status) return <span className="text-slate-400">—</span>
  return (
    <StatusBadge tone={processingTone(status)} data-testid={`governance-workspace-status-${status.toLowerCase()}`}>
      {status}
    </StatusBadge>
  )
}

function routeSnapshotsFromWorkspace(
  snapshot: GovernanceWorkspaceSnapshot,
  streamRoutes: RouteRead[],
): RouteGovernanceSnapshot[] {
  const nameById = new Map<number, string>()
  for (const route of streamRoutes) {
    nameById.set(route.id, route.name?.trim() || `Route #${route.id}`)
  }
  return snapshot.routes.map((row) => ({
    routeId: row.route_id,
    routeName: nameById.get(row.route_id) ?? row.route_name,
    transform: row.transform?.processing_status ?? null,
    protection: row.protection?.processing_status ?? null,
    classification: row.classification?.processing_status ?? null,
    policy: row.policy?.processing_status ?? null,
    transformEffective: row.transform ?? null,
    protectionEffective: row.protection ?? null,
    classificationEffective: row.classification ?? null,
    policyEffective: row.policy ?? null,
  }))
}

function SummaryCard({
  title,
  primaryLabel,
  primaryValue,
  secondaryLabel,
  secondaryValue,
  testId,
}: {
  title: string
  primaryLabel: string
  primaryValue: number
  secondaryLabel: string
  secondaryValue: number
  testId: string
}) {
  return (
    <div
      className="rounded-lg border border-slate-200/80 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section"
      data-testid={testId}
    >
      <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">{title}</p>
      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500 dark:text-gdc-muted">{primaryLabel}</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">{primaryValue}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500 dark:text-gdc-muted">{secondaryLabel}</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">{secondaryValue}</dd>
        </div>
      </dl>
    </div>
  )
}

export function GovernanceWorkspacePage() {
  const [searchParams] = useSearchParams()
  const queryKey = searchParams.toString()
  const [loading, setLoading] = useState(true)
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [routesByStream, setRoutesByStream] = useState<Record<number, RouteRead[]>>({})
  const [snapshotsByStream, setSnapshotsByStream] = useState<Record<number, RouteGovernanceSnapshot[]>>({})
  const [selectedStreamId, setSelectedStreamId] = useState<number | null>(null)
  const [context, setContext] = useState<GovernanceWorkspaceContext>({ kind: 'none' })
  const snapshotsLoadGenRef = useRef(0)
  const snapshotsAbortRef = useRef<AbortController | null>(null)
  const manualSelectionRef = useRef(false)
  const appliedQueryKeyRef = useRef<string | null>(null)

  const loadSnapshotsForStream = useCallback(async (streamId: number, streamRoutes: RouteRead[]) => {
    const gen = ++snapshotsLoadGenRef.current
    snapshotsAbortRef.current?.abort()
    const abort = new AbortController()
    snapshotsAbortRef.current = abort
    setSnapshotsLoading(true)
    try {
      if (!streamRoutes.length) {
        if (gen !== snapshotsLoadGenRef.current) return
        setSnapshotsByStream((prev) => ({ ...prev, [streamId]: [] }))
        return
      }
      setSnapshotsByStream((prev) => ({ ...prev, [streamId]: [] }))
      const snapshot = await fetchGovernanceWorkspaceSnapshot(streamId, { signal: abort.signal })
      if (gen !== snapshotsLoadGenRef.current) return
      if (snapshot == null) {
        setError('Failed to load governance workspace snapshot')
        return
      }
      setSnapshotsByStream((prev) => ({
        ...prev,
        [streamId]: routeSnapshotsFromWorkspace(snapshot, streamRoutes),
      }))
    } catch (e) {
      if (abort.signal.aborted) return
      if (gen !== snapshotsLoadGenRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === snapshotsLoadGenRef.current) {
        setSnapshotsLoading(false)
      }
    }
  }, [])

  const load = useCallback(async () => {
    snapshotsLoadGenRef.current += 1
    snapshotsAbortRef.current?.abort()
    setLoading(true)
    setSnapshotsLoading(false)
    setError(null)
    setSnapshotsByStream({})
    const params = new URLSearchParams(queryKey)
    if (appliedQueryKeyRef.current !== queryKey) {
      appliedQueryKeyRef.current = queryKey
      manualSelectionRef.current = false
    }
    try {
      const [streamRows, allRoutes] = await Promise.all([fetchStreamsList(), fetchRoutesList()])
      if (streamRows == null || allRoutes == null) {
        setStreams([])
        setRoutesByStream({})
        setSelectedStreamId(null)
        setContext({ kind: 'none' })
        setError('Failed to load governance workspace')
        return
      }
      const sortedStreams = [...streamRows].sort((a, b) => {
        const aName = a.name?.trim() || `Stream #${a.id}`
        const bName = b.name?.trim() || `Stream #${b.id}`
        return aName.localeCompare(bName)
      })
      setStreams(sortedStreams)

      const routes = allRoutes
      const grouped: Record<number, RouteRead[]> = {}
      for (const route of routes) {
        if (route.stream_id == null) continue
        const bucket = grouped[route.stream_id] ?? []
        bucket.push(route)
        grouped[route.stream_id] = bucket
      }
      setRoutesByStream(grouped)

      const resolved = resolveGovernanceWorkspaceContext(params, sortedStreams, routes)
      setContext(resolved)
      const preferredId = resolved.kind === 'matched' ? resolved.streamId : sortedStreams[0]?.id ?? null
      setSelectedStreamId((prev) => {
        if (manualSelectionRef.current && prev != null && sortedStreams.some((stream) => stream.id === prev)) return prev
        return preferredId
      })
    } catch (e) {
      setStreams([])
      setRoutesByStream({})
      setSelectedStreamId(null)
      setContext({ kind: 'none' })
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [queryKey])

  useEffect(() => {
    void load()
    return () => {
      snapshotsAbortRef.current?.abort()
    }
  }, [load])

  useEffect(() => {
    if (selectedStreamId == null) return
    if (snapshotsByStream[selectedStreamId] !== undefined) return
    const streamRoutes = routesByStream[selectedStreamId]
    if (streamRoutes == null) return
    void loadSnapshotsForStream(selectedStreamId, streamRoutes)
  }, [selectedStreamId, routesByStream, snapshotsByStream, loadSnapshotsForStream])

  const selectedSnapshots = selectedStreamId != null ? snapshotsByStream[selectedStreamId] ?? [] : []
  const selectedStream = streams.find((stream) => stream.id === selectedStreamId) ?? null
  const summary: StreamGovernanceSummary | null = useMemo(
    () => (selectedSnapshots.length > 0 ? buildStreamGovernanceSummary(selectedSnapshots) : null),
    [selectedSnapshots],
  )

  const routeCountForStream = selectedStreamId != null ? routesByStream[selectedStreamId]?.length ?? 0 : 0
  const activeContext =
    context.kind === 'matched' && selectedStreamId === context.streamId ? context : null
  const focusedRouteId = activeContext?.routeId ?? null

  useEffect(() => {
    if (focusedRouteId == null) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid="governance-workspace-route-row-${focusedRouteId}"]`,
    )
    if (row?.getAttribute('data-context-focus') !== 'route') return
    row.scrollIntoView?.({ block: 'nearest' })
    row.focus()
  }, [focusedRouteId, selectedSnapshots])

  return (
    <section
      className="space-y-3"
      aria-label="Governance Workspace"
      data-testid="governance-workspace-page"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Shield className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
            Governance Workspace
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
            Read-only overview of stream and route governance configuration — protection, classification, policy, and transform inheritance.
          </p>
          {activeContext ? (
            <p
              className="mt-2 text-[12px] font-semibold text-violet-800 dark:text-violet-200"
              data-testid="governance-workspace-active-context"
            >
              Governance context: {activeContext.streamName}
              {activeContext.routeName ? ` · ${activeContext.routeName}` : ''}
            </p>
          ) : context.kind === 'unavailable' ? (
            <p
              className="mt-2 text-[12px] font-medium text-amber-800 dark:text-amber-200"
              data-testid="governance-workspace-context-fallback"
              role="status"
            >
              Requested governance context is not available. Showing the workspace without that context.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <p className="text-[11px] text-red-700 dark:text-red-300" role="alert">{error}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <aside
          className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card xl:col-span-3"
          data-testid="governance-workspace-streams-panel"
        >
          <h2 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Streams</h2>
          <div className="mt-2 overflow-x-auto">
            <table className={opTable}>
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Stream Name</th>
                  <th className={opTh}>Status</th>
                  <th className={opTh}>Route Count</th>
                </tr>
              </thead>
              <tbody>
                {loading && streams.length === 0 ? (
                  <tr className={opTr}>
                    <td className={cn(opTd, 'text-slate-500')} colSpan={3}>Loading streams…</td>
                  </tr>
                ) : streams.length === 0 ? (
                  <tr className={opTr}>
                    <td className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')} colSpan={3}>No streams found.</td>
                  </tr>
                ) : (
                  streams.map((stream) => {
                    const status = mapBackendStreamStatus(stream.status)
                    const routeCount = routesByStream[stream.id]?.length ?? 0
                    const isSelected = stream.id === selectedStreamId
                    return (
                      <tr
                        key={stream.id}
                        className={cn(opTr, isSelected && 'bg-violet-500/[0.04] dark:bg-violet-500/10')}
                        data-testid={`governance-workspace-stream-row-${stream.id}`}
                      >
                        <td className={opTd}>
                          <button
                            type="button"
                            onClick={() => {
                              manualSelectionRef.current = true
                              setSelectedStreamId(stream.id)
                            }}
                            className={cn(
                              'text-left text-[12px] font-semibold hover:text-violet-700 dark:hover:text-violet-300',
                              isSelected ? 'text-violet-700 dark:text-violet-300' : 'text-slate-900 dark:text-slate-100',
                            )}
                          >
                            {stream.name?.trim() || `Stream #${stream.id}`}
                          </button>
                        </td>
                        <td className={opTd}>
                          <StatusBadge tone={streamStatusTone(status)}>{status}</StatusBadge>
                        </td>
                        <td className={opTd}>{routeCount}</td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </aside>

        <div
          className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card xl:col-span-4"
          data-testid="governance-workspace-summary-panel"
        >
          <h2 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">
            Selected Stream Governance Summary
          </h2>
          {selectedStream ? (
            <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
              {selectedStream.name?.trim() || `Stream #${selectedStream.id}`}
            </p>
          ) : null}
          {loading && !summary && snapshotsLoading ? (
            <p className="mt-3 text-[11px] text-slate-500">Loading summary…</p>
          ) : !selectedStream ? (
            <p className="mt-3 text-[11px] text-slate-500 dark:text-gdc-muted">Select a stream to view governance summary.</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <SummaryCard
                title="Protection"
                primaryLabel="Stream Rules Count"
                primaryValue={summary?.protection.streamRulesCount ?? 0}
                secondaryLabel="Route Override Count"
                secondaryValue={summary?.protection.routeOverrideCount ?? 0}
                testId="governance-workspace-summary-protection"
              />
              <SummaryCard
                title="Classification"
                primaryLabel="Stream Rules Count"
                primaryValue={summary?.classification.streamRulesCount ?? 0}
                secondaryLabel="Route Override Count"
                secondaryValue={summary?.classification.routeOverrideCount ?? 0}
                testId="governance-workspace-summary-classification"
              />
              <SummaryCard
                title="Policy"
                primaryLabel="Stream Rules Count"
                primaryValue={summary?.policy.streamRulesCount ?? 0}
                secondaryLabel="Route Override Count"
                secondaryValue={summary?.policy.routeOverrideCount ?? 0}
                testId="governance-workspace-summary-policy"
              />
              <SummaryCard
                title="Routes"
                primaryLabel="Route Count"
                primaryValue={summary?.routes.routeCount ?? routeCountForStream}
                secondaryLabel="Overridden Routes Count"
                secondaryValue={summary?.routes.overriddenRoutesCount ?? 0}
                testId="governance-workspace-summary-routes"
              />
            </div>
          )}
        </div>

        <div
          className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card xl:col-span-5"
          data-testid="governance-workspace-routes-panel"
        >
          <h2 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Route Governance Overview</h2>
          <div className="mt-2 overflow-x-auto">
            <table className={opTable} data-testid="governance-workspace-routes-table">
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Route</th>
                  <th className={opTh}>Transform</th>
                  <th className={opTh}>Protection</th>
                  <th className={opTh}>Classification</th>
                  <th className={opTh}>Policy</th>
                </tr>
              </thead>
              <tbody>
                {snapshotsLoading && selectedSnapshots.length === 0 ? (
                  <tr className={opTr}>
                    <td className={cn(opTd, 'text-slate-500')} colSpan={5}>Loading routes…</td>
                  </tr>
                ) : selectedStreamId == null ? (
                  <tr className={opTr}>
                    <td className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')} colSpan={5}>Select a stream.</td>
                  </tr>
                ) : selectedSnapshots.length === 0 ? (
                  <tr className={opTr}>
                    <td className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')} colSpan={5}>No routes for this stream.</td>
                  </tr>
                ) : (
                  selectedSnapshots.map((snapshot) => {
                    const focused = snapshot.routeId === focusedRouteId
                    return (
                    <tr
                      key={snapshot.routeId}
                      tabIndex={focused ? -1 : undefined}
                      className={cn(opTr, focused && 'bg-violet-500/[0.08] outline-none ring-1 ring-inset ring-violet-400/70 dark:bg-violet-500/15')}
                      data-testid={`governance-workspace-route-row-${snapshot.routeId}`}
                      data-context-focus={focused ? 'route' : undefined}
                    >
                      <td className={opTd}>{snapshot.routeName}</td>
                      <td className={opTd}>
                        <ProcessingStatusBadge status={snapshot.transform} />
                      </td>
                      <td className={opTd}>
                        <ProcessingStatusBadge status={snapshot.protection} />
                      </td>
                      <td className={opTd}>
                        <ProcessingStatusBadge status={snapshot.classification} />
                      </td>
                      <td className={opTd}>
                        <ProcessingStatusBadge status={snapshot.policy} />
                      </td>
                    </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}
