import { Database, GitBranch, RadioTower, Server, type LucideIcon } from 'lucide-react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { formatFlowRate } from './runtime-flow-format'
import type { FlowNodeData } from './runtime-flow-graph-model'

const iconByKind: Record<FlowNodeData['kind'], LucideIcon> = {
  source: RadioTower,
  stream: Database,
  route: GitBranch,
  destination: Server,
}

const titleByKind: Record<FlowNodeData['kind'], string> = {
  source: 'Source',
  stream: 'Stream',
  route: 'Route',
  destination: 'Destination',
}

function readableStatus(status: string): string {
  if (status.startsWith('Last reported')) return 'Last reported'
  switch (status) {
    case 'HEALTHY': return 'Healthy'
    case 'DEGRADED': return 'Warning'
    case 'ERROR': return 'Error'
    case 'Disabled': return 'Disabled'
    case 'Topology only': return 'Topology only'
    default: return 'Unknown'
  }
}

/** Read-only operating node. React Flow owns selection, focus and navigation. */
export function RuntimeFlowNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const Icon = iconByKind[data.kind]
  const observed = typeof data.metricEps === 'number' &&
    Number.isFinite(data.metricEps) && data.metricEps >= 0
  return (
    <div className={'control-runtime-flow-card' + (selected ? ' control-runtime-flow-card--selected' : '')}
      data-testid={'runtime-flow-card-' + data.kind}>
      <Handle type="target" position={Position.Left} isConnectable={false}
        className="control-runtime-flow-handle" />
      <div className="control-runtime-flow-card-main">
        <span className={'control-runtime-flow-icon control-runtime-flow-icon--' + data.kind} aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="control-runtime-flow-card-copy">
          <span className="control-runtime-flow-kind">{titleByKind[data.kind]}</span>
          <span className="control-runtime-flow-name" title={typeof data.fullLabel === 'string' ? data.fullLabel : data.label}>{data.label}</span>
        </span>
        <span className="control-runtime-flow-indicator" aria-hidden="true" />
      </div>
      <div className="control-runtime-flow-card-footer">
        <span className="control-runtime-flow-status">{readableStatus(data.status)}</span>
        <span className="control-runtime-flow-rate" title={data.metricLabel}>
          {observed ? formatFlowRate(data.metricEps) + ' evt/s' : '—'}
        </span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false}
        className="control-runtime-flow-handle" />
    </div>
  )
}
