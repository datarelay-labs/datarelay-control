import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WizardGovernanceStartModal } from './wizard-governance-start-modal'

const governanceMode = vi.hoisted(() => ({ enabled: true }))

vi.mock('../../../utils/governance-mode', () => ({
  isGovernanceModeEnabled: () => governanceMode.enabled,
}))

function renderModal(onCancel = vi.fn()) {
  render(
    <WizardGovernanceStartModal
      open
      governanceForStream={false}
      onGovernanceForStreamChange={vi.fn()}
      onStart={vi.fn()}
      onCancel={onCancel}
    />,
  )
  return { onCancel }
}

describe('WizardGovernanceStartModal', () => {
  it('describes route-processing governance without a retired step model', () => {
    governanceMode.enabled = true
    renderModal()
    const dialog = screen.getByTestId('wizard-governance-start-modal')
    expect(dialog).toHaveTextContent('Route Processing')
    expect(dialog).not.toHaveTextContent('Data Policy step')
    expect(dialog).not.toHaveTextContent('4-step')
    expect(screen.getByRole('checkbox', { name: /Enable data governance for this stream/i })).toBeInTheDocument()
  })

  it('keeps the governance gate off when tenant governance mode is off', async () => {
    governanceMode.enabled = false
    const { onCancel } = renderModal()
    const dialog = screen.getByTestId('wizard-governance-start-modal')
    expect(dialog).toHaveTextContent('Tenant governance mode is off')
    expect(dialog).toHaveTextContent('standard wizard continues without stream governance controls')
    expect(dialog).not.toHaveTextContent('4-step')
    expect(dialog).not.toHaveTextContent('Data Policy step')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })
})
