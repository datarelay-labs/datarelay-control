import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import type { FlowEdgeData } from './runtime-flow-graph-model'

/**
 * Bounded visual cue for aggregate 1-minute gateway delivery (not log packets).
 * React Flow remains the only graph rendering engine. No independent animation
 * timer, telemetry fetch, delivery prediction or receiver acknowledgement.
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
    curvature: 0.29,
  })
  const eps = data?.observedEps
  const moving = animated === true && data?.gatewayOnly === true &&
    typeof eps === 'number' && Number.isFinite(eps) && eps > 0
  // Faster aggregate rates modestly shorten path traversal, without
  // presenting one particle as one actual delivered event.
  const duration = moving ? `${Math.max(1.8, 3.6 - Math.log2(1 + eps!) * 0.16).toFixed(2)}s` : null

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={22} />
      {moving ? (
        <g className="control-runtime-flow-particles" data-testid={`runtime-flow-moving-${id}`}
          aria-hidden="true" pointerEvents="none">
          <circle r="6" className="control-runtime-flow-trail">
            <animateMotion path={path} dur={duration!} begin="-0.12s" repeatCount="indefinite" />
          </circle>
          <circle r="3.2" className="control-runtime-flow-particle">
            <animateMotion path={path} dur={duration!} begin="0s" repeatCount="indefinite" />
          </circle>
        </g>
      ) : null}
    </>
  )
}
