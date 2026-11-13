import type { MouseEvent, ReactNode } from 'react'
import { semanticCn } from './semantic-cn'
import { StatusChip, type StatusChipStatus } from './status-chip'

export type MetricTileProps = {
  label: ReactNode
  /** null, undefined, '' and NaN mean "not measured" and render the unknown label, never 0 or a blank. */
  value: ReactNode
  unit?: ReactNode
  /** Basis and/or time of the measurement, e.g. "Operational snapshot · 5m window". */
  caption?: ReactNode
  status?: StatusChipStatus
  unknownLabel?: string
  /** Renders the tile as a link. */
  href?: string
  /** Renders the tile as a button when no href is given. */
  onClick?: (event: MouseEvent<HTMLElement>) => void
  className?: string
  'data-testid'?: string
}

function isUnmeasured(value: ReactNode): boolean {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value))
}

const interactiveClass =
  'cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring'

export function MetricTile({
  label,
  value,
  unit,
  caption,
  status,
  unknownLabel = 'Unknown',
  href,
  onClick,
  className,
  'data-testid': testId,
}: MetricTileProps) {
  const unmeasured = isUnmeasured(value)
  const interactive = href !== undefined || onClick !== undefined
  const rootClass = semanticCn(
    'flex min-w-0 flex-col gap-1 rounded-lg border border-default bg-surface-card p-3 text-left',
    interactive && interactiveClass,
    className,
  )

  const content = (
    <>
      <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 text-label text-fg-secondary">{label}</span>
        {status ? <StatusChip status={status} /> : null}
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-1">
        <span
          className={semanticCn('text-metric tabular-nums', unmeasured ? 'text-status-unknown' : 'text-fg')}
          data-metric-value=""
          data-unknown={unmeasured ? 'true' : undefined}
        >
          {unmeasured ? unknownLabel : value}
        </span>
        {unit !== undefined && unit !== null && !unmeasured ? (
          <span className="text-body-sm text-fg-muted">{unit}</span>
        ) : null}
      </span>
      {caption !== undefined && caption !== null && caption !== '' ? (
        <span className="text-caption text-fg-muted">{caption}</span>
      ) : null}
    </>
  )

  if (href !== undefined) {
    return (
      <a href={href} onClick={onClick} className={rootClass} data-testid={testId}>
        {content}
      </a>
    )
  }
  if (onClick !== undefined) {
    return (
      <button type="button" onClick={onClick} className={rootClass} data-testid={testId}>
        {content}
      </button>
    )
  }
  return (
    <div className={rootClass} data-testid={testId}>
      {content}
    </div>
  )
}
