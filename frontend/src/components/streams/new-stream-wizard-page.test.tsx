import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NewStreamWizardPage } from './new-stream-wizard-page'
import { StepMapping } from './wizard/step-mapping'
import { EnrichmentRulesEditor } from './wizard/enrichment-rules-editor'
import { FinalEventPreviewPanel } from '../mappings/final-event-preview-panel'
import { buildInitialState } from './wizard/wizard-state'
import { WIZARD_DRAFT_KEY_V2 } from './wizard/wizard-draft-migration'
import { computeDeployReadiness } from './wizard/wizard-deploy-readiness'

vi.mock('../../api/gdcStreams', () => ({
  createStream: vi.fn(),
}))

vi.mock('../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: vi.fn(),
}))

vi.mock('../../api/gdcRoutes', () => ({
  createRoute: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', () => ({
  startRuntimeStream: vi.fn(),
}))

vi.mock('../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({ connectors: [], sources: [], apiBacked: false })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcSources', () => ({
  fetchSourceById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

describe('NewStreamWizardPage v5.2 5-step', () => {
  it('renders 5-step stepper labels with Route Processing', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')
    localStorage.removeItem('gdc-stream-wizard-draft-v1')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    const stepper = screen.getByTestId('wizard-stepper')
    expect(stepper.textContent).toContain('Connect')
    expect(stepper.textContent).toContain('Sample & Record Selection')
    expect(stepper.textContent).toContain('Route Processing')
    expect(stepper.textContent).not.toContain('Data Protection')
    expect(stepper.textContent).toContain('Destinations')
    expect(stepper.textContent).toContain('Deploy')
    expect(stepper.textContent).not.toContain('Enrichment')
    expect(stepper.textContent).not.toContain('Review & Create')
  })

  it('shows connect step with Charter v3 connect tabs', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-connector')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-advanced')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-tab-authentication')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-tab-connection')).not.toBeInTheDocument()
  })

  it('StepMapping renders Basic, Advanced, and Expert tabs with wizard sample', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.parsedJson = { events: [{ id: 'evt-1', message: 'hello' }] }
    state.apiTest.extractedEvents = [{ id: 'evt-1', message: 'hello' }]
    state.apiTest.eventCount = 1
    state.apiTest.finishedAt = Date.now()
    state.stream.useWholeResponseAsEvent = true

    render(
      <StepMapping
        state={state}
        onChangeMapping={() => {}}
        onChangeMappingMode={() => {}}
        onChangeFullEventJsonata={() => {}}
        onChangeFullEventRegexConfigJson={() => {}}
        transformRules={[]}
        onChangeTransformRules={() => {}}
      />,
    )

    expect(screen.getByRole('tab', { name: /Basic · JSONPath/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Advanced · JSONata/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Expert · Full Event Regex/i })).toBeInTheDocument()
  })

  it('shows deploy decision center on deploy step after resuming draft', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Deploy Test'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.checkpointFieldType = 'datetime'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'RETRY_THEN_DLQ',
        rateLimitJson: '{}',
      },
    ]
    localStorage.setItem(
      'gdc-stream-wizard-draft-v2',
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-draft-banner')).toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-draft-resume'))

    expect(screen.getByTestId('wizard-step-deploy')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-checklist')).toBeInTheDocument()
    expect(screen.getByTestId('deploy-create-and-start')).toHaveTextContent('Create & Start Stream')
    expect(screen.queryByRole('heading', { name: 'Review' })).not.toBeInTheDocument()
  })

  it('does not auto-restore draft on /streams/new', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    state.connector.connectorId = 42
    state.connector.connectorName = 'Saved Connector'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-draft-banner')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.queryByText('Draft restored from local storage.')).not.toBeInTheDocument()
  })

  it('shows Resume draft and Start fresh actions when a draft exists', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Saved draft found.')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-draft-resume')).toHaveTextContent('Resume draft')
    expect(screen.getByTestId('wizard-draft-start-fresh')).toHaveTextContent('Start fresh')
  })

  it('resume draft restores connector selection', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    state.connector.connectorId = 77
    state.connector.connectorName = 'Restored Connector'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    await waitFor(() => {
      expect(screen.getByText('Draft restored from local storage.')).toBeInTheDocument()
    })
  })

  it('start fresh clears saved draft and keeps empty connect step', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const state = buildInitialState()
    state.connector.connectorId = 88
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-start-fresh'))

    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-draft-banner')).not.toBeInTheDocument()
  })

  it('keeps Next disabled after draft resume because scrubbed drafts drop API samples', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    const next = screen.getByRole('button', { name: /Next: Destinations/i })
    expect(next).toBeDisabled()
    expect(next).toHaveAttribute('title', expect.stringMatching(/API Test/i))
  })

  it('keeps Next disabled on sample step when checkpoint is missing', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    const finishedAt = Date.now()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.stream.eventArrayPath = '$.events'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.getByRole('button', { name: /Next: Destinations/i })).toBeDisabled()
  })

  it('create another stream clears saved draft', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Done Stream'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: {} },
    ]
    // Creation outcome is stripped on draft load; Create Another is in-session only.
    state.outcome = {
      streamId: 999,
      routeId: 1,
      routeIds: [1],
      mappingSaved: true,
      enrichmentSaved: false,
      dataProtectionSaved: false,
      governanceSaved: false,
      schemaDriftPolicySaved: false,
      schemaDriftPolicyWarnings: [],
      dataProtectionEnforcementIncomplete: false,
      dataProtectionWarnings: [],
      errors: [],
      apiBacked: true,
      createdAt: null,
      materializedStreamIds: [],
    }
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    const user = userEvent.setup()
    const { unmount } = render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.queryByRole('button', { name: /Create Another Stream/i })).not.toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).not.toBeNull()

    unmount()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )
    await user.click(screen.getByTestId('wizard-draft-start-fresh'))
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
  })

  it('blocks deploy create after latest API test failure', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const finishedAt = Date.now()
    const state = buildInitialState()
    state.connector.connectorId = 1
    state.connector.sourceId = 1
    state.stream.name = 'Deploy Test'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.events'
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'error'
    state.apiTest.ok = false
    state.apiTest.parsedJson = { events: [{ id: '1' }] }
    state.apiTest.finishedAt = finishedAt
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]
    state.destinations.routeDrafts = [
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: {} },
    ]

    const user = userEvent.setup()
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }),
    )

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(computeDeployReadiness(state).canCreate).toBe(false)
    expect(screen.getByTestId('deploy-create-and-start')).toBeDisabled()
  })

  it('uses Transform terminology in enrichment rules editor', () => {
    render(<EnrichmentRulesEditor rules={[]} onChange={() => {}} />)
    expect(screen.getByText('Transform rules')).toBeInTheDocument()
    expect(screen.queryByText(/Enrichment Rules/i)).not.toBeInTheDocument()
  })

  it('uses final event preview terminology', () => {
    render(
      <FinalEventPreviewPanel
        preview={{
          loading: false,
          error: null,
          mapped: null,
          final: null,
          validationWarnings: [],
        }}
        rawSampleEvent={{ id: '1' }}
        eventCount={1}
        sampleEventIndex={0}
        onSampleIndexChange={() => {}}
        onRefresh={() => {}}
        localWarnings={[]}
      />,
    )
    expect(screen.getByRole('button', { name: /^Transformed$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Final event$/i })).toBeInTheDocument()
    expect(screen.queryByText(/^Mapped event$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Enriched final event/i)).not.toBeInTheDocument()
  })
})
