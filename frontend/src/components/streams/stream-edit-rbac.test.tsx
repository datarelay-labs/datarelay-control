import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchStreamById } from '../../api/gdcStreams'
import { fetchStreamMappingUiConfig } from '../../api/gdcRuntime'
import { clearSession, persistSession, type SessionRole } from '../../auth/session'
import { StreamEditWizardPage } from './stream-edit-wizard-page'
import { buildInitialState } from './wizard/wizard-state'

const persistWizardStreamEdits = vi.hoisted(() => vi.fn())
const hydrateHolder = vi.hoisted(() => ({
  factory: (): unknown => {
    throw new Error('hydrate factory not set')
  },
}))
const deleteStream = vi.hoisted(() => vi.fn())
const startRuntimeStream = vi.hoisted(() => vi.fn())
const stopRuntimeStream = vi.hoisted(() => vi.fn())
const runStreamOnce = vi.hoisted(() => vi.fn())
const createRoute = vi.hoisted(() => vi.fn())
const deleteRoute = vi.hoisted(() => vi.fn())
const updateRouteWithFreshToken = vi.hoisted(() => vi.fn())
const saveRuntimeRouteEnabledState = vi.hoisted(() => vi.fn())
const saveRuntimeRouteFailurePolicy = vi.hoisted(() => vi.fn())

vi.mock('./wizard/wizard-stream-hydrate', () => ({
  hydrateWizardStateFromStream: vi.fn(async () => hydrateHolder.factory()),
  refreshWizardDestinationsFromStream: vi.fn(async () => null),
}))

vi.mock('./wizard/wizard-stream-persist', async () => {
  const actual = await vi.importActual<typeof import('./wizard/wizard-stream-persist')>(
    './wizard/wizard-stream-persist',
  )
  return {
    applyCreatedRouteIdentity: actual.applyCreatedRouteIdentity,
    applyPersistedRevisions: actual.applyPersistedRevisions,
    persistWizardStreamEdits: (...args: unknown[]) => persistWizardStreamEdits(...args),
  }
})

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: vi.fn(async () => ({ id: 10, name: 'Viewer Stream', status: 'STOPPED' })),
  deleteStream: (...args: unknown[]) => deleteStream(...args),
}))

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamRuntimeStatsHealth: vi.fn(async () => null),
  fetchStreamMappingUiConfig: vi.fn(async () => ({
    stream_id: 10,
    stream_name: 'Viewer Stream',
    stream_enabled: true,
    stream_status: 'ENABLED',
    source_id: 1,
    source_type: 'HTTP_POLL',
    source_config: {},
    mapping: { exists: false, event_array_path: null, event_root_path: null, field_mappings: {}, raw_payload_mode: null },
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    routes: [
      {
        route_id: 22,
        destination_id: 5,
        destination_name: 'Dest A',
        destination_type: 'WEBHOOK_POST',
        route_enabled: false,
        destination_enabled: true,
        formatter_config: {},
        route_rate_limit: {},
        failure_policy: 'LOG_AND_CONTINUE',
      },
    ],
    message: 'ok',
  })),
  saveRuntimeRouteEnabledState: (...args: unknown[]) => saveRuntimeRouteEnabledState(...args),
  saveRuntimeRouteFailurePolicy: (...args: unknown[]) => saveRuntimeRouteFailurePolicy(...args),
  runStreamOnce: (...args: unknown[]) => runStreamOnce(...args),
  fetchRuntimeRunTrace: vi.fn(async () => null),
  searchRuntimeDeliveryLogs: vi.fn(async () => null),
  startRuntimeStream: (...args: unknown[]) => startRuntimeStream(...args),
  stopRuntimeStream: (...args: unknown[]) => stopRuntimeStream(...args),
}))

vi.mock('../../api/gdcRoutes', () => ({
  createRoute: (...args: unknown[]) => createRoute(...args),
  deleteRoute: (...args: unknown[]) => deleteRoute(...args),
  updateRoute: vi.fn(),
  updateRouteWithFreshToken: (...args: unknown[]) => updateRouteWithFreshToken(...args),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [{ id: 5, name: 'Dest A', destination_type: 'WEBHOOK_POST', config_json: {} }]),
  testDestination: vi.fn(),
}))

