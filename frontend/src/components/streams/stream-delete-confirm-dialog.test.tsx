import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StreamDeleteConfirmDialog } from './stream-delete-confirm-dialog'

describe('StreamDeleteConfirmDialog', () => {
  it('states the permanent blast radius and keeps type-name confirmation', () => {
    render(
      <StreamDeleteConfirmDialog
        streamName="billing-events"
        confirmValue=""
        onConfirmValueChange={() => undefined}
        busy={false}
        error={null}
        running={false}
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    const impact = screen.getByTestId('stream-delete-dialog-impact')
    expect(impact).toHaveTextContent('Permanently deletes this stream, its checkpoint, and its runtime state.')
    expect(impact).toHaveTextContent(
      'Permanently deletes every route on this stream, including transform, protection, classification, and policy configuration.',
    )
    expect(impact).toHaveTextContent('Permanently deletes delivery history for this stream and its routes.')
    expect(impact).toHaveTextContent('Connector, source, and destination records are kept.')
    expect(screen.getByTestId('stream-delete-dialog-reversibility')).toHaveTextContent(
      'Delete is permanent. Stop the stream first if it is still running.',
    )
    expect(screen.getByTestId('stream-delete-dialog-type-name')).toBeInTheDocument()
    expect(screen.getByTestId('stream-delete-dialog-confirm')).toBeDisabled()
  })

  it('blocks confirmation while the stream is running', () => {
    const onConfirm = vi.fn()
    render(
      <StreamDeleteConfirmDialog
        streamName="billing-events"
        confirmValue="billing-events"
        onConfirmValueChange={() => undefined}
        busy={false}
        error={null}
        running
        onOpenChange={() => undefined}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByTestId('stream-delete-dialog-block')).toHaveTextContent('Stop the stream before deleting.')
    const confirm = screen.getByTestId('stream-delete-dialog-confirm')
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
