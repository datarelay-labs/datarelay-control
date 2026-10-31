import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RequestPreviewDrawer } from './request-preview-drawer'

describe('RequestPreviewDrawer', () => {
  it('renders when open and calls onClose from backdrop', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <RequestPreviewDrawer
        open
        title="Request Preview"
        previewKindLabel="JSON Body"
        onClose={onClose}
        draft='{"from":"{{checkpoint.last_timestamp}}"}'
        onDraftChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('request-preview-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('request-preview-draft')).toHaveValue('{"from":"{{checkpoint.last_timestamp}}"}')
    await user.click(screen.getByTestId('request-preview-drawer-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })

  it('returns null when closed', () => {
    const { container } = render(
      <RequestPreviewDrawer
        open={false}
        title="Request Preview"
        previewKindLabel="JSON Body"
        onClose={vi.fn()}
        draft=""
        onDraftChange={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a draggable splitter when splitResults is enabled', () => {
    render(
      <RequestPreviewDrawer
        open
        title="Request Preview"
        previewKindLabel="JSON Body"
        onClose={vi.fn()}
        draft="{}"
        onDraftChange={vi.fn()}
        splitResults
      >
        <p data-testid="drawer-child">Test result content</p>
      </RequestPreviewDrawer>,
    )

    expect(screen.getByRole('separator', { name: /resize panels/i })).toBeInTheDocument()
    expect(screen.getByTestId('request-preview-drawer-results')).toBeInTheDocument()
    expect(screen.queryByTestId('request-preview-drawer-hints')).not.toBeInTheDocument()
  })

  // C1: on the old code the dialog had no aria-modal / aria-labelledby, focus stayed on the opener,
  // Escape did nothing, and Tab could leave the dialog. Each assertion below fails on that code.
  describe('accessible modal behavior (C1)', () => {
    function Harness({ onClose }: { onClose: () => void }) {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open Request Preview
          </button>
          <RequestPreviewDrawer
            open={open}
            title="Request Preview"
            previewKindLabel="JSON Body"
            onClose={() => {
              onClose()
              setOpen(false)
            }}
            draft="{}"
            onDraftChange={vi.fn()}
          />
        </>
      )
    }

    it('is a labelled modal dialog', () => {
      render(
        <RequestPreviewDrawer
          open
          title="Request Preview"
          previewKindLabel="JSON Body"
          onClose={vi.fn()}
          draft="{}"
          onDraftChange={vi.fn()}
        />,
      )
      const dialog = screen.getByRole('dialog', { name: 'Request Preview' })
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(dialog).toHaveAttribute('aria-labelledby')
      expect(document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')).toHaveTextContent('Request Preview')
    })

    it('moves focus into the dialog on open, closes on Escape and restores focus to the opener', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      const opener = screen.getByRole('button', { name: 'Open Request Preview' })
      await user.click(opener)
      const dialog = screen.getByRole('dialog', { name: 'Request Preview' })
      expect(dialog.contains(document.activeElement)).toBe(true)

      await user.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })

    it('traps Tab focus inside the dialog', async () => {
      const user = userEvent.setup()
      render(<Harness onClose={vi.fn()} />)
      await user.click(screen.getByRole('button', { name: 'Open Request Preview' }))

      const closeButton = screen.getByTestId('request-preview-drawer-close')
      const draft = screen.getByTestId('request-preview-draft')
      expect(closeButton).toHaveFocus()

      await user.tab()
      expect(draft).toHaveFocus()
      // Tab past the last focusable wraps to the first one instead of leaving the dialog.
      await user.tab()
      expect(closeButton).toHaveFocus()
      await user.tab({ shift: true })
      expect(draft).toHaveFocus()
    })
  })

  it('uses full-height template without splitter before test results', () => {
    render(
      <RequestPreviewDrawer
        open
        title="Request Preview"
        previewKindLabel="JSON Body"
        onClose={vi.fn()}
        draft="{}"
        onDraftChange={vi.fn()}
        splitResults={false}
      >
        <p>Hint text</p>
      </RequestPreviewDrawer>,
    )

    expect(screen.queryByRole('separator', { name: /resize panels/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('request-preview-drawer-hints')).toBeInTheDocument()
  })
})
