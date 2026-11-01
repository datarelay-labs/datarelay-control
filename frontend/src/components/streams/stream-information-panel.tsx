import type { ReactNode } from 'react'
import type { StreamRuntimeStatus } from '../../api/streamRows'
import { StatusBadge } from '../shell/status-badge'
import { cn } from '../../lib/utils'

function statusTone(s: StreamRuntimeStatus): 'success' | 'warning' | 'error' | 'neutral' {
  switch (s) {
    case 'RUNNING':
      return 'success'
    case 'DEGRADED':
      return 'warning'
    case 'ERROR':
      return 'error'
    case 'STOPPED':
      return 'neutral'
    default:
      return 'neutral'
  }
}

type InfoRow = { label: string; value: ReactNode }

export function StreamInformationPanel({
  streamName,
  streamGroup,
  status,
  createdAt,
  lastRun,
  nextRun,
  schemaVersion,
  currentCheckpoint,
  checkpointUpdated,
  checkpointAge,
  onViewCheckpointRaw,
}: {
  streamName: string
  streamGroup?: string | null
  status: StreamRuntimeStatus
  createdAt?: string | null
  lastRun?: string | null
  nextRun?: string | null
  schemaVersion?: string | null
  currentCheckpoint?: string | null
  checkpointUpdated?: string | null
  checkpointAge?: string | null
  onViewCheckpointRaw?: () => void
}) {
  const rows: InfoRow[] = [
    { label: 'Stream Name', value: streamName || '—' },
  ]
  if (streamGroup) rows.push({ label: 'Stream Group', value: streamGroup })
  rows.push({
    label: 'Status',
    value: (
      <StatusBadge tone={statusTone(status)} className="font-bold uppercase tracking-wide">
        {status}
      </StatusBadge>
    ),
  })
  if (createdAt) rows.push({ label: 'Created At', value: createdAt })
  if (lastRun) rows.push({ label: 'Last Run', value: lastRun })
  if (nextRun) rows.push({ label: 'Next Run', value: nextRun })
  if (schemaVersion) rows.push({ label: 'Schema Version', value: schemaVersion })
  if (currentCheckpoint) {
    rows.push({
      label: 'Current Checkpoint',
      value: <span className="whitespace-pre-line font-mono text-[11px]">{currentCheckpoint}</span>,
    })
  }
  if (checkpointUpdated) rows.push({ label: 'Checkpoint Updated', value: checkpointUpdated })
  if (checkpointAge) rows.push({ label: 'Checkpoint Age', value: checkpointAge })
  if (onViewCheckpointRaw) {
    rows.push({
      label: 'Raw JSON',
      value: (
        <button
          type="button"
          onClick={onViewCheckpointRaw}
          className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          View checkpoint JSON
        </button>
      ),
    })
  }

  return (
    <section
      aria-label="Stream information"
      data-testid="stream-information-panel"
      className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Stream Information</h3>
      </div>
      <dl className="divide-y divide-slate-200/70 dark:divide-gdc-divider">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3 px-4 py-2.5">
            <dt className="shrink-0 text-[11px] font-medium text-slate-500 dark:text-gdc-muted">{row.label}</dt>
            <dd className={cn('text-right text-[11px] font-semibold text-slate-800 dark:text-slate-100')}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
