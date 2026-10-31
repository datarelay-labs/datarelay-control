import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

export type StatusTone = 'success' | 'warning' | 'error' | 'neutral' | 'info'

/** Theme-aware status aliases (foundation-semantic-tokens.css); one class covers light and dark. */
const toneClass: Record<StatusTone, string> = {
  success: 'border-status-success-border bg-status-success-subtle text-status-success',
  warning: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
  error: 'border-status-critical-border bg-status-critical-subtle text-status-critical',
  neutral: 'border-status-unknown-border bg-status-unknown-subtle text-status-unknown',
  info: 'border-status-info-border bg-status-info-subtle text-status-info',
}

type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone: StatusTone
}

export function StatusBadge({ tone, className, ...rest }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium tabular-nums tracking-tight',
        toneClass[tone],
        className,
      )}
      {...rest}
    />
  )
}
