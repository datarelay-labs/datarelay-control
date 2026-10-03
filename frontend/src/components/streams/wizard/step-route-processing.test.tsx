import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepRouteProcessing } from './step-route-processing'
import { buildInitialState, buildRouteTransformOverrideFromGlobal, DEFAULT_ROUTE_PROCESSING_INHERIT } from './wizard-state'
import { ROUTE_PROCESSING_COPY } from '../route-processing/route-processing-labels'

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    {
      id: 10,
      name: 'Syslog Primary',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.0.0.1', port: 514 },
      last_connectivity_test_success: true,
    },
  ]),
}))

function readyState() {
  const state = buildInitialState()
  const finishedAt = Date.now()
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.parsedJson = { events: [{ id: 'evt-1', message: 'hello' }] }
  state.apiTest.extractedEvents = [{ id: 'evt-1', message: 'hello' }]
  state.apiTest.eventCount = 1
  state.apiTest.finishedAt = finishedAt
  state.stream.useWholeResponseAsEvent = true
  state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
  state.destinations.routeDrafts = [
    {
      key: 'r1',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
      inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    },
  ]
  return state
}

describe('StepRouteProcessing', () => {
  it('renders shared processing editor, route list, and route detail panel', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-route-processing')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-section')).toBeInTheDocument()
    expect(screen.queryByText('Global Processing')).not.toBeInTheDocument()
    expect(screen.getByText('Shared Processing')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-route-count')).toHaveTextContent('Applied to 1 Route')
    expect(screen.getByTestId('shared-processing-editor')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-shared-transform')).toBeInTheDocument()
    expect(screen.queryByTestId('shared-processing-edit-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-processing-split-layout')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-list')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-detail-panel')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-list-card-r1')).toHaveTextContent('Syslog Primary')
    })
    expect(screen.getByTestId('route-processing-list-card-r1')).toHaveTextContent('Shared')
  })

  it('shows shared processing concern tabs and switches editors', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-shared-transform')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('shared-processing-tab-data_protection'))
    expect(screen.getByTestId('wizard-step-data-protection')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('protection-rules-section')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-shared-transform')).not.toBeInTheDocument()
  })

  it('shows unified data protection tab in route override mode', async () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: false, protection: false, classification: false, policy: false },
    }

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-data_protection'))
    expect(screen.getByTestId('route-detail-data-protection')).toBeInTheDocument()
    expect(screen.getByTestId('schema-drift-policy-section')).toBeInTheDocument()
    expect(screen.getByTestId('protection-rules-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-default-delivery-behavior-section')).toBeInTheDocument()
    expect(screen.queryByTestId('route-detail-tab-protection')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-detail-tab-classification')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-detail-tab-policy')).not.toBeInTheDocument()
  })

  it('shows processing concern statuses and delivery on route card', async () => {
    const state = readyState()
    state.destinations.routeDrafts[0] = {
      ...state.destinations.routeDrafts[0]!,
      inherit: { transform: false, protection: true, classification: true, policy: false },
    }

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('route-processing-list-card-r1')
    expect(card).toHaveTextContent('Transform')
    expect(card).toHaveTextContent('Override')
    expect(card).toHaveTextContent('Shared')
    expect(card).toHaveTextContent('Delivery')
    expect(within(card).getByTestId('route-card-delivery-status')).toHaveTextContent('Enabled')
  })

  it('shows active route badge and detail header with destination', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('route-processing-list-card-r1')
    expect(card).toHaveAttribute('aria-current', 'true')
    expect(card).toHaveTextContent('Selected')
    expect(screen.getByTestId('route-processing-detail-header')).toBeInTheDocument()
    expect(screen.getByTestId('route-header-processing-statuses')).toBeInTheDocument()
    expect(await screen.findByTestId('route-detail-destination')).toHaveTextContent('Destination: Syslog Primary')
    expect(
      within(screen.getByTestId('route-processing-workspace')).getByTestId('route-processing-output-workspace'),
    ).toBeInTheDocument()
  })

  it('shows route mode selector and hides override tabs when using shared processing', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-mode')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('route-shared-mode-summary')).toHaveTextContent(ROUTE_PROCESSING_COPY.routeUsesShared)
    expect(screen.queryByTestId('route-detail-tab-transform')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-detail-tab-delivery')).toBeInTheDocument()
    expect(screen.queryByTestId('route-detail-transform')).not.toBeInTheDocument()
  })

  it('shows override editors when override mode is selected', async () => {
    const onChangeDestinations = vi.fn()
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-processing-mode-override'))
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [
          expect.objectContaining({
            key: 'r1',
            inherit: { transform: false, protection: false, classification: false, policy: false },
          }),
        ],
      }),
    )
  })

  it('patches route draft when enabled is toggled in delivery tab', async () => {
    const onChangeDestinations = vi.fn()
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    fireEvent.click(screen.getByTestId('route-processing-enabled-r1'))
    expect(onChangeDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [expect.objectContaining({ key: 'r1', enabled: false })],
      }),
    )
  })

  it('exposes failure policy and rate limit controls in delivery tab', async () => {
    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={readyState()}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('route-detail-tab-delivery'))
    expect(await screen.findByTestId('route-processing-failure-policy-r1')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-eps-r1')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-burst-r1')).toBeInTheDocument()
  })

  it('shows protection override status when route has field overrides', () => {
    const state = readyState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    const card = screen.getByTestId('route-processing-list-card-r1')
    expect(card).toHaveTextContent('Override')
  })

  it('shows empty route message when no routes configured', () => {
    const state = readyState()
    state.destinations.routeDrafts = []

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={() => {}}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-processing-empty')).toHaveTextContent(ROUTE_PROCESSING_COPY.noRoutes)
    expect(screen.getByTestId('route-processing-empty')).toHaveTextContent(ROUTE_PROCESSING_COPY.noRoutesHint)
  })
})


describe('StepRouteProcessing guided Transform runtime enablement', () => {
  it('enables route enrichment when a guided override rule is added', async () => {
    const state = readyState()
    state.enrichmentEnabled = false
    const route = state.destinations.routeDrafts[0]!
    route.inherit = { ...DEFAULT_ROUTE_PROCESSING_INHERIT, transform: false }
    route.overrides = { transform: buildRouteTransformOverrideFromGlobal(state) }
    const onChangeDestinations = vi.fn()

    render(
      <MemoryRouter>
        <StepRouteProcessing
          state={state}
          onChangeMapping={() => {}}
          onChangeMappingMode={() => {}}
          onChangeFullEventJsonata={() => {}}
          onChangeFullEventRegexConfigJson={() => {}}
          onChangeEnrichment={() => {}}
          onChangeDataProtection={() => {}}
          onChangeDestinations={onChangeDestinations}
        />
      </MemoryRouter>,
    )
    const panel = screen.getByTestId('route-detail-transform')
    fireEvent.click(within(panel).getByTestId('transform-rule-launcher-trigger'))
    fireEvent.click(within(panel).getByTestId('transform-launcher-static'))

    await waitFor(() => {
      const patches = onChangeDestinations.mock.calls.map(([patch]) => patch)
      expect(
        patches.some((patch) => patch.routeDrafts?.[0]?.overrides?.transform?.enrichmentEnabled === true),
      ).toBe(true)
    })
  })
})
