import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StreamRuntimeStatus } from '../../api/streamRows'

export function isStreamSchedulerActive(status: StreamRuntimeStatus): boolean {
  return status === 'RUNNING' || status === 'DEGRADED' || status === 'ERROR'
}

export function streamSchedulerStatusLabel(status: StreamRuntimeStatus, active: boolean): string {
  if (active) {
    if (status === 'DEGRADED') return 'Running · degraded'
    if (status === 'ERROR') return 'Running · error'
    return 'Running'
  }
  if (status === 'STOPPED') return 'Stopped'
  return 'Stopped'
}

export function streamSchedulerActionLabel(active: boolean): 'Stop' | 'Start' {
  return active ? 'Stop' : 'Start'
}

type StreamRunControlSwitchProps = {
  status: StreamRuntimeStatus
  busy?: boolean
  disabled?: boolean
  onToggle: (nextActive: boolean) => void
  tooltipExtra?: string
  size?: 'sm' | 'md'
  label?: string
  'data-testid'?: string
}

export function StreamRunControlSwitch({
  status,
  busy = false,
  disabled = false,
  onToggle,
  tooltipExtra,
  size = 'md',
  label = 'Stream scheduler',
  'data-testid': testId = 'stream-run-control-switch',
}: StreamRunControlSwitchProps) {
  const active = isStreamSchedulerActive(status)
  const statusLabel = streamSchedulerStatusLabel(status, active)
  const actionLabel = streamSchedulerActionLabel(active)
  const height = size === 'sm' ? 'h-8' : 'h-9'

  const title = tooltipExtra
    ? `${active ? 'Stop' : 'Start'} stream scheduler — ${tooltipExtra}`
    : active
      ? 'Turn off the scheduled polling worker for this stream.'
      : 'Turn on the scheduled polling worker for this stream.'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={`${label}: ${statusLabel}`}
      data-testid={testId}
      disabled={disabled || busy}
      title={title}
      onClick={() => onToggle(!active)}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        height,
        active
          ? 'border-emerald-300/80 bg-emerald-500/[0.08] text-emerald-900 hover:bg-emerald-500/[0.14] dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-100'
          : 'border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : null}
      <span className="hidden text-[11px] font-medium text-slate-600 sm:inline dark:text-gdc-muted">{label}</span>
      <span
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          active ? 'bg-emerald-600' : 'bg-slate-300 dark:bg-slate-600',
          busy && 'opacity-70',
        )}
        aria-hidden
      >
        <span
          className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
            active && 'translate-x-4',
          )}
        />
      </span>
      <span
        className={cn(
          'font-semibold',
          active ? 'text-emerald-800 dark:text-emerald-200' : 'text-slate-600 dark:text-gdc-muted',
        )}
      >
        {busy ? 'Updating…' : actionLabel}
      </span>
      <span className="sr-only">Current status: {statusLabel}</span>
    </button>
  )
}
