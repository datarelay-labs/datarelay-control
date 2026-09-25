import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import { STREAM_DELETE_IMPACT_BULLETS, STREAM_DELETE_REVERSIBILITY } from './destructive-lifecycle-copy'

type StreamDeleteConfirmDialogProps = {
  streamName: string
  confirmValue: string
  onConfirmValueChange: (value: string) => void
  busy: boolean
  error: string | null
  running: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function StreamDeleteConfirmDialog({
  streamName,
  confirmValue,
  onConfirmValueChange,
  busy,
  error,
  running,
  onOpenChange,
  onConfirm,
}: StreamDeleteConfirmDialogProps) {
  return (
    <DangerousActionDialog
      open
      onOpenChange={onOpenChange}
      title="Delete stream permanently?"
      targetName={streamName}
      impactBullets={[...STREAM_DELETE_IMPACT_BULLETS]}
      reversibility={STREAM_DELETE_REVERSIBILITY}
      confirmMode="type-name"
      expectedTypeName={streamName}
      typeNameValue={confirmValue}
      onTypeNameChange={onConfirmValueChange}
      primaryLabel="Delete stream"
      busy={busy}
      error={error}
      blockReason={running ? 'Stop the stream before deleting.' : null}
      onConfirm={onConfirm}
      dataTestId="stream-delete-dialog"
    />
  )
}
