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

  describe('held data (F-234)', () => {
    const base = {
      streamName: 'billing-events',
      confirmValue: 'billing-events',
      onConfirmValueChange: () => undefined,
      busy: false,
      error: null,
      running: false,
      onOpenChange: () => undefined,
    }

    it('lists quarantined events and pending replay jobs that the delete destroys', () => {
      render(
        <StreamDeleteConfirmDialog
          {...base}
          impact={{ status: 'ready', quarantinedEvents: 3, pendingReplayJobs: 1 }}
          onConfirm={() => undefined}
        />,
      )
      const impact = screen.getByTestId('stream-delete-dialog-impact')
      expect(impact).toHaveTextContent('Permanently destroys 3 quarantined events that have not been released or discarded')
      expect(impact).toHaveTextContent('Permanently discards 1 pending replay job that has not been delivered')
      const deps = screen.getByTestId('stream-delete-dialog-dependencies')
      expect(deps).toHaveTextContent('3 quarantined events')
      expect(deps).toHaveTextContent('1 pending replay job')
      // Still gated by the type-name confirmation, which is satisfied here.
      expect(screen.getByTestId('stream-delete-dialog-confirm')).toBeEnabled()
    })

    it('still requires the stream name to be typed when held data exists', () => {
      render(
        <StreamDeleteConfirmDialog
          {...base}
          confirmValue=""
          impact={{ status: 'ready', quarantinedEvents: 2, pendingReplayJobs: 0 }}
          onConfirm={() => undefined}
        />,
      )
      expect(screen.getByTestId('stream-delete-dialog-confirm')).toBeDisabled()
    })

    it('shows no held-data section when nothing is held', () => {
      render(
        <StreamDeleteConfirmDialog
          {...base}
          impact={{ status: 'ready', quarantinedEvents: 0, pendingReplayJobs: 0 }}
          onConfirm={() => undefined}
        />,
      )
      expect(screen.queryByTestId('stream-delete-dialog-dependencies')).toBeNull()
      expect(screen.getByTestId('stream-delete-dialog-impact')).not.toHaveTextContent('quarantined event')
      expect(screen.getByTestId('stream-delete-dialog-confirm')).toBeEnabled()
    })

    it('fails closed while the counts load or when they cannot be read', () => {
      const onConfirm = vi.fn()
      const { rerender } = render(
        <StreamDeleteConfirmDialog {...base} impact={{ status: 'loading' }} onConfirm={onConfirm} />,
      )
      expect(screen.getByTestId('stream-delete-dialog-block')).toHaveTextContent('Checking quarantined events')
      expect(screen.getByTestId('stream-delete-dialog-confirm')).toBeDisabled()

      rerender(
        <StreamDeleteConfirmDialog
          {...base}
          impact={{ status: 'error', message: 'HTTP 500' }}
          onConfirm={onConfirm}
        />,
      )
      expect(screen.getByTestId('stream-delete-dialog-block')).toHaveTextContent('Could not check quarantined events')
      const confirm = screen.getByTestId('stream-delete-dialog-confirm')
      expect(confirm).toBeDisabled()
      fireEvent.click(confirm)
      expect(onConfirm).not.toHaveBeenCalled()
    })
  })
})
