import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import { WizardFlowOverview } from './wizard-flow-overview'

describe('Wizard flow overview (configuration, not live delivery)', () => {
  it('explains the initial setup without claiming a connected or deployed stream', () => {
    const state = buildInitialState()
    render(<WizardFlowOverview state={state} activeStep="connect" />)
    expect(screen.getByTestId('wizard-flow-source')).toHaveTextContent('Choose a source')
    expect(screen.getByTestId('wizard-flow-processing')).toHaveTextContent('Choose destinations first')
    expect(screen.getByTestId('wizard-flow-delivery')).toHaveTextContent('Choose destinations')
    const view = screen.getByTestId('wizard-flow-overview')
    expect(within(view).getByTestId('wizard-flow-next-action')).toHaveTextContent('Choose where events come from')
    expect(within(view).getByRole('list', { name: 'Data flow stages' })).toBeInTheDocument()
    expect(within(view).getAllByRole('listitem')).toHaveLength(3)
    expect(view).toHaveTextContent('Configuration view')
    expect(view).toHaveTextContent('not proof of live delivery')
    expect(view).not.toHaveTextContent('Delivery proven')
  })

  it('uses selected source and draft routes truthfully, including disabled and customized routes', () => {
    const state = buildInitialState()
    state.connector.connectorId = 10
    state.connector.sourceId = 11
    state.connector.connectorName = 'Office365'
    state.destinations.routeDrafts = [
      {
        key: 'route-a',
        destinationId: 25,
        enabled: true,
        failurePolicy: 'RETRY_AND_BACKOFF',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      },
      {
        key: 'route-b',
        destinationId: 26,
        enabled: false,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT, protection: false },
      },
    ]
    render(<WizardFlowOverview state={state} activeStep="route_processing" />)
    expect(screen.getByTestId('wizard-flow-source')).toHaveTextContent('Office365')
    expect(screen.getByTestId('wizard-flow-source')).toHaveTextContent('confirm a sample')
    expect(screen.getByTestId('wizard-flow-processing')).toHaveTextContent('1 route customized')
    expect(screen.getByTestId('wizard-flow-delivery')).toHaveTextContent('1 of 2 delivery paths enabled')
    expect(screen.getByTestId('wizard-flow-next-action')).toHaveTextContent('customize only the destinations')
    expect(screen.getByTestId('wizard-flow-overview')).toHaveTextContent('not confirmed deliveries')
  })

  it('does not present an enabled route without a destination as configured delivery', () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'unresolved-route',
      destinationId: 0,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
      inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    }]
    render(<WizardFlowOverview state={state} activeStep="destinations" />)
    const delivery = screen.getByTestId('wizard-flow-delivery')
    expect(delivery).toHaveTextContent('Select a valid destination')
    expect(delivery).not.toHaveTextContent('1 of 1 delivery path enabled')
  })

  it('identifies connector-module drafts without claiming saved source records', () => {
    const state = buildInitialState()
    state.connector.registryModuleId = 'example-module'
    render(<WizardFlowOverview state={state} activeStep="connect" />)
    expect(screen.getByTestId('wizard-flow-source')).toHaveTextContent('Connector module selected')
    expect(screen.getByTestId('wizard-flow-source')).toHaveTextContent('Finish source setup')
  })

  it('does not expose credential values or sample data in the overview', () => {
    const state = buildInitialState()
    state.connector.bearerToken = 'private-value-should-not-render'
    state.apiTest.rawResponse = { secret: 'sample-value-should-not-render' }
    render(<WizardFlowOverview state={state} activeStep="deploy" />)
    const view = screen.getByTestId('wizard-flow-overview')
    expect(view).not.toHaveTextContent('private-value-should-not-render')
    expect(view).not.toHaveTextContent('sample-value-should-not-render')
    expect(within(view).getByTestId('wizard-flow-next-action')).toHaveTextContent('verify actual delivery')
  })
})
