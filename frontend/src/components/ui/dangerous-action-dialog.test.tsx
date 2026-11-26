import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DangerousActionDialog } from './dangerous-action-dialog'

describe('DangerousActionDialog', () => {
  it('shows impact bullets and dependencies', () => {
    render(
      <DangerousActionDialog
        open
        onOpenChange={() => {}}
        title="Delete connector?"
        targetName="Acme API"
        impactBullets={['Removes connector configuration permanently.']}
        dependencies={[{ label: 'Connected streams', count: 3 }]}
        reversibility="This cannot be undone."
        primaryLabel="Delete connector"
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Delete connector?')).toBeInTheDocument()
    expect(screen.getByTestId('dangerous-action-dialog-impact')).toHaveTextContent('Removes connector configuration permanently.')
    // The count is shown as-is: no pluralisation suffix glued to the number ("3s").
    expect(screen.getByTestId('dangerous-action-dialog-dependencies').textContent).toContain('Connected streams: 3')
    expect(screen.getByTestId('dangerous-action-dialog-dependencies').textContent).not.toContain('3s')
    expect(screen.getByTestId('dangerous-action-dialog-reversibility')).toHaveTextContent('This cannot be undone.')
  })

  it('never appends a stray plural suffix to dependency counts (E-131)', () => {
    render(
      <DangerousActionDialog
        open
        onOpenChange={() => {}}
        title="Delete destination permanently?"
        dependencies={[
          { label: 'Connected routes', count: 0 },
          { label: 'Streams using destination', count: 1 },
          { label: 'Delivery logs', count: 4 },
        ]}
        primaryLabel="Delete"
        onConfirm={() => {}}
      />,
    )
    const deps = screen.getByTestId('dangerous-action-dialog-dependencies')
    expect(deps).toHaveTextContent('Connected routes: 0')
    expect(deps).toHaveTextContent('Streams using destination: 1')
    expect(deps).toHaveTextContent('Delivery logs: 4')
    expect(deps.textContent).not.toMatch(/\d+s\b/)
  })

  it('requires typed name before enabling confirm', async () => {
    const onConfirm = vi.fn()
    render(
      <DangerousActionDialog
        open
        onOpenChange={() => {}}
        title="Delete stream permanently?"
        confirmMode="type-name"
        expectedTypeName="Orders stream"
        typeNameValue=""
        onTypeNameChange={() => {}}
        primaryLabel="Delete stream"
        onConfirm={onConfirm}
      />,
    )

    const confirm = screen.getByTestId('dangerous-action-dialog-confirm')
    expect(confirm).toBeDisabled()
    expect(screen.getByTestId('dangerous-action-dialog-cancel')).toHaveFocus()
  })

  it('calls onConfirm when typed name matches', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    function Harness() {
      const [typed, setTyped] = useState('')
      return (
        <DangerousActionDialog
          open
          onOpenChange={() => {}}
          title="Delete destination"
          confirmMode="type-name"
          expectedTypeName="MDS"
          typeNameValue={typed}
          onTypeNameChange={setTyped}
          primaryLabel="Delete destination"
          onConfirm={onConfirm}
        />
      )
    }
    render(<Harness />)

    await user.type(screen.getByTestId('dangerous-action-dialog-type-name'), 'MDS')
    await user.click(screen.getByTestId('dangerous-action-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('invokes confirm handler for medium-risk click confirmation', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <DangerousActionDialog
        open
        onOpenChange={() => {}}
        title="Disable route?"
        risk="medium"
        impactBullets={['Delivery to this destination stops until re-enabled.']}
        reversibility="Reversible — you can enable the route again later."
        primaryLabel="Disable route"
        onConfirm={onConfirm}
      />,
    )

    await user.click(screen.getByTestId('dangerous-action-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape when not busy', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(
      <DangerousActionDialog
        open
        onOpenChange={onOpenChange}
        title="Remove route?"
        primaryLabel="Remove route"
        onConfirm={() => {}}
      />,
    )

    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  function Harness({ busy = false }: { busy?: boolean }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <button type="button">Behind the dialog</button>
        <DangerousActionDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete connector?"
          primaryLabel="Delete connector"
          busy={busy}
          onConfirm={() => {}}
        />
      </>
    )
  }

  it('moves focus into the dialog, traps Tab, closes on Escape and returns focus to the opener (F-228)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    await user.click(opener)

    const cancel = await screen.findByTestId('dangerous-action-dialog-cancel')
    const confirm = screen.getByTestId('dangerous-action-dialog-confirm')
    expect(cancel).toHaveFocus()

    await user.tab()
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Behind the dialog' })).not.toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('closes on Escape even when focus has left the dialog (F-228)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')
    ;(document.activeElement as HTMLElement | null)?.blur()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the dialog open on Escape while busy (F-228)', async () => {
    const user = userEvent.setup()
    render(<Harness busy />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders the error with a readable light/dark text pair on the white panel', () => {
    render(
      <DangerousActionDialog
        open
        onOpenChange={() => {}}
        title="Delete route?"
        primaryLabel="Delete route"
        error="Delete failed"
        onConfirm={() => {}}
      />,
    )

    const error = screen.getByTestId('dangerous-action-dialog-error')
    expect(error).toHaveTextContent('Delete failed')
    // The near-white criticalFg token is unreadable on the light (bg-white) panel.
    expect(error).not.toHaveClass('text-gdc-criticalFg')
    expect(error).toHaveClass('text-red-700', 'dark:text-red-300')
  })
})
