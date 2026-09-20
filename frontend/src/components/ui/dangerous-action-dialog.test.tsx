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
    expect(screen.getByTestId('dangerous-action-dialog-dependencies')).toHaveTextContent('Connected streams: 3')
    expect(screen.getByTestId('dangerous-action-dialog-reversibility')).toHaveTextContent('This cannot be undone.')
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
})
