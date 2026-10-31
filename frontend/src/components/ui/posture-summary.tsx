import { Fragment, type ReactNode } from 'react'
import { semanticCn } from './semantic-cn'
import { StatusChip, type StatusChipStatus } from './status-chip'

/** Already-computed counts; this component never derives health. */
export type PostureCounts = {
  healthy: number
  warning: number
  critical: number
  unknown: number
  /** Rendered only when provided. */
  stale?: number
}

export type PostureSummaryProps = {
  /** Accessible name of the group, e.g. "Stream posture". */
  label: string
  counts: PostureCounts
  /** Caller-supplied overall sentence, e.g. "No action needed". */
  summary?: ReactNode
  /** Caller-supplied overall state; shows the summary as a status chip with icon. */
  posture?: StatusChipStatus
  className?: string
  'data-testid'?: string
}

type CounterKey = keyof PostureCounts

const COUNTERS: Array<{ key: CounterKey; label: string; status: StatusChipStatus }> = [
  { key: 'healthy', label: 'Healthy', status: 'healthy' },
  { key: 'warning', label: 'Warning', status: 'warning' },
  { key: 'critical', label: 'Critical', status: 'critical' },
  { key: 'unknown', label: 'Unknown', status: 'unknown' },
  { key: 'stale', label: 'Stale', status: 'stale' },
]

export function PostureSummary({ label, counts, summary, posture, className, 'data-testid': testId }: PostureSummaryProps) {
  const visible = COUNTERS.filter(({ key }) => key !== 'stale' || counts.stale !== undefined)
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={semanticCn(
        'flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-default bg-surface-card px-3 py-2',
        className,
      )}
    >
      {summary !== undefined && summary !== null && summary !== '' ? (
        posture ? (
          <StatusChip status={posture} size="md" data-posture-summary="">
            {summary}
          </StatusChip>
        ) : (
          <p className="min-w-0 text-body-sm text-fg" data-posture-summary="">
            {summary}
          </p>
        )
      ) : null}
      <ul className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {visible.map(({ key, label: counterLabel, status }, index) => (
          <Fragment key={key}>
            {index > 0 ? (
              <li aria-hidden="true" className="text-caption text-fg-muted">
                ·
              </li>
            ) : null}
            <li data-posture-count={key}>
              <StatusChip status={status}>
                {counterLabel} {counts[key]}
              </StatusChip>
            </li>
          </Fragment>
        ))}
      </ul>
    </div>
  )
}