vi.mock('../../api/gdcRuntimePreview', async () => {
  const actual = await vi.importActual<typeof import('../../api/gdcRuntimePreview')>(
    '../../api/gdcRuntimePreview',
  )
  return {
    ...actual,
    runDeliveryPrefixFormatPreview: vi.fn(async () => ({
      resolved_prefix: '',
      final_payload: '{}',
      message_prefix_enabled: false,
    })),
    runFinalEventDraftPreview: vi.fn(async () => null),
    runExtractionValidate: vi.fn(async () => ({ ok: true })),
    runHttpApiTest: vi.fn(),
    runConnectorAuthTest: vi.fn(),
    runTransformPreview: vi.fn(async () => null),
    runEnrichmentExecPreview: vi.fn(async () => null),
  }
})

vi.mock('../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({ connectors: [], sources: [], apiBacked: false })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
  fetchConnectorById: vi.fn(async () => null),
}))

function hydratedStream() {
  const state = buildInitialState()
  state.stream.name = 'Viewer Stream'
  state.outcome = {
    streamId: 10,
    routeId: null,
    routeIds: [],
    mappingSaved: false,
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
  }
  return state
}

function signIn(role: SessionRole, capabilities?: Record<string, boolean>) {
  persistSession({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user: { username: role.toLowerCase(), role, status: 'ACTIVE', capabilities },
  })
}

function wizard() {
  return within(screen.getByTestId('edit-stream-wizard'))
}

