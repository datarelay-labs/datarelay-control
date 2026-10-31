import { DangerousActionDialog, type DangerousActionDependency } from '../ui/dangerous-action-dialog'
import { STREAM_DELETE_IMPACT_BULLETS, STREAM_DELETE_REVERSIBILITY } from './destructive-lifecycle-copy'

/** Held data the delete destroys. `loading`/`error` keep the confirm button disabled (fail closed). */
export type StreamDeleteImpactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; quarantinedEvents: number; pendingReplayJobs: number }

type StreamDeleteConfirmDialogProps = {
  streamName: string
  confirmValue: string
  onConfirmValueChange: (value: string) => void
  busy: boolean
  error: string | null
  running: boolean
  /** Omit only where held data is known to be irrelevant; the edit page always passes it. */
  impact?: StreamDeleteImpactState
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function streamDeleteHeldDataBullets(impact: StreamDeleteImpactState | undefined): string[] {
  if (impact?.status !== 'ready') return []
  const bullets: string[] = []
  if (impact.quarantinedEvents > 0) {
    bullets.push(
      `Permanently destroys ${plural(impact.quarantinedEvents, 'quarantined event')} that ${
        impact.quarantinedEvents === 1 ? 'has' : 'have'
      } not been released or discarded. They can no longer be reviewed, released or replayed.`,
    )
  }
  if (impact.pendingReplayJobs > 0) {
    bullets.push(
      `Permanently discards ${plural(impact.pendingReplayJobs, 'pending replay job')} that ${
        impact.pendingReplayJobs === 1 ? 'has' : 'have'
      } not been delivered. They will never be sent.`,
    )
  }
  return bullets
}

function heldDataDependencies(impact: StreamDeleteImpactState | undefined): DangerousActionDependency[] {
  if (impact?.status !== 'ready') return []
  const deps: DangerousActionDependency[] = []
  if (impact.quarantinedEvents > 0) {
    deps.push({
      label: plural(impact.quarantinedEvents, 'quarantined event'),
      detail: 'still held for review; deleted with the stream',
    })
  }
  if (impact.pendingReplayJobs > 0) {
    deps.push({
      label: plural(impact.pendingReplayJobs, 'pending replay job'),
      detail: 'not yet delivered; deleted with the stream',
    })
  }
  return deps
}

function impactBlockReason(impact: StreamDeleteImpactState | undefined): string | null {
  if (impact?.status === 'loading') return 'Checking quarantined events and pending replay jobs before delete\u2026'
  if (impact?.status === 'error') {
    return `Could not check quarantined events and pending replay jobs (${impact.message}). Close this dialog and try again.`
  }
  return null
}

export function StreamDeleteConfirmDialog({
  streamName,
  confirmValue,
  onConfirmValueChange,
  busy,
  error,
  running,
  impact,
  onOpenChange,
  onConfirm,
}: StreamDeleteConfirmDialogProps) {
  return (
    <DangerousActionDialog
      open
      onOpenChange={onOpenChange}
      title="Delete stream permanently?"
      targetName={streamName}
      impactBullets={[...STREAM_DELETE_IMPACT_BULLETS, ...streamDeleteHeldDataBullets(impact)]}
      dependencies={heldDataDependencies(impact)}
      reversibility={STREAM_DELETE_REVERSIBILITY}
      confirmMode="type-name"
      expectedTypeName={streamName}
      typeNameValue={confirmValue}
      onTypeNameChange={onConfirmValueChange}
      primaryLabel="Delete stream"
      busy={busy}
      error={error}
      blockReason={running ? 'Stop the stream before deleting.' : impactBlockReason(impact)}
      onConfirm={onConfirm}
      dataTestId="stream-delete-dialog"
    />
  )
}
