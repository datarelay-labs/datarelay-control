import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDestinationsList } from '../../../api/gdcDestinations'
import { StepDeploy } from './step-deploy'
import { buildInitialState } from './wizard-state'

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [
    {
      id: 10,
      name: 'MSS Syslog',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.0.0.1', port: 514 },
      last_connectivity_test_success: true,
    },
    {
      id: 11,
      name: 'Stellar Cyber',
      destination_type: 'HTTP',
      config_json: { url: 'https://example.test' },
      last_connectivity_test_success: true,
    },
    {
      id: 12,
      name: 'Data Lake',
      destination_type: 'S3',
      config_json: { bucket: 'lake' },
      last_connectivity_test_success: true,
    },
  ]),
}))

const runStreamOnce = vi.hoisted(() => vi.fn())
const fetchRuntimeRunTrace = vi.hoisted(() => vi.fn())

vi.mock('../../../api/gdcRuntime', () => ({
  runStreamOnce: (...args: unknown[]) => runStreamOnce(...args),
  fetchRuntimeRunTrace: (...args: unknown[]) => fetchRuntimeRunTrace(...args),
}))

function readyState() {
  const state = buildInitialState()
  const finishedAt = Date.now()
  state.connector.connectorId = 1
  state.connector.sourceId = 1
  state.connector.connectorName = 'Test Connector'
  state.stream.name = 'Test Stream'
  state.stream.endpoint = '/events'
  state.stream.eventArrayPath = '$.events'
  state.stream.checkpointSourcePath = '$.timestamp'
  state.stream.checkpointFieldType = 'datetime'
  state.stream.recordPathConfirmedForApiTestAt = finishedAt
  state.stream.checkpointConfirmedForApiTestAt = finishedAt
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.parsedJson = { events: [{ id: '1' }] }
  state.apiTest.finishedAt = finishedAt
  state.apiTest.eventCount = 20
  state.apiTest.unionSchema = {
    total_events: 20,
    fields: [{ field_path: '$.id', field_type: 'string', occurrence_count: 20, sample_values: ['1'] }],
  }
  state.apiTest.extractedEvents = [{ id: '1' }]
  state.mapping = [{ id: 'm1', outputField: 'event_id', sourceJsonPath: '$.id' }]
  state.destinations.routeDrafts = [
    {
      key: 'r1',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'RETRY_THEN_DLQ',
      rateLimitJson: '{}',
    },
  ]
  return state
}

function multiRouteReadyState() {
  const state = readyState()
  state.destinations.routeDrafts = [
    {
      key: 'r1',
      destinationId: 10,
      enabled: true,
      failurePolicy: 'RETRY_THEN_DLQ',
      rateLimitJson: '{}',
    },
    {
      key: 'r2',
      destinationId: 11,
      enabled: true,
      failurePolicy: 'RETRY_THEN_DLQ',
      rateLimitJson: '{}',
      inherit: { transform: false, protection: true, classification: true, policy: true },
    },
    {
      key: 'r3',
      destinationId: 12,
      enabled: true,
      failurePolicy: 'RETRY_THEN_DLQ',
      rateLimitJson: '{}',
    },
  ]
  return state
}

function expandRouteDetails() {
  fireEvent.click(screen.getByTestId('deploy-route-details-toggle'))
}

