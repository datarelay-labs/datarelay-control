import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { FlowEdgeData } from './runtime-flow-graph-model'

/**
 * Bounded visual cue for aggregate 1-minute gateway delivery (not log packets).
 * React Flow remains the only graph rendering engine; SVG glow is decorative.
 * No separate telemetry fetch, event prediction or receiver acknowledgement.
 */
export function RuntimeFlowDeliveryEdge({
  id,
  sourceX, sourceY, sourcePosition,
  targetX, targetY, targetPosition,
  animated, data, markerEnd, style,
}: EdgeProps<Edge<FlowEdgeData>>) {
  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    curvature: 0.32,
  })
  const eps = data?.observedEps
  const moving = animated === true && data?.gatewayOnly === true &&
    typeof eps === 'number' && Number.isFinite(eps) && eps > 0
  // A stable SVG ID tied to the immutable route/destination edge identity.
  const gradientId = 'flow-gradient-' + [...id].map((ch) => ch.charCodeAt(0).toString(16)).join('-')
  const duration = moving ? Math.max(1.8, 3.6 - Math.log2(1 + eps!) * 0.16).toFixed(2) + 's' : null
  return (
    <>
      {moving ? (
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse"
            x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
            <stop offset="0%" style={{ stopColor: 'var(--dr-status-info)' }} />
            <stop offset="48%" style={{ stopColor: 'var(--dr-action-primary)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--dr-status-success)' }} />
          </linearGradient>
        </defs>
      ) : null}
      {moving ? (
        <path d={path} className="control-runtime-flow-glow" aria-hidden="true"
          stroke={'url(#' + gradientId + ')'} fill="none" pointerEvents="none" />
      ) : null}
      <BaseEdge id={id} path={path} markerEnd={markerEnd}
        style={moving ? { ...style, stroke: 'url(#' + gradientId + ')' } : style}
        interactionWidth={22} />
      {moving ? (
        <g className="control-runtime-flow-particles" data-testid={'runtime-flow-moving-' + id}
          aria-hidden="true" pointerEvents="none">
          <circle r="7" className="control-runtime-flow-trail">
            <animateMotion path={path} dur={duration!} begin="-0.16s" repeatCount="indefinite" />
          </circle>
          <circle r="3.2" className="control-runtime-flow-particle">
            <animateMotion path={path} dur={duration!} begin="0s" repeatCount="indefinite" />
          </circle>
          <circle r="1.5" className="control-runtime-flow-spark">
            <animateMotion path={path} dur={duration!} begin="-0.07s" repeatCount="indefinite" />
          </circle>
        </g>
      ) : null}
    </>
  )
}
