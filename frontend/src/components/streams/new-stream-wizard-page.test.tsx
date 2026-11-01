import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewStreamWizardPage } from './new-stream-wizard-page'
import { DataRouterEnabledContext } from '../../router/data-router-enabled'
import { clearSession, persistSession, type SessionRole } from '../../auth/session'
import { StepMappingCombined } from './wizard/step-mapping-combined'
import { EnrichmentRulesEditor } from './wizard/enrichment-rules-editor'
import { FinalEventPreviewPanel } from '../mappings/final-event-preview-panel'
import { buildInitialState } from './wizard/wizard-state'
import { WIZARD_DRAFT_KEY_V2 } from './wizard/wizard-draft-migration'
import { computeDeployReadiness } from './wizard/wizard-deploy-readiness'
import * as gdcRuntimePreview from '../../api/gdcRuntimePreview'
import { fetchCatalogSnapshot } from '../../api/gdcCatalog'
import { createConnector } from '../../api/gdcConnectors'
import { clearWizardCatalogSnapshot } from './wizard/wizard-catalog-cache'

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
  createConnector: vi.fn(async () => ({ id: 30 })),
  fetchConnectorsList: vi.fn(async () => []),
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcSources', () => ({
  fetchSourceById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
  invalidateDestinationsListCache: vi.fn(),
}))

