import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepDataProtection } from './step-data-protection'
import { WizardBasicMappingPanel } from './wizard-basic-mapping-panel'
import { buildInitialState } from './wizard-state'

describe('Drop policy UI', () => {
  it('exposes Unmapped Field Behavior pass through and drop options', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ id: '1', secret: 'x' }]
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]

    render(
      <WizardBasicMappingPanel
        state={state}
        onChangeMapping={() => {}}
        onChangeUnmappedFieldsPolicy={() => {}}
      />,
    )

    expect(screen.getByText('Unmapped Field Behavior')).toBeInTheDocument()
    expect(screen.getByTestId('unmapped-fields-policy-pass_through')).toBeInTheDocument()
    expect(screen.getByTestId('unmapped-fields-policy-drop')).toBeInTheDocument()
    expect(screen.getByText('Pass Through')).toBeInTheDocument()
    expect(screen.getByText('Drop')).toBeInTheDocument()
  })

  it('exposes schema drift drop options', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@a.com' }]

    render(<StepDataProtection state={state} onChange={() => {}} />)

    expect(screen.getByTestId('schema-drift-unknown-normal-field-policy-drop_field')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-unknown-sensitive-field-policy-drop_field')).toBeInTheDocument()
    expect(screen.getAllByRole('radio', { name: 'Drop' })).toHaveLength(2)
  })

  it('exposes SoT Remove protection action (drop_field) distinct from block delivery', () => {
    const state = buildInitialState()
    state.apiTest.extractedEvents = [{ email: 'a@a.com' }]
    state.dataProtection.intents = [
      {
        key: 'dp1',
        detectedField: '$.email',
        protectionAction: 'audit',
        deliveryBehavior: 'continue',
      },
    ]

    render(<StepDataProtection state={state} onChange={() => {}} />)

    const removeOption = screen.getByRole('option', { name: 'Remove' })
    expect(removeOption).toBeInTheDocument()
    expect(removeOption).toHaveValue('drop_field')
    expect(screen.queryByRole('option', { name: 'Drop' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Block delivery' })).toBeInTheDocument()
    // Schema-drift Drop radios remain separate from Protection Action Remove.
    expect(screen.getAllByRole('radio', { name: 'Drop' })).toHaveLength(2)
  })
})
