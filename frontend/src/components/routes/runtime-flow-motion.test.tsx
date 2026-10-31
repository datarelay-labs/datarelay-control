import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Position, type Edge, type EdgeProps } from '@xyflow/react'
import {
  MAX_MOVING_GATEWAY_PATHS,
  selectRuntimeMotionEdges,
  type FlowEdgeData,
} from './runtime-flow-graph-model'
import { RuntimeFlowDeliveryEdge } from './runtime-flow-delivery-edge'

const candidate = (routeId: number, eps: number): Edge<FlowEdgeData> => ({
  id: `route:${routeId}->destination:${routeId + 100}`,
  source: `route:${routeId}`,
  target: `destination:${routeId + 100}`,
  animated: true,
  className: 'control-runtime-flow-edge--active',
  data: {
    routeId, evidence: 'aggregate gateway delivery · receiver unverified',
    observedEps: eps, gatewayOnly: true,
  },
})

describe('Runtime data flow bounded animation', () => {
  it('caps 50 live delivery paths while retaining all status and inspection edges', () => {
    const original = Array.from({ length: 50 }, (_, index) => candidate(index + 1, index + 1))
    const rendered = selectRuntimeMotionEdges(original, true)
    expect(rendered).toHaveLength(50)
    expect(rendered.filter((item) => item.animated)).toHaveLength(MAX_MOVING_GATEWAY_PATHS)
    expect(rendered[0]?.data?.observedEps).toBe(1)
    expect(rendered[0]?.animated).toBe(false)
    expect(rendered[49]?.animated).toBe(true)
    expect(rendered.every((item) => item.type === 'runtime-delivery')).toBe(true)
  })

  it('reserves an active particle path for a selected lower-rate Route outside the cap', () => {
    const items = Array.from({ length: 50 }, (_, index) => candidate(index + 1, index + 1))
    const result = selectRuntimeMotionEdges(items, true, 1)
    expect(result[0]?.animated).toBe(true)
    expect(result.filter((item) => item.animated)).toHaveLength(MAX_MOVING_GATEWAY_PATHS)
  })

  it('pauses all movement and active glow on hidden, stale or reduced-motion views', () => {
    const result = selectRuntimeMotionEdges([candidate(1, 30)], false)
    expect(result[0]?.animated).toBe(false)
    expect(result[0]?.className).toBe('control-runtime-flow-edge--static')
    expect(result[0]?.data?.observedEps).toBe(30)
  })

  it('never animates unknown, zero, invalid rates or upstream topology-only paths', () => {
    const a = candidate(1, 0)
    const b = candidate(2, Number.NaN)
    const c = candidate(3, 4)
    c.data = { ...c.data!, gatewayOnly: false }
    expect(selectRuntimeMotionEdges([a, b, c], true).every((item) => !item.animated)).toBe(true)
  })
})

function draw(animated: boolean, eps: number) {
  const props = {
    id: 'route:11->destination:22',
    source: 'route:11',
    target: 'destination:22',
    sourceX: 0, sourceY: 20, sourcePosition: Position.Right,
    targetX: 180, targetY: 20, targetPosition: Position.Left,
    selected: false, animated,
    data: {
      gatewayOnly: true, routeId: 11, observedEps: eps,
      evidence: 'gateway delivery · receiver unverified',
    },
  } satisfies Partial<EdgeProps<Edge<FlowEdgeData>>>
  return render(<svg><RuntimeFlowDeliveryEdge {...props as EdgeProps<Edge<FlowEdgeData>>} /></svg>)
}

describe('Runtime delivery particle SVG', () => {
  it('draws bounded smooth particles for measured, animated delivery', () => {
    const { container } = draw(true, 8)
    expect(screen.getByTestId('runtime-flow-moving-route:11->destination:22')).toBeInTheDocument()
    expect(container.querySelectorAll('animateMotion')).toHaveLength(3)
    expect(container.querySelectorAll('.control-runtime-flow-glow')).toHaveLength(1)
    expect(container.querySelectorAll('.react-flow__edge-path')).toHaveLength(1)
  })
  it('renders a static path, not packets, for zero or paused delivery', () => {
    const { container, rerender } = draw(false, 8)
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0)
    rerender(<svg><RuntimeFlowDeliveryEdge {...{
      id: 'route:11->destination:22',
      source: 'route:11', target: 'destination:22',
      sourceX: 0, sourceY: 20, sourcePosition: Position.Right,
      targetX: 180, targetY: 20, targetPosition: Position.Left,
      animated: true, selected: false,
      data: { gatewayOnly: true, routeId: 11, observedEps: 0, evidence: 'zero EPS' },
    } as EdgeProps<Edge<FlowEdgeData>>} /></svg>)
    expect(container.querySelectorAll('animateMotion')).toHaveLength(0)
  })
})