describe('NewStreamWizardPage v5.2 5-step', () => {
  beforeEach(() => {
    clearWizardCatalogSnapshot()
    vi.mocked(fetchCatalogSnapshot).mockReset().mockResolvedValue({
      connectors: [], sources: [], apiBacked: false,
    })
  })

  it('enters Connect directly without redundant goal cards or guessed source defaults', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.queryByTestId('wizard-intent-picker')).not.toBeInTheDocument()
    expect(screen.queryByText('What would you like to deliver?')).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-stepper')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeDisabled()
    expect(screen.getByTestId('wizard-next')).toBeDisabled()
    expect(screen.queryByRole('tab', { name: /SQL query/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-database-sql-query')).not.toBeInTheDocument()
    expect(screen.queryByText(/Offline mode/i)).not.toBeInTheDocument()
  })

  it('keeps exactly one primary action on the Connect step, even while a saved draft banner is shown', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'connect', state: buildInitialState() }),
    )
    const { container } = render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.getByTestId('wizard-draft-banner')).toBeInTheDocument()
    const primaries = container.querySelectorAll('button.bg-accent, a.bg-accent')
    expect(primaries).toHaveLength(1)
    expect(primaries[0]).toBe(screen.getByTestId('wizard-next'))
    expect(screen.getByTestId('wizard-draft-resume')).not.toHaveClass('bg-accent')
    expect(screen.getByTestId('wizard-action-bar')).toHaveClass('bg-surface-card')
  })

  it('keeps the Next label, testid and disabled gate while using the shared Button styling', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    const next = screen.getByTestId('wizard-next')
    expect(next).toBeDisabled()
    expect(next).toHaveClass('bg-accent', 'text-on-accent', 'h-control-md', 'whitespace-nowrap')
    expect(next).toHaveTextContent(/^Next/)
    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('border-default', 'bg-surface-card')
  })

  it('keeps one primary (Create & Start) on the Deploy step', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
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
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: '{}' },
    ]
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }))
    const user = userEvent.setup()
    const { container } = render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(screen.getByTestId('wizard-draft-resume'))
    expect(screen.getByTestId('wizard-step-deploy')).toBeInTheDocument()
    const primaries = container.querySelectorAll('button.bg-accent, a.bg-accent')
    expect(primaries).toHaveLength(1)
    expect(primaries[0]).toBe(screen.getByTestId('deploy-create-and-start'))
    expect(screen.getByTestId('wizard-save-draft')).not.toHaveClass('bg-accent')
  })

  it('says where a Save as Draft draft lives and that no Stream exists yet (F-012)', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
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
      { key: 'r1', destinationId: 1, enabled: true, failurePolicy: 'RETRY_THEN_DLQ', rateLimitJson: '{}' },
    ]
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'deploy', state }))
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(screen.getByTestId('wizard-draft-resume'))
    await user.click(screen.getByTestId('wizard-save-draft'))
    const notice = await screen.findByTestId('wizard-draft-notice')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent('Draft saved in this browser only')
    expect(notice).toHaveTextContent('no Stream exists until you select Create & Start Stream')
  })

  it('keeps the original Wizard mounted after contextual Connector cancel', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(await screen.findByTestId('wizard-add-connector'))
    expect(screen.getByRole('dialog', { name: 'Add Connector to Data Flow' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Return to Data Flow' }))
    expect(screen.queryByRole('dialog', { name: 'Add Connector to Data Flow' })).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
  })

  it('keeps keyboard focus in the contextual Connector dialog and returns it to the parent Wizard on cancel', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    const addConnector = await screen.findByTestId('wizard-add-connector')
    await user.click(addConnector)

    const dialog = screen.getByRole('dialog', { name: 'Add Connector to Data Flow' })
    const returnButton = screen.getByRole('button', { name: 'Return to Data Flow' })
    expect(returnButton).toHaveFocus()
    await user.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(returnButton)
    await user.tab()
    expect(returnButton).toHaveFocus()

    const saveButton = screen.getByRole('button', { name: 'Save Connector' })
    saveButton.focus()
    await user.tab()
    expect(returnButton).toHaveFocus()

    await user.click(returnButton)
    await waitFor(() => expect(addConnector).toHaveFocus())
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('returns to the same Data Flow step on Escape without silently persisting a Connector draft', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    const addConnector = await screen.findByTestId('wizard-add-connector')
    await user.click(addConnector)
    expect(screen.getByRole('dialog', { name: 'Add Connector to Data Flow' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Connector to Data Flow' })).not.toBeInTheDocument())
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    await waitFor(() => expect(addConnector).toHaveFocus())
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('prevents leaving the contextual Connector form while its create request is pending', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    let resolveSave!: () => void
    vi.mocked(createConnector).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = () => resolve({ id: 31 } as Awaited<ReturnType<typeof createConnector>>)
    }))
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(await screen.findByTestId('wizard-add-connector'))
    await user.type(screen.getByLabelText('Connector Name *'), 'Pending source')
    await user.type(screen.getByLabelText('Host / Base URL *'), 'https://example.net')
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))

    const returnButton = screen.getByRole('button', { name: 'Return to Data Flow' })
    await waitFor(() => expect(returnButton).toBeDisabled())
    expect(screen.getByRole('dialog', { name: 'Add Connector to Data Flow' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Add Connector to Data Flow' })).toBeInTheDocument()

    resolveSave()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Connector to Data Flow' })).not.toBeInTheDocument())
    expect(await screen.findByRole('option', { name: /Connector #31.*verifying source link/i })).toHaveValue('31')
  })

  it('allows a deliberate return after Connector saving fails without changing the parent draft', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    vi.mocked(createConnector).mockRejectedValueOnce(new Error('Connector was not saved'))
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(await screen.findByTestId('wizard-add-connector'))
    await user.type(screen.getByLabelText('Connector Name *'), 'Retry source')
    await user.type(screen.getByLabelText('Host / Base URL *'), 'https://example.net')
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))

    expect(await screen.findByText('Connector was not saved')).toBeInTheDocument()
    const returnButton = screen.getByRole('button', { name: 'Return to Data Flow' })
    await waitFor(() => expect(returnButton).toBeEnabled())
    await user.click(returnButton)
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('returns a saved Connector ID directly to the active Wizard without re-creation', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue({ connectors: [], sources: [], apiBacked: true })
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/streams/new']}><NewStreamWizardPage /></MemoryRouter>)
    await user.click(await screen.findByTestId('wizard-add-connector'))
    await user.type(screen.getByLabelText('Connector Name *'), 'Parent source')
    await user.type(screen.getByLabelText('Host / Base URL *'), 'https://example.net')
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add Connector to Data Flow' })).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /Connector #30.*verifying source link/i })).toHaveValue('30')
    expect(screen.queryByText('Draft restored from local storage.')).not.toBeInTheDocument()
  })

  it('renders 5-step stepper labels with Route Processing', async () => {
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

  it('shows connect step with Charter v3 connect tabs', async () => {
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

  it('StepMappingCombined renders for route processing transform', () => {
    const state = buildInitialState()
    state.apiTest.sampleResponse = { id: '1', message: 'hello' }
    render(
      <MemoryRouter>
        <StepMappingCombined
          state={state}
          onChangeMapping={() => undefined}
          onChangeMappingMode={() => undefined}
          onChangeFullEventJsonata={() => undefined}
          onChangeFullEventRegexConfigJson={() => undefined}
          onChangeEnrichment={() => undefined}
          onChangeDataProtection={() => undefined}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('wizard-step-transform')).toBeInTheDocument()
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

  it('returns from a created destination to the exact saved Destinations step without auto-selecting a route', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    const draft = buildInitialState()
    draft.connector.connectorId = 42
    draft.stream.name = 'Keep this Stream identity'
    draft.stream.eventArrayPath = '$.data'
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'destinations', state: draft }),
    )

    render(
      <MemoryRouter initialEntries={[{
        pathname: '/streams/new',
        state: { resumeSavedWizardDraft: true, createdDestinationId: 91 },
      }]}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('No destinations configured yet. Create one here without leaving this Flow.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Create destination here' }).length).toBeGreaterThan(0)
    expect(screen.getByText(/Destination #91 saved. Choose Add delivery path/)).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-draft-banner')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-intent-picker')).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-stepper-destinations')).toHaveAttribute('data-active', 'true')
    expect(screen.queryByTestId(/destination-route-card-/)).not.toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '{}')
    expect(saved.stepKey).toBe('destinations')
    expect(saved.state.connector.connectorId).toBe(42)
    expect(saved.state.stream.name).toBe('Keep this Stream identity')
    expect(saved.state.stream.eventArrayPath).toBe('$.data')
    expect(saved.state.destinations.routeDrafts).toEqual([])
  })

  it('does not invent a resumed draft when destination return state has no valid saved draft', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/streams/new',
        state: { resumeSavedWizardDraft: true, createdDestinationId: 91 },
      }]}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Saved Stream draft is unavailable/)).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(screen.queryByText(/Destination #91 saved/)).not.toBeInTheDocument()
  })

  it('saves the current wizard draft before leaving to create a required destination', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    state.connector.connectorId = 42
    state.connector.sourceId = 7
    state.stream.name = 'Destination prerequisite draft'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.data'
    state.stream.checkpointSourcePath = '$.timestamp'
    state.apiTest.unionSchema = {
      total_events: 1,
      fields: [
        { field_path: '$.timestamp', field_type: 'string', occurrence_count: 1, sample_values: ['2026-10-05T00:00:00Z'] },
      ],
    }
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'destinations', state }),
    )

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    const prerequisite = await screen.findByRole('link', { name: 'Manage all destinations' })
    await user.click(prerequisite)

    const saved = JSON.parse(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '{}')
    expect(saved.stepKey).toBe('destinations')
    expect(saved.state.connector.connectorId).toBe(42)
    expect(saved.state.stream.eventArrayPath).toBe('$.data')
    expect(saved.state.stream.checkpointSourcePath).toBe('$.timestamp')
    expect(saved.state.apiTest.unionSchema.total_events).toBe(1)
  })

  it('re-hydrates saved record selections after a successful sample refresh', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')

    const state = buildInitialState()
    const finishedAt = Date.now() - 1000
    state.connector.connectorId = 42
    state.connector.sourceId = 7
    state.stream.name = 'Resumed stream'
    state.stream.endpoint = '/events'
    state.stream.eventArrayPath = '$.data'
    state.stream.eventRootPath = ''
    state.stream.checkpointSourcePath = '$.timestamp'
    state.stream.checkpointFieldType = 'datetime'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.eventRootConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { data: [{ id: 'old', timestamp: '2026-10-04T00:00:00Z' }] }
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.apiTest.unionSchema = {
      total_events: 1,
      fields: [
        { field_path: '$.id', field_type: 'string', occurrence_count: 1, sample_values: ['old'] },
        { field_path: '$.timestamp', field_type: 'string', occurrence_count: 1, sample_values: ['2026-10-04T00:00:00Z'] },
      ],
    }
    localStorage.setItem(
      WIZARD_DRAFT_KEY_V2,
      JSON.stringify({ version: 2, savedAt: Date.now(), stepKey: 'sample', state }),
    )

    const runSpy = vi.spyOn(gdcRuntimePreview, 'runHttpApiTest').mockResolvedValueOnce({
      ok: true,
      request: { method: 'GET', url: 'https://source.test/events', headers_masked: {} },
      response: {
        status_code: 200,
        latency_ms: 5,
        headers: { 'content-type': 'application/json' },
        raw_body: '{"data":[{"id":"new","timestamp":"2026-10-05T00:00:00Z"}]}',
        parsed_json: { data: [{ id: 'new', timestamp: '2026-10-05T00:00:00Z' }] },
        content_type: 'application/json',
      },
      steps: [],
      analysis: null,
    })

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    await user.click(screen.getByTestId('wizard-draft-resume'))
    const next = screen.getByRole('button', { name: /Next: Destinations/i })
    expect(next).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Run Test' }))
    await screen.findByTestId('wizard-run-test-success')
    await waitFor(() => expect(next).toBeEnabled())

    await user.click(screen.getByTestId('wizard-run-test-open-record-selection'))
    expect(await screen.findByTestId('wizard-record-selection-json-tree')).toBeInTheDocument()
    expect(screen.getByTestId('union-schema-status-ready')).toBeInTheDocument()

    runSpy.mockRestore()
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
          final: { final_events: [{ id: '1', environment: 'prod' }] },
          validationWarnings: [],
        }}
        rawSampleEvent={{ id: '1' }}
        rawSampleEvents={[{ id: '1' }]}
        rows={[]}
        eventCount={1}
        sampleEventIndex={0}
        onSampleIndexChange={() => {}}
        onRefresh={() => {}}
        warnings={[]}
      />,
    )
    expect(screen.getByRole('tab', { name: /^Transformed$/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Final event$/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Changes \(1\)$/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Validation by field')).toBeInTheDocument()
    expect(screen.queryByText(/^Mapped event$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Enriched final event/i)).not.toBeInTheDocument()
  })
})