describe('StepDeploy', () => {
  beforeEach(() => {
    vi.mocked(fetchDestinationsList).mockReset()
    vi.mocked(fetchDestinationsList).mockResolvedValue([
      {
        id: 10,
        name: 'MSS Syslog',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        last_connectivity_test_success: true,
      },
      {
        id: 11,
        name: 'Stellar Cyber',
        destination_type: 'HTTP',
        config_json: { url: 'https://example.test' },
        last_connectivity_test_success: true,
      },
      {
        id: 12,
        name: 'Data Lake',
        destination_type: 'S3',
        config_json: { bucket: 'lake' },
        last_connectivity_test_success: true,
      },
    ] as never)
  })

  it('surfaces destination list API failure without inventing Destination not found', async () => {
    vi.mocked(fetchDestinationsList).mockResolvedValueOnce(null)
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Failed to load destinations/i)).toBeInTheDocument()
    expect(screen.queryByText(/Destination not found/i)).not.toBeInTheDocument()
    expect(await screen.findByText(/route readiness cannot be evaluated/i)).toBeInTheDocument()
  })

  it('renders Deployment Decision Center with seven checklist categories', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-deploy')).toBeInTheDocument()
    expect(screen.getByText(/Deployment Decision Center/i)).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-connection')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-data')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-records')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-transform')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-protection')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-route_processing')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist-delivery')).toBeInTheDocument()
  })

  it('shows READY status when configuration is deployable', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('deploy-status-label')).toHaveTextContent('READY')
  })

  it('shows NEEDS ATTENTION for incomplete wizard state', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={buildInitialState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('deploy-status-label')).toHaveTextContent('NEEDS ATTENTION')
  })

  it('keeps configuration summary collapsed by default', () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    const summary = screen.getByTestId('deploy-configuration-summary')
    expect(summary).toBeInTheDocument()
    expect(screen.queryByText('Template materialization')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    expect(summary.querySelector('dl')).toBeTruthy()
  })

  it('shows template materialization rows when expanded', () => {
    const state = readyState()
    state.connector.registryModuleId = 'crowdstrike'
    state.connector.selectedTemplateIds = ['detections', 'incidents']

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    expect(screen.getByTestId('deploy-template-materialization')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-template-row-detections')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-template-row-incidents')).toBeInTheDocument()
  })

  it('shows route processing summary after expanding route delivery details', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={readyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('deploy-route-details')).toBeInTheDocument()
    expect(screen.queryByTestId('deploy-route-processing-summary')).not.toBeInTheDocument()
    expandRouteDetails()

    const summary = await screen.findByTestId('deploy-route-processing-summary')
    expect(summary).toHaveTextContent('Route Processing')
    expect(summary).toHaveTextContent('1 Configured')
    expect(summary).toHaveTextContent('Enabled routes')
    expect(summary).toHaveTextContent('1 / 1')
  })

  it('renders route readiness summary and health cards', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expandRouteDetails()

    expect(await screen.findByTestId('deploy-route-readiness-summary')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('deploy-route-ready-count')).toHaveTextContent('3 / 3')
    })
    expect(screen.getByTestId('deploy-route-warning-count')).toHaveTextContent('0 / 3')
    expect(screen.getByTestId('deploy-route-readiness-row-r1')).toHaveTextContent('MSS Syslog')
    expect(screen.getByTestId('deploy-route-readiness-row-r2')).toHaveTextContent('Stellar Cyber')
    expect(screen.getByTestId('deploy-route-readiness-row-r3')).toHaveTextContent('Data Lake')
    expect(screen.getByTestId('deploy-route-health-cards')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r1')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r2')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-health-card-r3')).toBeInTheDocument()
  })

  it('shows per-route override list and shared processing applied count', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expandRouteDetails()

    expect(await screen.findByTestId('deploy-route-processing-intent-notice')).toBeInTheDocument()
    expect(screen.getByText(/Route Processing Intent/i)).toBeInTheDocument()
    expect(await screen.findByTestId('deploy-route-override-list')).toBeInTheDocument()
    expect(await screen.findByTestId('deploy-route-override-Stellar Cyber')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-route-override-r2-transform')).toHaveTextContent('Transform — Override')
    expect(screen.getByTestId('deploy-route-override-r2-transform')).toHaveTextContent('Intent only')
    expect(screen.getByTestId('deploy-shared-processing-summary')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-shared-processing-applied-count')).toHaveTextContent('3 Routes')
  })

  it('shows Shared, Override, and Mixed badges on deploy route health cards', async () => {
    render(
      <MemoryRouter>
        <StepDeploy state={multiRouteReadyState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expandRouteDetails()

    const card = await screen.findByTestId('deploy-route-health-card-r2')
    expect(card).toHaveTextContent('Override')
    expect(card).toHaveTextContent('Shared')
    await waitFor(() => {
      expect(screen.getByTestId('deploy-route-health-status-r2')).toHaveTextContent('Ready')
    })
    expect(screen.getByTestId('deploy-route-intent-gaps-r2')).toHaveTextContent('Transform')
    expect(screen.getByTestId('deploy-route-intent-gaps-r2')).toHaveTextContent('Intent only')
  })

  it('shows split projected counts for override and mixed', async () => {
    const state = multiRouteReadyState()
    state.destinations.routeDrafts[1] = {
      ...state.destinations.routeDrafts[1]!,
      inherit: { transform: false, protection: false, classification: true, policy: true },
    }
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        routeDraftKey: 'r2',
        fieldPath: '$.email',
        protectionAction: 'mask_partial',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    expandRouteDetails()

    expect(await screen.findByTestId('deploy-projected-count-transform')).toHaveTextContent('Override: 1')
    expect(screen.getByTestId('deploy-projected-count-protection')).toHaveTextContent('Mixed: 1')
  })

  it('shows data protection summary in expanded configuration summary', () => {
    const state = readyState()
    state.dataProtection.unknownNormalFieldPolicy = 'require_review'
    state.dataProtection.unknownSensitiveFieldPolicy = 'quarantine'
    state.dataProtection.intents = [
      { key: 'r1', detectedField: '$.email', protectionAction: 'mask_partial', deliveryBehavior: 'continue' },
    ]

    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Configuration Summary' }))
    const summary = screen.getByTestId('deploy-data-protection')
    expect(summary).toHaveTextContent('Schema Drift Policy')
    expect(summary).toHaveTextContent('Require Review')
    expect(summary).toHaveTextContent('Quarantine')
    expect(summary).toHaveTextContent('Protection Rules')
    expect(summary).toHaveTextContent('$.email')
    expect(summary).toHaveTextContent('Mask (partial)')
  })
})

function createdDeployState() {
  const state = readyState()
  state.outcome = {
    streamId: 42,
    routeId: 7,
    routeIds: [7, 8],
    mappingSaved: true,
    enrichmentSaved: true,
    dataProtectionSaved: true,
    governanceSaved: true,
    schemaDriftPolicySaved: true,
    schemaDriftPolicyWarnings: [],
    dataProtectionEnforcementIncomplete: false,
    dataProtectionWarnings: [],
    errors: ['route 8: save failed'],
    reconciliationNote: 'Read back persisted state after the save error. Changes that failed to save are not shown as saved.',
    apiBacked: true,
    createdAt: '2026-09-26T00:00:00.000Z',
  }
  return state
}

function traceSuccess(runId: string, stage = 'route_send_success') {
  return {
    run_id: runId,
    anchor_log_id: 1,
    stream_id: 42,
    connector: null,
    stream: { id: 42, name: 'Test Stream' },
    routes: [{ id: 7, destination_id: 11, label: 'Route 7' }],
    destinations: [],
    timeline: [
      {
        id: 1,
        created_at: '2026-09-26T01:00:00Z',
        stage,
        level: 'info',
        status: 'ok',
        message: 'sent',
        route_id: 7,
        destination_id: 11,
        latency_ms: 10,
        retry_count: stage.includes('retry') ? 1 : 0,
        http_status: 200,
        error_code: null,
      },
    ],
    checkpoint: null,
  }
}

describe('StepDeploy exact-run delivery proof', () => {
  beforeEach(() => {
    runStreamOnce.mockReset()
    fetchRuntimeRunTrace.mockReset()
  })

  it('shows delivery proven only for the exact runtime run and links that run', async () => {
    runStreamOnce.mockResolvedValue({ outcome: 'completed', runtime_run_id: 'run-new' })
    fetchRuntimeRunTrace.mockResolvedValue(traceSuccess('run-new'))

    const state = createdDeployState()
    state.outcome = { ...state.outcome!, materializedStreamIds: [42, 43] }
    render(
      <MemoryRouter>
        <StepDeploy state={state} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    const proof = await screen.findByTestId('deploy-delivery-proof')
    expect(proof).toHaveAttribute('data-status', 'proven')
    expect(proof).toHaveTextContent('Delivery proven')
    expect(proof).toHaveTextContent('run-new')
    expect(screen.getByTestId('deploy-delivery-route-7')).toHaveTextContent('proven')
    expect(screen.getByTestId('deploy-delivery-proof-logs')).toHaveAttribute('href', '/logs?stream_id=42&run_id=run-new')
    expect(screen.getByTestId('deploy-delivery-proof-scope')).toHaveTextContent('stream 42')
    expect(screen.getByTestId('deploy-delivery-proof-scope')).toHaveTextContent('does not prove the other materialized streams')
    expect(fetchRuntimeRunTrace).toHaveBeenCalledWith('run-new')
    expect(screen.getByRole('button', { name: 'Start Blocked' })).toBeDisabled()
    expect(screen.getByTestId('deploy-reconciliation-note')).toHaveTextContent('not shown as saved')
  })

  it('does not call a later success recovered when the previous run was only unverified', async () => {
    runStreamOnce
      .mockResolvedValueOnce({ outcome: 'completed', runtime_run_id: 'run-1' })
      .mockResolvedValueOnce({ outcome: 'completed', runtime_run_id: 'run-2' })
    fetchRuntimeRunTrace.mockResolvedValueOnce({ ...traceSuccess('run-1'), timeline: [] }).mockResolvedValueOnce(traceSuccess('run-2'))

    render(
      <MemoryRouter>
        <StepDeploy state={createdDeployState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    expect(await screen.findByTestId('deploy-delivery-proof')).toHaveAttribute('data-status', 'unverified')

    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    await waitFor(() => {
      expect(screen.getByTestId('deploy-delivery-proof')).toHaveAttribute('data-status', 'proven')
    })
  })

  it('marks a later success recovered only after a failed run, and clears stale proof when the next run throws', async () => {
    runStreamOnce
      .mockResolvedValueOnce({ outcome: 'completed', runtime_run_id: 'run-1' })
      .mockResolvedValueOnce({ outcome: 'completed', runtime_run_id: 'run-2' })
      .mockRejectedValueOnce(new Error('locked'))
    fetchRuntimeRunTrace
      .mockResolvedValueOnce({
        ...traceSuccess('run-1'),
        timeline: [
          {
            id: 1,
            created_at: '2026-09-26T01:00:00Z',
            stage: 'route_send_failed',
            level: 'error',
            status: 'failed',
            message: 'failed',
            route_id: 7,
            destination_id: 11,
            latency_ms: 1,
            retry_count: 0,
            http_status: 500,
            error_code: 'send_failed',
          },
        ],
      })
      .mockResolvedValueOnce(traceSuccess('run-2'))

    render(
      <MemoryRouter>
        <StepDeploy state={createdDeployState()} onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    expect(await screen.findByTestId('deploy-delivery-proof')).toHaveAttribute('data-status', 'failed')
    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    await waitFor(() => {
      expect(screen.getByTestId('deploy-delivery-proof')).toHaveAttribute('data-status', 'recovered')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    await waitFor(() => {
      expect(screen.getByText('locked')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('deploy-delivery-proof')).not.toBeInTheDocument()
  })

  it('does not run while Start is active, and does not treat one stream proof as every materialized stream', async () => {
    const state = createdDeployState()
    state.outcome = {
      ...state.outcome!,
      errors: [],
      reconciliationNote: null,
      materializedStreamIds: [42, 43],
    }
    render(
      <MemoryRouter>
        <StepDeploy state={state} isStarting onStart={vi.fn()} onNavigateToLegacySubstep={vi.fn()} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run Once' }))
    expect(runStreamOnce).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })
})
