import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ReactFlow, Background, Controls, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './runtime-flow-topology.css'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { routeEditPath } from '../../config/nav-paths'
import { useDocumentVisible } from '../../hooks/use-document-visible'
import { useOperationalEvidenceClock } from '../../hooks/use-operational-evidence-clock'
import {
  buildRuntimeFlowTopology,
  selectRuntimeMotionEdges,
  MAX_MOVING_GATEWAY_PATHS,
  MAX_VISIBLE_FLOW_ROUTES,
  type FlowEdgeData,
  type FlowNodeData,
} from './runtime-flow-graph-model'
import { RuntimeFlowDeliveryEdge } from './runtime-flow-delivery-edge'
import { RuntimeFlowNode } from './runtime-flow-node'
import { RuntimeFlowInspector } from './runtime-flow-inspector'

const runtimeEdgeTypes = { 'runtime-delivery': RuntimeFlowDeliveryEdge }
const runtimeNodeTypes = {
  source: RuntimeFlowNode, stream: RuntimeFlowNode,
  route: RuntimeFlowNode, destination: RuntimeFlowNode,
}

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const check = () => setReduced(media.matches)
    check()
    media.addEventListener?.('change', check)
    return () => media.removeEventListener?.('change', check)
  }, [])
  return reduced
}

function currentProductColorMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-dr-theme') === 'dark' ||
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/** The product's manually selected scheme, not the operating-system scheme. */
function useProductColorMode(): 'light' | 'dark' {
  const [mode, setMode] = useState(currentProductColorMode)
  useEffect(() => {
    const root = document.documentElement
    const refresh = () => setMode(currentProductColorMode())
    const observer = new MutationObserver(refresh)
    observer.observe(root, { attributes: true, attributeFilter: ['data-dr-theme', 'class'] })
    refresh()
    return () => observer.disconnect()
  }, [])
  return mode
}

export type RuntimeFlowTopologyProps = {
  snapshot: OperationalSnapshotResponse | null
  selectedStreamId: number | null
  selectedRouteId?: number | null
  requestFailed?: boolean
  /** Select an existing Route in the owning Flow inspector without mutating it. */
  onInspectRoute?: (routeId: number) => boolean
}