function renderWizardWithStreamsExit() {
  return render(
    <MemoryRouter initialEntries={['/streams/new']}>
      <Routes>
        <Route path="/streams/new" element={<NewStreamWizardPage />} />
        <Route path="/streams" element={<p data-testid="wizard-left-for-streams">Streams workspace</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('New Data Flow draft-safe exit', () => {
  beforeEach(() => {
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    clearWizardCatalogSnapshot()
    vi.mocked(fetchCatalogSnapshot).mockReset().mockResolvedValue({
      connectors: [], sources: [], apiBacked: true,
    })
  })

  it('protects creation immediately now that Connect opens without a goal menu', async () => {
    const user = userEvent.setup()
    renderWizardWithStreamsExit()
    const before = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('wizard-unsaved-exit-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-left-for-streams')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('wizard-exit-discard'))
    expect(screen.getByTestId('wizard-left-for-streams')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
  })

  it('prevents accidental Cancel and browser reload, restores focus and current setup on Escape', async () => {
    const user = userEvent.setup()
    renderWizardWithStreamsExit()
    const before = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(true)

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await user.click(cancel)
    expect(screen.getByRole('dialog', { name: 'Leave this Data Flow setup?' })).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-left-for-streams')).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-exit-keep')).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(cancel).toHaveFocus())
    expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('saves a sanitized local draft at the exact current Wizard step before leaving', async () => {
    const state = buildInitialState()
    state.stream.name = 'Unfinished finance pipeline'
    state.connector.bearerToken = 'NEVER_PERSIST_TOKEN'
    state.apiTest.rawResponse = 'NEVER_PERSIST_RAW_SAMPLE'
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({
      version: 2, savedAt: Date.now(), stepKey: 'connect', state,
    }))
    const user = userEvent.setup()
    renderWizardWithStreamsExit()
    await user.click(screen.getByTestId('wizard-draft-resume'))
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByTestId('wizard-exit-save'))

    expect(screen.getByTestId('wizard-left-for-streams')).toBeInTheDocument()
    const rawDraft = localStorage.getItem(WIZARD_DRAFT_KEY_V2)
    expect(rawDraft).toBeTruthy()
    expect(rawDraft).not.toContain('NEVER_PERSIST_TOKEN')
    expect(rawDraft).not.toContain('NEVER_PERSIST_RAW_SAMPLE')
    const saved = JSON.parse(rawDraft!)
    expect(saved.stepKey).toBe('connect')
    expect(saved.state.stream.name).toBe('Unfinished finance pipeline')
    expect(saved.state.connector.bearerToken).toBe('')
    expect(saved.state.apiTest.rawResponse).toBeNull()
  })

  it('requires an explicit discard before clearing an existing draft', async () => {
    const state = buildInitialState()
    state.stream.name = 'Discard only by choice'
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({
      version: 2, savedAt: Date.now(), stepKey: 'connect', state,
    }))
    const user = userEvent.setup()
    renderWizardWithStreamsExit()
    await user.click(screen.getByTestId('wizard-draft-resume'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).not.toBeNull()
    await user.click(screen.getByTestId('wizard-exit-discard'))
    expect(screen.getByTestId('wizard-left-for-streams')).toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('does not navigate if draft persistence fails', async () => {
    const user = userEvent.setup()
    renderWizardWithStreamsExit()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    try {
      await user.click(screen.getByTestId('wizard-exit-save'))
      expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
      expect(screen.queryByTestId('wizard-left-for-streams')).not.toBeInTheDocument()
      expect(screen.getByText(/Unable to save the local draft/i)).toBeInTheDocument()
    } finally {
      storage.mockRestore()
    }
  })
})

function renderWizardWithDataRouter(initialEntries: string[] = ['/streams/new'], initialIndex?: number) {
  // Same one-splat data-router wrapper as the actual BrowserRouter replacement.
  // Existing declarative MemoryRouter component tests continue to use the
  // no-blocker fallback, while this harness exercises Link and POP transitions.
  const router = createMemoryRouter([{
    path: '/*',
    element: (
      <DataRouterEnabledContext.Provider value>
        <nav><Link to="/monitoring" data-testid="wizard-external-nav">Dashboard</Link></nav>
        <Routes>
          <Route path="/streams/new" element={<NewStreamWizardPage />} />
          <Route path="/streams" element={<p data-testid="wizard-streams-workspace">Streams</p>} />
          <Route path="/monitoring" element={<p data-testid="wizard-dashboard-workspace">Dashboard workspace</p>} />
          <Route path="/destinations" element={<p data-testid="wizard-destinations-workspace">Destination workspace</p>} />
        </Routes>
      </DataRouterEnabledContext.Provider>
    ),
  }], { initialEntries, initialIndex })
  render(<RouterProvider router={router} />)
  return router
}

describe('New Data Flow data-router unsaved cross-page navigation', () => {
  beforeEach(() => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    clearWizardCatalogSnapshot()
    vi.mocked(fetchCatalogSnapshot).mockReset().mockResolvedValue({
      connectors: [], sources: [], apiBacked: true,
    })
  })

  it('blocks a navigation link until Keep editing or Save draft resolves the original destination', async () => {
    const user = userEvent.setup()
    const router = renderWizardWithDataRouter()
    await user.click(screen.getByTestId('wizard-external-nav'))
    expect(await screen.findByTestId('wizard-unsaved-exit-dialog')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/streams/new')
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
    await user.click(screen.getByTestId('wizard-exit-keep'))
    expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/streams/new')
    await user.click(screen.getByTestId('wizard-external-nav'))
    await user.click(await screen.findByTestId('wizard-exit-save'))
    expect(await screen.findByTestId('wizard-dashboard-workspace')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/monitoring')
    const saved = JSON.parse(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '{}')
    expect(saved.stepKey).toBe('connect')
  })

  it('holds Browser Back until the operator explicitly discards local draft work', async () => {
    const user = userEvent.setup()
    const router = renderWizardWithDataRouter(['/monitoring', '/streams/new'], 1)
    act(() => { void router.navigate(-1) })
    expect(await screen.findByTestId('wizard-unsaved-exit-dialog')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/streams/new')
    await user.click(screen.getByTestId('wizard-exit-discard'))
    expect(await screen.findByTestId('wizard-dashboard-workspace')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/monitoring')
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('blocks Browser Forward to another page until the operator keeps editing or confirms exit', async () => {
    const user = userEvent.setup()
    const router = renderWizardWithDataRouter(['/streams/new', '/monitoring'], 0)
    act(() => { void router.navigate(1) })
    expect(await screen.findByTestId('wizard-unsaved-exit-dialog')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/streams/new')
    await user.click(screen.getByTestId('wizard-exit-keep'))
    expect(router.state.location.pathname).toBe('/streams/new')
    expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
    act(() => { void router.navigate(1) })
    await user.click(await screen.findByTestId('wizard-exit-save'))
    expect(await screen.findByTestId('wizard-dashboard-workspace')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/monitoring')
  })

  it('allows the operator-selected Destination prerequisite only after saving the current Wizard draft', async () => {
    const state = buildInitialState()
    state.connector.connectorId = 42
    state.stream.name = 'Preserved Destination setup'
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({
      version: 2, savedAt: Date.now(), stepKey: 'destinations', state,
    }))
    const user = userEvent.setup()
    const router = renderWizardWithDataRouter()
    await user.click(await screen.findByTestId('wizard-draft-resume'))
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    await user.click(await screen.findByRole('link', { name: 'Manage all destinations' }))
    expect(await screen.findByTestId('wizard-destinations-workspace')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/destinations')
    const saved = JSON.parse(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '{}')
    expect(saved.stepKey).toBe('destinations')
    expect(saved.state.stream.name).toBe('Preserved Destination setup')
  })

  it('resets a blocked transition if browser storage rejects a requested save', async () => {
    const user = userEvent.setup()
    const router = renderWizardWithDataRouter()
    await user.click(screen.getByTestId('wizard-external-nav'))
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    try {
      await user.click(await screen.findByTestId('wizard-exit-save'))
      expect(router.state.location.pathname).toBe('/streams/new')
      expect(screen.queryByTestId('wizard-unsaved-exit-dialog')).not.toBeInTheDocument()
      expect(await screen.findByText(/Unable to save the local draft/i)).toBeInTheDocument()
    } finally {
      storage.mockRestore()
    }
  })
})

// The server remains the ultimate authorization gate. The Wizard must still
// avoid presenting a dead-end creation path to read-only signed-in personas.
describe('New Data Flow creation permission guidance', () => {
  const baseSession = {
    access_token: 'ui-test-token',
    refresh_token: 'ui-test-refresh',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }

  beforeEach(() => {
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
    clearWizardCatalogSnapshot()
    vi.mocked(fetchCatalogSnapshot).mockClear()
    localStorage.removeItem('gdc_platform_session_v1')
  })

  afterEach(() => {
    clearSession()
    localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
  })

  function asRole(
    role: SessionRole,
    capabilities?: Record<string, boolean>,
  ) {
    persistSession({
      ...baseSession,
      user: { username: 'role-check', role, status: 'ACTIVE', capabilities },
    })
  }

  it.each(['VIEWER', 'GOVERNANCE_OPERATOR', 'GOVERNANCE_AUDITOR'] as const)(
    'blocks new Stream creation for %s with clear read-only guidance but no hidden API request',
    (role) => {
      asRole(role)
      render(
        <MemoryRouter>
          <NewStreamWizardPage />
        </MemoryRouter>,
      )
      expect(screen.getByTestId('wizard-create-readonly')).toHaveTextContent('requires workspace write access')
      expect(screen.getByRole('link', { name: 'View existing Streams' })).toHaveAttribute('href', '/streams')
      expect(screen.queryByTestId('wizard-intent-picker')).not.toBeInTheDocument()
      expect(screen.queryByTestId('wizard-save-draft')).not.toBeInTheDocument()
      expect(screen.queryByTestId('wizard-add-connector')).not.toBeInTheDocument()
      expect(fetchCatalogSnapshot).not.toHaveBeenCalled()
    },
  )

  it('honors a server-declared workspace mutation denial even for OPERATOR', () => {
    asRole('OPERATOR', { workspace_mutations: false })
    render(<MemoryRouter><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.getByTestId('wizard-create-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-intent-scratch')).not.toBeInTheDocument()
  })

  it.each(['ADMINISTRATOR', 'OPERATOR', 'CONNECTOR_OPERATOR'] as const)(
    'keeps the ordinary Stream creation workflow for authorized %s',
    async (role) => {
      asRole(role, { workspace_mutations: true })
      render(<MemoryRouter><NewStreamWizardPage /></MemoryRouter>)
      expect(screen.queryByTestId('wizard-create-readonly')).not.toBeInTheDocument()
      expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    },
  )

  it('does not install an unsaved-edit browser prompt for a read-only viewer', () => {
    asRole('VIEWER', { workspace_mutations: false })
    render(<MemoryRouter><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.getByTestId('wizard-create-readonly')).toBeInTheDocument()
    const before = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
  })

  it('does not display saved draft configuration to a read-only viewer on a deep link', () => {
    const stored = buildInitialState()
    stored.stream.name = 'Previous account private stream draft'
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify({
      version: 2, savedAt: Date.now(), stepKey: 'connect', state: stored,
    }))
    asRole('VIEWER')
    render(<MemoryRouter><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.getByTestId('wizard-create-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-draft-banner')).not.toBeInTheDocument()
    expect(screen.queryByText('Previous account private stream draft')).not.toBeInTheDocument()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toContain('Previous account private stream draft')
  })

  it('switches to read-only guidance immediately after a server capability downgrade', async () => {
    asRole('OPERATOR', { workspace_mutations: true })
    render(<MemoryRouter><NewStreamWizardPage /></MemoryRouter>)
    expect(screen.getByTestId('wizard-step-connect')).toBeInTheDocument()
    asRole('OPERATOR', { workspace_mutations: false })
    await waitFor(() => expect(screen.getByTestId('wizard-create-readonly')).toBeInTheDocument())
    expect(screen.queryByTestId('wizard-step-connect')).not.toBeInTheDocument()
  })
})
