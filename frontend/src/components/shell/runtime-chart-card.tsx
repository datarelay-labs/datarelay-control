import type { ReactNode } from 'react'
import { Card } from '@datarelay-labs/ui'
import { cn } from '../../lib/utils'

type RuntimeChartCardProps = {
  title: string
  subtitle?: string
  /** Optional header actions (e.g. deep-link to related workspace page). */
  actions?: ReactNode
  children: ReactNode
  className?: string
  chartClassName?: string
}

export function RuntimeChartCard({ title, subtitle, actions, children, className, chartClassName }: RuntimeChartCardProps) {
  return (
    <Card
      title={title}
      description={subtitle}
      actions={actions}
      className={cn(
        'border border-slate-200/80 bg-white/95 shadow-none ring-1 ring-slate-200/40 dark:border-gdc-border dark:bg-gdc-card dark:ring-slate-800/60',
        className,
      )}
    >
      <div className={cn('pb-3 pt-0', chartClassName)}>{children}</div>
    </Card>
  )}
