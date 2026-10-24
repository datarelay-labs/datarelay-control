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
  type FlowEdgeData,
  type FlowNodeData,
} from './runtime-flow-graph-model'
import { RuntimeFlowDeliveryEdge } from './runtime-flow-delivery-edge'

const runtimeEdgeTypes = { 'runtime-delivery': RuntimeFlowDeliveryEdge }

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
}

export function RuntimeFlowTopology({
  snapshot, selectedStreamId, selectedRouteId = null, requestFailed = false,
}: RuntimeFlowTopologyProps) {
  useOperationalEvidenceClock(snapshot?.updated_at)
  const documentVisible = useDocumentVisible()
  const reducedMotion = useReducedMotionPreference()
  const colorMode = useProductColorMode()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [onScreen, setOnScreen] = useState(true)
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)

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
  const topology = buildRuntimeFlowTopology(snapshot, selectedStreamId, selectedRouteId)
  if (requestFailed) topology.stale = true
  const canAnimate = !topology.stale && !reducedMotion && documentVisible && onScreen
  const edges: Edge<FlowEdgeData>[] = selectRuntimeMotionEdges(
    topology.edges, canAnimate, selectedRouteId,
  )
  const nodes: Node<FlowNodeData>[] = topology.nodes
  const inspectedEdge = edges.find((item) => item.id === inspectedId)
  const inspectedNode = nodes.find((item) => item.id === inspectedId)

  if (!snapshot || topology.totalRoutes === 0 || nodes.length === 0) return null

  const routeEdges = edges.filter((item) => item.data?.gatewayOnly === true)
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
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-gdc-muted">
        <span>{topology.shownRoutes} of {topology.totalRoutes} routes visualized
          {topology.shownRoutes < topology.totalRoutes ? ' · select or inspect a hidden Route to include it' : ''}
        </span>
        <span>Updated: {Number.isFinite(Date.parse(snapshot.updated_at)) ? new Date(snapshot.updated_at).toLocaleString() : 'Unknown'}</span>
      </div>
      <div className="control-runtime-flow-canvas" data-testid="runtime-data-flow-canvas">
        <ReactFlow<Node<FlowNodeData>, Edge<FlowEdgeData>>
          nodes={nodes}
          edges={edges}
          edgeTypes={runtimeEdgeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.05 }}
          minZoom={0.2}
          maxZoom={1.5}
          panOnScroll={false}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          zoomOnDoubleClick={false}
          onNodeClick={(_, item) => setInspectedId(item.id)}
          onEdgeClick={(_, item) => setInspectedId(item.id)}
          ariaLabelConfig={{ 'node.a11yDescription.default': 'Select a node for runtime detail' }}
          colorMode={colorMode}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} size={1} color="var(--gdc-border, #64748b)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {(inspectedEdge || inspectedNode) ? (
        <div className="mt-3 rounded-lg border border-violet-300/70 bg-white px-3 py-2.5 text-xs dark:border-violet-500/40 dark:bg-gdc-card" data-testid="runtime-data-flow-inspector">
          <strong className="font-semibold text-slate-900 dark:text-slate-100">
            {inspectedEdge ? 'Selected delivery relation' : inspectedNode?.data.label}
          </strong>
          <p className="mt-1 text-slate-600 dark:text-gdc-mutedStrong">
            {inspectedEdge?.data?.evidence || inspectedNode?.data.detail}
          </p>
          {inspectedEdge?.data?.routeId ? (
            <Link className="mt-1 inline-block font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              to={routeEditPath(String(inspectedEdge.data.routeId))}>Inspect Route #{inspectedEdge.data.routeId}</Link>
          ) : inspectedNode?.data.href ? (
            <Link className="mt-1 inline-block font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300" to={inspectedNode.data.href}>Open details</Link>
          ) : null}
        </div>
      ) : null}
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
          {routeEdges.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 py-1.5 last:border-0 dark:border-gdc-border">
              {item.data?.routeId ? (
                <Link to={routeEditPath(String(item.data.routeId))} className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
                  Route #{item.data.routeId}
                </Link>
              ) : 'Route unknown'}
              <span className="text-slate-600 dark:text-gdc-mutedStrong">{item.data?.evidence}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
