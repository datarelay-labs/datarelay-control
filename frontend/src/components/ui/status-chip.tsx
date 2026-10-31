import type { HTMLAttributes, ReactNode } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, CircleHelp, Clock, Minus, XCircle, type LucideIcon } from 'lucide-react'
import { semanticCn } from './semantic-cn'

/**
 * Runtime-truth presentation states. Callers map their own runtime vocabulary
 * (HEALTHY/DEGRADED/ERROR, evidence `stale`, STOPPED/DISABLED/IDLE → `neutral`)
 * onto these; the chip never derives health itself.
 */
export type StatusChipStatus = 'healthy' | 'degraded' | 'warning' | 'critical' | 'unknown' | 'stale' | 'neutral'

export type StatusChipSize = 'sm' | 'md'

type StatusPresentation = {
  label: string
  icon: LucideIcon
  className: string
}

/** Unmeasured states (unknown/stale) use the grey family plus a dashed border so they never read as healthy. */
const STATUS_CHIP_PRESENTATION: Record<StatusChipStatus, StatusPresentation> = {
  healthy: {
    label: 'Healthy',
    icon: CheckCircle2,
    className: 'border-status-success-border bg-status-success-subtle text-status-success',
  },
  degraded: {
    label: 'Degraded',
    icon: AlertCircle,
    className: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    className: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
  },
  critical: {
    label: 'Critical',
    icon: XCircle,
    className: 'border-status-critical-border bg-status-critical-subtle text-status-critical',
  },
  unknown: {
    label: 'Unknown',
    icon: CircleHelp,
    className: 'border-dashed border-status-unknown-border bg-status-unknown-subtle text-status-unknown',
  },
  stale: {
    label: 'Stale',
    icon: Clock,
    className: 'border-dashed border-status-unknown-border bg-status-unknown-subtle text-status-unknown',
  },
  neutral: {
    label: 'Not applicable',
    icon: Minus,
    className: 'border-status-unknown-border bg-surface-card text-fg-secondary',
  },
}

const sizeClass: Record<StatusChipSize, { chip: string; icon: string }> = {
  sm: { chip: 'gap-1 px-1.5 py-px text-caption', icon: 'h-3 w-3' },
  md: { chip: 'gap-1.5 px-2 py-0.5 text-body-sm', icon: 'h-3.5 w-3.5' },
}

export type StatusChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  status: StatusChipStatus
  size?: StatusChipSize
  /** Visible label; defaults to the status word. */
  children?: ReactNode
}

export function StatusChip({ status, size = 'sm', className, children, ...rest }: StatusChipProps) {
  const presentation = STATUS_CHIP_PRESENTATION[status]
  const Icon = presentation.icon
  const label = children === undefined || children === null || children === '' ? presentation.label : children
  return (
    <span
      data-status={status}
      {...rest}
      className={semanticCn(
        'inline-flex items-center rounded border font-medium tabular-nums',
        sizeClass[size].chip,
        presentation.className,
        className,
      )}
    >
      <Icon className={semanticCn('shrink-0', sizeClass[size].icon)} aria-hidden="true" data-status-icon={status} />
      <span>{label}</span>
    </span>
  )
}
