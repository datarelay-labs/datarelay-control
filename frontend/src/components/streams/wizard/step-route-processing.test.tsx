import { useState } from 'react'
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
    expect(screen.getByTestId('route-processing-simple-guidance')).toHaveTextContent('Start with one set of rules.')
    expect(screen.getByTestId('route-processing-simple-guidance')).toHaveTextContent('select its Route below and turn off Inherit')
    expect(screen.getByTestId('shared-processing-section')).toBeInTheDocument()
    expect(screen.queryByText('Global Processing')).not.toBeInTheDocument()
    expect(screen.getByText('Shared Processing')).toBeInTheDocument()
    expect(screen.getByTestId('shared-processing-route-count')).toHaveTextContent('1 Route in this flow')
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

  it('renders one shared data protection drawer and closes it cleanly', async () => {
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

    fireEvent.click(screen.getByTestId('wizard-data-protection-configure'))
    expect(screen.getAllByTestId('wizard-data-protection-drawer')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('wizard-data-protection-drawer-close'))
    expect(screen.queryByTestId('wizard-data-protection-drawer')).not.toBeInTheDocument()
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

  // C3: the old "Override for this Route" flipped Transform, Protection, Classification and Policy
  // together (inherit all false). It must now only reveal per-section toggles, and each toggle
  // must flip exactly one concern.
  it('overrides each processing section independently (C3)', async () => {
    function Fixture() {
      const [value, setValue] = useState(readyState())
      return (
        <MemoryRouter>
          <StepRouteProcessing
            state={value}
            onChangeMapping={() => {}}
            onChangeMappingMode={() => {}}
            onChangeFullEventJsonata={() => {}}
            onChangeFullEventRegexConfigJson={() => {}}
            onChangeEnrichment={() => {}}
            onChangeDataProtection={() => {}}
            onChangeDestinations={(patch) =>
              setValue((prior) => ({ ...prior, destinations: { ...prior.destinations, ...patch } }))
            }
          />
          <output data-testid="route-draft">{JSON.stringify(value.destinations.routeDrafts[0])}</output>
        </MemoryRouter>
      )
    }
    const inheritOf = () => JSON.parse(screen.getByTestId('route-draft').textContent ?? '{}').inherit

    render(<Fixture />)
    fireEvent.click(screen.getByTestId('route-processing-mode-override'))
    expect(screen.getByTestId('route-processing-mode-override')).toHaveAttribute('aria-checked', 'true')
    // Choosing override mode alone does not override any concern.
    expect(inheritOf()).toEqual({ transform: true, protection: true, classification: true, policy: true })

    fireEvent.click(screen.getByTestId('route-override-toggle-transform'))
    expect(inheritOf()).toEqual({ transform: false, protection: true, classification: true, policy: true })
    expect(screen.getByTestId('route-detail-transform')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('route-detail-tab-data_protection'))
    expect(screen.getByTestId('route-inherits-protection')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('route-override-toggle-policy'))
    expect(inheritOf()).toEqual({ transform: false, protection: true, classification: true, policy: false })
    expect(screen.getByTestId('route-policy-delivery-behavior')).toBeInTheDocument()
    expect(screen.queryByTestId('protection-rules-section')).not.toBeInTheDocument()

    // Turning one section back to shared leaves the others untouched.
    fireEvent.click(screen.getByTestId('route-override-toggle-policy'))
    expect(inheritOf()).toEqual({ transform: false, protection: true, classification: true, policy: true })
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

  it('keeps Webhook Route #2 full email mask in the edit draft without modifying Route #1', async () => {
    const initial = readyState()
    initial.apiTest.analysis = {
      sampleEvent: { email: 'person@example.test' },
      flatPreviewFields: ['$.email'],
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      previewError: null,
    }
    initial.apiTest.extractedEvents = [{ email: 'person@example.test' }]
    initial.destinations.routeDrafts = [
      { ...initial.destinations.routeDrafts[0]!, key: 'route-1' },
      {
        ...initial.destinations.routeDrafts[0]!,
        key: 'route-2',
        governanceLoad: {
          protection: 'unavailable', classification: 'inherited', policy: 'inherited',
        },
      },
    ]
    function Fixture() {
      const [value, setValue] = useState(initial)
      return (
        <MemoryRouter>
          <StepRouteProcessing
            state={value}
            onChangeMapping={() => {}}
            onChangeMappingMode={() => {}}
            onChangeFullEventJsonata={() => {}}
            onChangeFullEventRegexConfigJson={() => {}}
            onChangeEnrichment={() => {}}
            onChangeDataProtection={(patch) =>
              setValue((prior) => ({ ...prior, dataProtection: { ...prior.dataProtection, ...patch } }))
            }
            onChangeDestinations={(patch) =>
              setValue((prior) => ({ ...prior, destinations: { ...prior.destinations, ...patch } }))
            }
          />
          <output data-testid="route-one-draft">{JSON.stringify(value.destinations.routeDrafts[0])}</output>
          <output data-testid="route-two-draft">{JSON.stringify(value.destinations.routeDrafts[1])}</output>
        </MemoryRouter>
      )
    }
    render(<Fixture />)
    fireEvent.click(await screen.findByTestId('route-processing-list-card-route-2'))
    fireEvent.click(screen.getByTestId('route-processing-mode-override'))
    fireEvent.click(await screen.findByTestId('route-detail-tab-data_protection'))
    fireEvent.click(screen.getByTestId('route-override-toggle-protection'))
    const protection = screen.getByTestId('route-detail-data-protection')
    fireEvent.click(within(protection).getByTestId('data-protection-add-row'))
    fireEvent.change(within(protection).getByPlaceholderText('$.email'), { target: { value: '$.email' } })
    fireEvent.change(within(protection).getByDisplayValue('Mask (partial)'), { target: { value: 'mask_full' } })

    await waitFor(() => {
      const route2 = JSON.parse(screen.getByTestId('route-two-draft').textContent ?? '{}')
      expect(route2.overrides.protection.intents).toEqual([
        expect.objectContaining({ detectedField: '$.email', protectionAction: 'mask_full' }),
      ])
      expect(route2.governanceLoad.protection).toBe('unavailable')
      const route1 = JSON.parse(screen.getByTestId('route-one-draft').textContent ?? '{}')
      expect(route1.inherit.protection).toBe(true)
      expect(route1.overrides?.protection).toBeUndefined()
    })
  })

})