function renderStreamEdit() {
  return render(
    <MemoryRouter initialEntries={['/streams/10/edit']}>
      <Routes>
        <Route path="/streams/:streamId/edit" element={<StreamEditWizardPage />} />
        <Route path="/destinations" element={<p>Destination management workspace</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('StreamEditWizardPage workspace capability visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    hydrateHolder.factory = () => hydratedStream()
    persistWizardStreamEdits.mockResolvedValue({ ok: true, errors: [] })
  })

  afterEach(() => {
    clearSession()
  })

  it('lets a viewer inspect stream edit sections without mutation requests', async () => {
    const user = userEvent.setup()
    signIn('VIEWER')
    const view = renderStreamEdit()

    expect(await screen.findByTestId('stream-edit-readonly-banner')).toHaveTextContent(/Navigation and inspection remain available/i)
    const page = wizard()
    expect(page.queryByTestId('wizard-save-now')).not.toBeInTheDocument()
    expect(page.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(page.queryByRole('button', { name: 'Run Now' })).not.toBeInTheDocument()

    const requestTab = page.getByTestId('wizard-connect-tab-request')
    expect(requestTab).toBeEnabled()
    await user.click(requestTab)
    expect(requestTab).toHaveAttribute('aria-selected', 'true')
    expect(page.getByTestId('wizard-connect-request')).toBeInTheDocument()

    const advancedTab = page.getByTestId('wizard-connect-tab-advanced')
    expect(advancedTab).toBeEnabled()
    await user.click(advancedTab)
    expect(advancedTab).toHaveAttribute('aria-selected', 'true')

    await user.click(page.getByTestId('wizard-stepper-sample'))
    const runTestTab = await page.findByTestId('wizard-sample-tab-run_test')
    const recordTab = page.getByTestId('wizard-sample-tab-record_selection')
    expect(runTestTab).toBeEnabled()
    expect(recordTab).toBeEnabled()
    await user.click(recordTab)
    expect(recordTab).toHaveAttribute('aria-selected', 'true')
    await user.click(runTestTab)
    expect(runTestTab).toHaveAttribute('aria-selected', 'true')
    expect(page.getByTestId('wizard-run-test-panel')).toBeInTheDocument()

    await user.click(page.getByTestId('wizard-stepper-destinations'))
    expect(await page.findByText(/Route remove, toggle, failure policy, and prefix save are unavailable/i)).toBeInTheDocument()
    expect(page.queryByRole('button', { name: 'Add Route' })).not.toBeInTheDocument()
    expect(page.queryByRole('button', { name: /Remove route/i })).not.toBeInTheDocument()

    await user.click(page.getByTestId('wizard-stepper-deploy'))
    expect(await page.findByTestId('deploy-created-panel')).toBeInTheDocument()
    expect(page.queryByRole('button', { name: 'Start Stream' })).not.toBeInTheDocument()
    expect(page.queryByRole('button', { name: 'Run Once' })).not.toBeInTheDocument()
    expect(page.getByRole('link', { name: 'Open runtime' })).toBeInTheDocument()

    await new Promise((resolve) => window.setTimeout(resolve, 1400))
    view.unmount()

    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
    expect(deleteStream).not.toHaveBeenCalled()
    expect(startRuntimeStream).not.toHaveBeenCalled()
    expect(stopRuntimeStream).not.toHaveBeenCalled()
    expect(runStreamOnce).not.toHaveBeenCalled()
    expect(createRoute).not.toHaveBeenCalled()
    expect(deleteRoute).not.toHaveBeenCalled()
    expect(updateRouteWithFreshToken).not.toHaveBeenCalled()
    expect(saveRuntimeRouteEnabledState).not.toHaveBeenCalled()
    expect(saveRuntimeRouteFailurePolicy).not.toHaveBeenCalled()
  })

  it('keeps stream edit mutations available for an operator', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()

    expect(await screen.findByTestId('wizard-save-now')).toBeEnabled()
    const page = wizard()
    expect(page.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Run Now' })).toBeEnabled()
    expect(page.queryByTestId('stream-edit-readonly-banner')).not.toBeInTheDocument()

    const requestTab = page.getByTestId('wizard-connect-tab-request')
    await user.click(requestTab)
    expect(requestTab).toHaveAttribute('aria-selected', 'true')

    await user.click(page.getByTestId('wizard-save-now'))
    await waitFor(() => {
      expect(persistWizardStreamEdits).toHaveBeenCalled()
    })

    await user.click(page.getByTestId('wizard-stepper-deploy'))
    expect(await page.findByRole('button', { name: 'Start Stream' })).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Run Once' })).toBeInTheDocument()
  })

  it('guards leaving the Stream editor for a new destination until unsaved edits are confirmed', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Edited stream awaiting save')
    await user.click(within(page).getByTestId('wizard-stepper-destinations'))
    const manage = await within(page).findByRole('link', { name: 'Create new destination' })
    await user.click(manage)
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()
    expect(within(page).getByTestId('edit-destination-navigation-notice')).toHaveTextContent(/Save now/)
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()

    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByRole('link', { name: 'Create new destination' }))
    expect(await screen.findByText('Destination management workspace')).toBeInTheDocument()
  })

  it('keeps the editor open while an explicit save request is still in flight', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    let resolveSave: (value: { ok: boolean; errors: string[] }) => void = () => {}
    persistWizardStreamEdits.mockImplementationOnce(() =>
      new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Saving stream edits')
    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    await user.click(within(page).getByTestId('wizard-stepper-destinations'))
    await user.click(await within(page).findByRole('link', { name: 'Create new destination' }))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-destination-navigation-notice')).toHaveTextContent('still saving')
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()

    resolveSave({ ok: true, errors: [] })
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByRole('link', { name: 'Create new destination' }))
    expect(await screen.findByText('Destination management workspace')).toBeInTheDocument()
  })

  it('allows read-only Stream inspection to navigate to destination management without a write', async () => {
    const user = userEvent.setup()
    signIn('VIEWER')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-stepper-destinations'))
    await user.click(await within(page).findByRole('link', { name: 'Create new destination' }))
    expect(await screen.findByText('Destination management workspace')).toBeInTheDocument()
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
  })

  it('retains the editor after a failed explicit save instead of navigating away', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    persistWizardStreamEdits.mockResolvedValue({ ok: false, errors: ['destination configuration was not saved'] })
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Unconfirmed destination edit')
    await user.click(within(page).getByTestId('wizard-save-now'))
    expect(await within(page).findByText(/destination configuration was not saved/i)).toBeInTheDocument()
    await user.click(within(page).getByTestId('wizard-stepper-destinations'))
    await user.click(await within(page).findByRole('link', { name: 'Create new destination' }))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-destination-navigation-notice')).toHaveTextContent(/save failed/i)
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()
  })

  it('refreshes the route projection after a partial save that may have persisted routes', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    persistWizardStreamEdits.mockResolvedValue({
      ok: false,
      errors: ['governance verification failed after route sync'],
      routeIdsByDraftKey: {},
    })
    renderStreamEdit()

    await screen.findByTestId('edit-stream-wizard')
    const page = wizard()
    await user.click(page.getByTestId('wizard-stepper-destinations'))
    await page.findByText('Routes (1)')
    const callsBefore = vi.mocked(fetchStreamMappingUiConfig).mock.calls.length

    await user.click(page.getByTestId('wizard-save-now'))
    expect(await page.findByText(/governance verification failed after route sync/i)).toBeInTheDocument()
    await waitFor(() =>
      expect(vi.mocked(fetchStreamMappingUiConfig).mock.calls.length).toBeGreaterThan(callsBefore),
    )
  })

  it('keeps stream edit mutations available for an administrator', async () => {
    signIn('ADMINISTRATOR')
    renderStreamEdit()
    expect(await screen.findByTestId('wizard-save-now')).toBeEnabled()
    const page = wizard()
    expect(page.getByRole('button', { name: 'Run Now' })).toBeEnabled()
    expect(page.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(page.queryByTestId('stream-edit-readonly-banner')).not.toBeInTheDocument()
  })

  it('honors a server capability override that grants workspace mutations without runtime control', async () => {
    signIn('VIEWER', { workspace_mutations: true, runtime_stream_control: false })
    renderStreamEdit()
    expect(await screen.findByTestId('wizard-save-now')).toBeEnabled()
    const page = wizard()
    expect(page.queryByRole('button', { name: 'Run Now' })).not.toBeInTheDocument()
    expect(page.getByTestId('stream-edit-readonly-banner')).toHaveTextContent(/Start, stop, and Run Now are unavailable/i)
  })

  it('blocks Start and Run Now until a failed save is corrected and saved again', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    persistWizardStreamEdits.mockResolvedValue({ ok: false, errors: ['route 3: save failed'] })
    renderStreamEdit()

    const runNow = await screen.findByRole('button', { name: 'Run Now' })
    await waitFor(() => expect(runNow).toBeEnabled())
    await user.click(screen.getByTestId('wizard-connect-tab-request'))
    const name = screen.getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Corrected stream')
    expect(screen.getByRole('button', { name: 'Run Now' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Run Now' }))
    expect(runStreamOnce).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('wizard-save-now'))
    expect(await screen.findByText(/route 3: save failed/)).toBeInTheDocument()
    expect(screen.getByTestId('stream-run-control-switch')).toBeDisabled()
    fireEvent.click(screen.getByTestId('stream-run-control-switch'))
    expect(startRuntimeStream).not.toHaveBeenCalled()

    persistWizardStreamEdits.mockResolvedValue({ ok: true, errors: [] })
    await user.click(screen.getByTestId('wizard-save-now'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run Now' })).toBeEnabled())
    expect(screen.queryByText(/route 3: save failed/)).not.toBeInTheDocument()
    expect(screen.getByTestId('stream-run-control-switch')).toBeEnabled()
  })

  it('keeps Stop available after an edit while the stream is running', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'RUNNING' })
    renderStreamEdit()
    await screen.findByRole('button', { name: 'Run Now' })
    await waitFor(() => expect(screen.getByTestId('stream-run-control-switch')).toHaveTextContent('Running'))
    await user.click(screen.getByTestId('wizard-connect-tab-request'))
    const name = screen.getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.type(name, ' edited')
    expect(screen.getByRole('button', { name: 'Run Now' })).toBeDisabled()
    expect(screen.getByTestId('stream-run-control-switch')).toBeEnabled()
    await user.click(screen.getByTestId('stream-run-control-switch'))
    await waitFor(() => expect(stopRuntimeStream).toHaveBeenCalledWith(10))
    expect(startRuntimeStream).not.toHaveBeenCalled()
  })

  it('does not autosave a hydrated stream before the operator edits it', async () => {
    signIn('OPERATOR')
    renderStreamEdit()
    await screen.findByTestId('wizard-save-now')
    await new Promise((resolve) => window.setTimeout(resolve, 1500))
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
  })

  it('keeps a created route id on a newer in-flight draft', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    hydrateHolder.factory = () => {
      const state = hydratedStream()
      state.destinations.routeDrafts = [
        {
          key: 'wr-a',
          destinationId: 5,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: {
            transform: true,
            protection: true,
            classification: true,
            policy: true,
          },
        },
      ]
      return state
    }
    let releaseSave: (value: { ok: boolean; errors: string[]; routeIdsByDraftKey: Record<string, number> }) => void = () => {}
    let persistCalls = 0
    persistWizardStreamEdits.mockImplementation(() => {
      persistCalls += 1
      if (persistCalls === 1) {
        return new Promise((resolve) => {
          releaseSave = resolve
        })
      }
      return Promise.resolve({ ok: true, errors: [], routeIdsByDraftKey: { 'route-55': 55 } })
    })
    renderStreamEdit()
    await screen.findByTestId('wizard-save-now')
    await user.click(screen.getByTestId('wizard-connect-tab-request'))
    const name = screen.getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Attempt A')
    await user.click(screen.getByTestId('wizard-save-now'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    const firstState = persistWizardStreamEdits.mock.calls[0]?.[1] as { destinations: { routeDrafts: Array<{ key: string }> }; stream: { name: string } }
    expect(firstState.destinations.routeDrafts[0]?.key).toBe('wr-a')
    await user.clear(name)
    await user.type(name, 'Attempt B')
    releaseSave({ ok: true, errors: [], routeIdsByDraftKey: { 'wr-a': 55 } })
    await waitFor(() => expect(screen.getByTestId('wizard-save-now')).toBeEnabled())
    await user.click(screen.getByTestId('wizard-save-now'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(2))
    const secondState = persistWizardStreamEdits.mock.calls[1]?.[1] as {
      destinations: { routeDrafts: Array<{ key: string; failurePolicy: string }> }
      stream: { name: string }
    }
    expect(secondState.stream.name).toBe('Attempt B')
    expect(secondState.destinations.routeDrafts[0]?.key).toBe('route-55')
  })

  it('keeps Stop available while Run Now is in flight on an active stream', async () => {
    signIn('OPERATOR')
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'RUNNING' })
    let releaseRun: (value: unknown) => void = () => {}
    runStreamOnce.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRun = resolve
        }),
    )
    renderStreamEdit()
    await waitFor(() => expect(screen.getByTestId('stream-run-control-switch')).toHaveTextContent('Running'))
    fireEvent.click(screen.getByRole('button', { name: 'Run Now' }))
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled()
    expect(screen.getByTestId('stream-run-control-switch')).toBeEnabled()
    fireEvent.click(screen.getByTestId('stream-run-control-switch'))
    await waitFor(() => expect(stopRuntimeStream).toHaveBeenCalledWith(10))
    releaseRun({ outcome: 'completed', runtime_run_id: null })
  })

  it('uses one Run Once controller for the header and the deploy card', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    let releaseRun: (value: unknown) => void = () => {}
    runStreamOnce.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRun = resolve
        }),
    )
    renderStreamEdit()
    await screen.findByTestId('edit-stream-wizard')
    const page = wizard()
    await user.click(await page.findByTestId('wizard-stepper-deploy'))
    await user.click(await page.findByRole('button', { name: 'Run Once' }))
    await waitFor(() => expect(page.getAllByRole('button', { name: 'Running…' })).toHaveLength(2))
    for (const button of page.getAllByRole('button', { name: 'Running…' })) {
      expect(button).toBeDisabled()
    }
    expect(runStreamOnce).toHaveBeenCalledTimes(1)
    releaseRun({
      outcome: 'completed',
      runtime_run_id: 'run-shared',
      route_delivery_success_count: 0,
      route_delivery_failure_count: 0,
      route_delivery_blocked_count: 0,
      route_delivery_review_count: 0,
      route_delivery_quarantine_count: 0,
      route_delivery_attempt_count: 0,
    })
    expect(await page.findByTestId('deploy-delivery-proof')).toBeInTheDocument()
    expect(runStreamOnce).toHaveBeenCalledTimes(1)
  })
})
