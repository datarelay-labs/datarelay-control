import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectOnlySemanticClasses } from '../../../test/semantic-class-contract'
import { WizardStepper } from './wizard-stepper'
import { buildInitialState, WIZARD_STEPS, type WizardStepCompletion } from './wizard-state'

function completion(overrides: Partial<WizardStepCompletion> = {}): WizardStepCompletion {
  return {
    connect: 'in_progress',
    sample: 'incomplete',
    destinations: 'incomplete',
    route_processing: 'incomplete',
    deploy: 'incomplete',
    ...overrides,
  }
}

describe('WizardStepper honest setup progress', () => {
  it('does not claim 100% complete merely because an editor opens the last review step', () => {
    const navigate = vi.fn()
    const state = buildInitialState()
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={4}
        setStepIndex={navigate}
        completion={completion()}
        state={state}
        reachability={{ editMode: true }}
      />,
    )

    expect(screen.getByTestId('wizard-progress-label')).toHaveTextContent('Step 5 of 5')
    expect(screen.getByTestId('wizard-completed-stage-count')).toHaveTextContent('0 of 5 setup stages marked complete')
    const bar = screen.getByRole('progressbar', { name: 'Setup stages marked complete' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar.firstElementChild).toHaveStyle({ width: '0%' })
    expect(screen.queryByTestId('wizard-unlock-guidance')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('wizard-stepper-connect'))
    expect(navigate).toHaveBeenCalledWith(0)
  })

  it('counts genuinely marked-complete sections, independently from the current location', () => {
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={3}
        setStepIndex={vi.fn()}
        completion={completion({ connect: 'complete', sample: 'complete' })}
        state={buildInitialState()}
      />,
    )
    expect(screen.getByTestId('wizard-progress-label')).toHaveTextContent('Step 4 of 5')
    expect(screen.getByTestId('wizard-completed-stage-count')).toHaveTextContent('2 of 5 setup stages marked complete')
    const bar = screen.getByRole('progressbar', { name: 'Setup stages marked complete' })
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar.firstElementChild).toHaveStyle({ width: '40%' })
  })

  it('explains that a source must be chosen before Destinations can be unlocked', () => {
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={1}
        setStepIndex={vi.fn()}
        completion={completion()}
        state={buildInitialState()}
      />,
    )
    expect(screen.getByTestId('wizard-stepper-destinations')).toBeDisabled()
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveTextContent('To open Destinations')
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveTextContent('Choose a source in Connect')
    expect(screen.getByTestId('wizard-stepper-destinations')).toHaveAttribute('title', expect.stringContaining('Choose a source in Connect'))
    expect(screen.getByTestId('wizard-stepper-destinations')).toHaveAttribute('aria-describedby', 'wizard-unlock-guidance')
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveAttribute('id', 'wizard-unlock-guidance')
    expect(screen.getByTestId('wizard-stepper-sample')).not.toHaveAttribute('aria-describedby')
  })

  it('points to the latest sample test once a connector and source have been selected', () => {
    const state = buildInitialState()
    state.connector.connectorId = 10
    state.connector.sourceId = 5
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={1}
        setStepIndex={vi.fn()}
        completion={completion()}
        state={state}
      />,
    )
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveTextContent('Run a successful API Test')
  })

  it('shifts the next action to enabled delivery paths when sample check is valid', () => {
    const state = buildInitialState()
    state.connector.connectorId = 10
    state.connector.sourceId = 5
    state.connector.sourceType = 'WEBHOOK_RECEIVER'
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.statusCode = 200
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={2}
        setStepIndex={vi.fn()}
        completion={completion({ connect: 'complete', sample: 'complete' })}
        state={state}
      />,
    )
    expect(screen.getByTestId('wizard-stepper-destinations')).toBeEnabled()
    expect(screen.getByTestId('wizard-stepper-deploy')).toBeDisabled()
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveTextContent('To open Deploy')
    expect(screen.getByTestId('wizard-unlock-guidance')).toHaveTextContent('Enable at least one delivery path')
  })
})

describe('WizardStepper compact rail (B6)', () => {
  function renderRail(stepIndex: number) {
    render(
      <WizardStepper
        wizardSteps={WIZARD_STEPS}
        stepIndex={stepIndex}
        setStepIndex={vi.fn()}
        completion={completion({ connect: 'complete' })}
        state={buildInitialState()}
        reachability={{ editMode: true }}
      />,
    )
    return screen.getByTestId('wizard-stepper')
  }

  it('keeps all five steps in one equal-width grid that never scrolls sideways', () => {
    const rail = renderRail(1)
    expect(rail).toHaveClass('grid', 'grid-cols-5')
    expect(rail).not.toHaveClass('overflow-x-auto')
    expect(within(rail).getAllByRole('listitem')).toHaveLength(5)
  })

  it('marks the current step with the accent alias and collapses inactive titles visually below sm', () => {
    const rail = renderRail(1)
    const current = within(rail).getByTestId('wizard-stepper-sample')
    expect(current).toHaveAttribute('aria-current', 'step')
    expect(current).toHaveClass('border-accent')
    expect(within(rail).getByTestId('wizard-stepper-connect')).not.toHaveClass('border-accent')

    const currentTitle = within(rail).getByTestId('wizard-stepper-sample-title')
    expect(currentTitle).not.toHaveClass('sr-only')
    expect(currentTitle).toHaveClass('truncate')
    const inactiveTitle = within(rail).getByTestId('wizard-stepper-connect-title')
    // Still in the accessibility tree: sr-only below sm, restored from sm up.
    expect(inactiveTitle).toHaveClass('sr-only', 'sm:not-sr-only', 'truncate')
    expect(inactiveTitle).toHaveTextContent('Connect')
  })

  it('styles the stepper and the flow overview with semantic aliases only', () => {
    renderRail(2)
    expectOnlySemanticClasses(screen.getByTestId('wizard-progress'))
  })
})