export function RuntimeFlowTopology({
  snapshot, selectedStreamId, selectedRouteId = null, requestFailed = false, onInspectRoute,
}: RuntimeFlowTopologyProps) {
  useOperationalEvidenceClock(snapshot?.updated_at)
  const documentVisible = useDocumentVisible()
  const reducedMotion = useReducedMotionPreference()
  const colorMode = useProductColorMode()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [onScreen, setOnScreen] = useState(true)
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  // A parent-selected Route supersedes stale local inspection when context changes.
  useEffect(() => setInspectedId(null), [selectedStreamId, selectedRouteId])
  const [showList, setShowList] = useState(false)
  const [pageChoice, setPageChoice] = useState<{
    streamId: number | null
    routeId: number | null
    page: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries[0]?.isIntersecting === true)
    }, { threshold: 0.02 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [snapshot, selectedStreamId])

  // Do not animate outdated/failed reads, hidden windows, or offscreen graphs.
  const manualPage = pageChoice?.streamId === selectedStreamId &&
    pageChoice?.routeId === selectedRouteId ? pageChoice.page : null
  const topology = buildRuntimeFlowTopology(
    snapshot, selectedStreamId, selectedRouteId, Date.now(), manualPage, requestFailed,
  )
  const canAnimate = !topology.stale && !reducedMotion && documentVisible && onScreen
  const edges: Edge<FlowEdgeData>[] = selectRuntimeMotionEdges(
    topology.edges, canAnimate, selectedRouteId,
  )
  const nodes: Node<FlowNodeData>[] = topology.nodes
  const inspectedEdge = edges.find((item) => item.id === inspectedId)
  const inspectedNode = nodes.find((item) => item.id === inspectedId) ??
    (selectedRouteId !== null ? nodes.find((item) => item.id === 'route:' + selectedRouteId) : undefined)

  function inspectRoute(routeId: number, identity: string) {
    if (!Number.isSafeInteger(routeId) || routeId <= 0) return
    if (onInspectRoute?.(routeId) === false) return
    setInspectedId(identity)
  }

  if (!snapshot || topology.totalRoutes === 0 || nodes.length === 0) return null

  const routeEdges = edges.filter((item) => item.data?.gatewayOnly === true)
  const visibleRouteNodes = nodes.filter((item) => item.data.kind === 'route')
  const ratePositive = topology.edges.filter((item) =>
    item.data?.gatewayOnly === true && item.animated === true).length
  const movingCount = routeEdges.filter((item) => item.animated).length
  return (
    <section
      ref={containerRef}
      data-testid="runtime-data-flow-topology"
      aria-label="Runtime data flow topology"
      className="control-runtime-flow-root border-b border-slate-200/80 bg-slate-50/50 px-4 py-4 dark:border-gdc-border dark:bg-gdc-panel/30 sm:px-6"
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Live data paths</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">
            Source → Stream → Route → Destination · directional motion means gateway-reported 1-minute delivery rate,
            not individual packets or receiver acknowledgement.
          </p>
        </div>
        <span
          data-testid="runtime-data-flow-evidence"
          className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-gdc-border dark:text-slate-200"
        >
          {topology.stale ? 'Unavailable / stale evidence · no motion' : 'Runtime snapshot · 1m delivery rate'}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-gdc-mutedStrong">
        <span aria-live="polite" data-testid="runtime-data-flow-page-range">
          Routes {topology.routePage * MAX_VISIBLE_FLOW_ROUTES + 1}–{topology.routePage * MAX_VISIBLE_FLOW_ROUTES + topology.shownRoutes} of {topology.totalRoutes} visible
        </span>
        {topology.totalRoutes > MAX_VISIBLE_FLOW_ROUTES ? (
          <nav aria-label="Data flow Route pages" className="flex flex-wrap items-center gap-2">
            <button type="button" aria-label="Previous Routes"
              disabled={topology.routePage === 0}
              onClick={() => setPageChoice({ streamId: selectedStreamId, routeId: selectedRouteId, page: topology.routePage - 1 })}
              className="min-h-9 rounded-md border border-slate-300 px-3 py-1.5 font-semibold text-violet-700 disabled:opacity-40 dark:border-gdc-border dark:text-violet-300">
              Previous
            </button>
            <span>Page {topology.routePage + 1} of {Math.ceil(topology.totalRoutes / MAX_VISIBLE_FLOW_ROUTES)}</span>
            <button type="button" aria-label="Next Routes"
              disabled={(topology.routePage + 1) * MAX_VISIBLE_FLOW_ROUTES >= topology.totalRoutes}
              onClick={() => setPageChoice({ streamId: selectedStreamId, routeId: selectedRouteId, page: topology.routePage + 1 })}
              className="min-h-9 rounded-md border border-slate-300 px-3 py-1.5 font-semibold text-violet-700 disabled:opacity-40 dark:border-gdc-border dark:text-violet-300">
              Next
            </button>
          </nav>
        ) : null}
        <span>Updated: {Number.isFinite(Date.parse(snapshot.updated_at)) ? new Date(snapshot.updated_at).toLocaleString() : 'Unknown'}</span>
      </div>
      <div className="control-runtime-flow-workspace">
        <div className="control-runtime-flow-scroll" role="region" aria-label="Scrollable data flow graph" tabIndex={0}>
          <div className="control-runtime-flow-canvas" data-testid="runtime-data-flow-canvas">
        <ReactFlow<Node<FlowNodeData>, Edge<FlowEdgeData>>
          key={`${selectedStreamId}:${topology.routePage}`}
          nodes={nodes}
          edges={edges}
          edgeTypes={runtimeEdgeTypes}
          nodeTypes={runtimeNodeTypes}
          fitView
          fitViewOptions={{ padding: 0.07, maxZoom: 1.05 }}
          minZoom={0.2}
          maxZoom={1.5}
          panOnScroll={false}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          onNodeClick={(_, item) => {
            if (item.data.kind === 'route') {
              inspectRoute(Number(item.id.slice('route:'.length)), item.id)
            } else {
              setInspectedId(item.id)
            }
          }}
          onEdgeClick={(_, item) => {
            if (typeof item.data?.routeId === 'number') {
              inspectRoute(item.data.routeId, item.id)
            } else {
              setInspectedId(item.id)
            }
          }}
          ariaLabelConfig={{ 'node.a11yDescription.default': 'Select a node for runtime detail' }}
          colorMode={colorMode}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} size={1} color="var(--gdc-border, #64748b)" />
          <Controls showInteractive={false} />
        </ReactFlow>
          </div>
        </div>
        <RuntimeFlowInspector
          snapshot={snapshot}
          selectedStreamId={selectedStreamId!}
          selectedNode={inspectedNode}
          selectedEdge={inspectedEdge}
          shownRoutes={topology.shownRoutes}
          totalRoutes={topology.totalRoutes}
          stale={topology.stale}
          onInspectRoute={onInspectRoute ? (routeId) => inspectRoute(routeId, 'route:' + routeId) : undefined}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600 dark:text-gdc-mutedStrong">
          {movingCount} animated of {ratePositive} rate-positive gateway paths
          {ratePositive > MAX_MOVING_GATEWAY_PATHS ? ` · visual cap ${MAX_MOVING_GATEWAY_PATHS}` : ''}
          {reducedMotion ? ' · Reduced motion' : ''}
          {' · receiver status not implied'}
        </p>
        <button type="button" aria-expanded={showList} onClick={() => setShowList((v) => !v)}
          className="min-h-9 rounded-md border border-slate-300 px-3 py-2 text-xs font-semibold text-violet-700 hover:bg-violet-50 dark:border-gdc-border dark:text-violet-300 dark:hover:bg-gdc-rowHover">
          {showList ? 'Hide accessible path list' : 'Show accessible path list'}
        </button>
      </div>
      {showList ? (
        <ul aria-label="Data paths with runtime evidence" data-testid="runtime-data-flow-list"
          className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-gdc-border dark:bg-gdc-card">
          {visibleRouteNodes.map((routeNode) => {
            const routeId = Number(routeNode.id.slice('route:'.length))
            const deliveryEdge = routeEdges.find((item) => item.data?.routeId === routeId)
            return (
              <li key={routeNode.id} className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 py-1.5 last:border-0 dark:border-gdc-border">
                {onInspectRoute ? (
                  <button type="button"
                    aria-label={`Inspect Route #${routeId} in workspace`}
                    aria-pressed={selectedRouteId === routeId}
                    onClick={() => inspectRoute(routeId, routeNode.id)}
                    className="font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300">
                    Route #{routeId}
                  </button>
                ) : (
                  <Link to={routeEditPath(String(routeId))} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
                    Route #{routeId}
                  </Link>
                )}
                <span className="text-slate-600 dark:text-gdc-mutedStrong">
                  {deliveryEdge?.data?.evidence ?? 'Destination not configured · no delivery path'}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
