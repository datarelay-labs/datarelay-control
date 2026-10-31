import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { DataRouterEnabledContext } from '../../router/data-router-enabled'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchStreamById } from '../../api/gdcStreams'
import { fetchStreamMappingUiConfig } from '../../api/gdcRuntime'
import { clearSession, persistSession, type SessionRole } from '../../auth/session'
import { StreamEditWizardPage } from './stream-edit-wizard-page'
import {
  loadStreamEditDraft,
  saveStreamEditDraft,
  streamEditDraftStorageKey,
} from './wizard/wizard-edit-draft'
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

vi.mock('../../api/gdcAdmin', () => ({
  getAdminConfigVersions: vi.fn(async () => ({ total: 0, items: [] })),
  getAdminSafeRollbackPreview: vi.fn(),
  applyAdminConfigSnapshot: vi.fn(),
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
        <Route path="/streams/:streamId/runtime" element={<p>Stream monitoring workspace</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderEmbeddedStreamEdit(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter initialEntries={['/routes']}>
        <StreamEditWizardPage streamIdOverride={10} embedded onClose={onClose} />
      </MemoryRouter>,
    ),
  }
}


function renderStreamEditWithDataRouter(initialEntries: string[] = ['/streams/10/edit'], initialIndex?: number) {
  // Same one-splat RouterProvider and data-router context as the application entrypoint.
  const router = createMemoryRouter([{
    path: '/*',
    element: (
      <DataRouterEnabledContext.Provider value>
        <nav><Link to="/monitoring" data-testid="edit-external-nav">Dashboard</Link></nav>
        <Routes>
          <Route path="/streams/:streamId/edit" element={<StreamEditWizardPage />} />
          <Route path="/streams/:streamId/runtime" element={<p>Stream monitoring workspace</p>} />
          <Route path="/destinations" element={<p>Destination management workspace</p>} />
          <Route path="/monitoring" element={<p>Dashboard workspace</p>} />
        </Routes>
      </DataRouterEnabledContext.Provider>
    ),
  }], { initialEntries, initialIndex })
  render(<RouterProvider router={router} />)
  return router
}

describe('StreamEditWizardPage workspace capability visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    localStorage.removeItem(streamEditDraftStorageKey(10))
    hydrateHolder.factory = () => hydratedStream()
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'STOPPED' })
    persistWizardStreamEdits.mockResolvedValue({ ok: true, errors: [] })
    startRuntimeStream.mockResolvedValue({ message: 'stream started' })
    stopRuntimeStream.mockResolvedValue({ message: 'stream stopped', status: 'STOPPED', terminal: true })
  })

  afterEach(() => {
    localStorage.removeItem(streamEditDraftStorageKey(10))
    clearSession()
  })

  it('shows a load error instead of an endless spinner when Stream hydration rejects', async () => {
    signIn('OPERATOR')
    hydrateHolder.factory = () => {
      throw new Error('Route catalog request failed')
    }
    renderStreamEdit()
    expect(await screen.findByText('Could not load stream configuration.')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-stream-wizard')).not.toBeInTheDocument()
  })

  it('uses the provided Stream identity in embedded mode and closes without a cross-page navigation', async () => {
    signIn('OPERATOR')
    const { onClose } = renderEmbeddedStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')

    expect(fetchStreamById).toHaveBeenCalledWith(10)
    expect(within(page).getByRole('button', { name: 'Close Stream configuration' })).toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    fireEvent.click(within(page).getByRole('button', { name: 'Close Stream configuration' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('preserves existing protection settings after Add field in Stream Edit', async () => {
    signIn('OPERATOR')
    hydrateHolder.factory = () => {
      const result = hydratedStream()
      result.destinations.routeDrafts = [{
        key: 'route-1',
        destinationId: 5,
        enabled: true,
        failurePolicy: 'LOG_AND_CONTINUE',
        rateLimitJson: {},
        inherit: { transform: true, protection: true, classification: true, policy: true },
      }]
      return result
    }
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    fireEvent.click(within(page).getByTestId('wizard-stepper-route_processing'))
    fireEvent.click(await within(page).findByTestId('shared-processing-tab-data_protection'))
    const add = await within(page).findByTestId('data-protection-add-row')
    fireEvent.click(add)
    expect(within(page).getByPlaceholderText('$.email')).toBeInTheDocument()
    expect(within(page).getByTestId('wizard-save-now')).toBeEnabled()
    fireEvent.click(within(page).getByTestId('wizard-stepper-deploy'))
    expect(within(page).getByTestId('deploy-created-panel')).toBeInTheDocument()
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
    const lifecycle = page.getByTestId('stream-configuration-lifecycle')
    expect(within(lifecycle).getByTestId('stream-lifecycle-draft')).toHaveTextContent('No pending draft changes')
    expect(within(lifecycle).getByTestId('stream-lifecycle-saved')).toHaveTextContent('Saved configuration confirmed')
    expect(within(lifecycle).getByTestId('stream-lifecycle-runtime')).toHaveTextContent(
      'Stopped · no running revision is active',
    )
    expect(lifecycle).not.toHaveTextContent(/applied/i)
    expect(page.getByText(/saving does not start or restart the Stream/i)).toBeInTheDocument()

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

  it('releases the Deploy start action after a failed runtime start so the operator can retry', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    startRuntimeStream.mockRejectedValueOnce(new Error('scheduler unavailable'))
    renderStreamEdit()

    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-stepper-deploy'))
    const start = await within(page).findByRole('button', { name: 'Start Stream' })
    await user.click(start)

    expect(await within(page).findByText(/Runtime start failed · scheduler unavailable/i)).toBeInTheDocument()
    await waitFor(() => expect(within(page).getByRole('button', { name: 'Start Stream' })).toBeEnabled())

    await user.click(within(page).getByRole('button', { name: 'Start Stream' }))
    await waitFor(() => expect(startRuntimeStream).toHaveBeenCalledTimes(2))
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
    const manage = await within(page).findByRole('link', { name: 'Manage all destinations' })
    expect(within(page).queryByTestId('wizard-destination-resume-guidance')).not.toBeInTheDocument()
    await user.click(manage)
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/Save now/)
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()

    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByRole('link', { name: 'Manage all destinations' }))
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
    await user.click(await within(page).findByRole('link', { name: 'Manage all destinations' }))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent('still saving')
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()

    resolveSave({ ok: true, errors: [] })
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByRole('link', { name: 'Manage all destinations' }))
    expect(await screen.findByText('Destination management workspace')).toBeInTheDocument()
  })

  it('blocks Back to monitoring until an edited Stream is confirmed saved', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' unsaved')
    await user.click(within(page).getByRole('button', { name: 'Back to monitoring' }))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/Save now/)
    expect(screen.queryByText('Stream monitoring workspace')).not.toBeInTheDocument()
    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByRole('button', { name: 'Back to monitoring' }))
    expect(await screen.findByText('Stream monitoring workspace')).toBeInTheDocument()
  })

  it('blocks Review Open monitoring navigation while changes are unconfirmed', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' unsaved')
    await user.click(within(page).getByTestId('wizard-stepper-deploy'))
    await user.click(within(page).getByTestId('wizard-open-monitoring'))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/Save now/)
    expect(screen.queryByText('Stream monitoring workspace')).not.toBeInTheDocument()
    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(within(page).getByTestId('wizard-open-monitoring'))
    expect(await screen.findByText('Stream monitoring workspace')).toBeInTheDocument()
  })

  it('allows read-only Stream inspection to navigate to destination management without a write', async () => {
    const user = userEvent.setup()
    signIn('VIEWER')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-stepper-destinations'))
    await user.click(await within(page).findByRole('link', { name: 'Manage all destinations' }))
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
    await user.click(await within(page).findByRole('link', { name: 'Manage all destinations' }))
    expect(screen.getByTestId('edit-stream-wizard')).toBeInTheDocument()
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/save failed/i)
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

  it('releases the runtime control after a failed Stop so the operator can retry', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'RUNNING' })
    stopRuntimeStream.mockRejectedValueOnce(new Error('receiver busy'))
    renderStreamEdit()

    const toggle = await screen.findByTestId('stream-run-control-switch')
    await waitFor(() => expect(toggle).toHaveTextContent('Running'))
    await user.click(toggle)

    expect(await screen.findByText(/Runtime stop failed · receiver busy/i)).toBeInTheDocument()
    await waitFor(() => expect(toggle).toBeEnabled())

    await user.click(toggle)
    await waitFor(() => expect(stopRuntimeStream).toHaveBeenCalledTimes(2))
    expect(startRuntimeStream).not.toHaveBeenCalled()
  })

  it('does not autosave a hydrated stream before the operator edits it', async () => {
    signIn('OPERATOR')
    renderStreamEdit()
    await screen.findByTestId('wizard-save-now')
    await new Promise((resolve) => window.setTimeout(resolve, 1500))
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
    expect(loadStreamEditDraft(10)).toBeNull()
  })

  it('auto-preserves dirty Stream edits only in the per-Stream local draft', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Locally preserved edit')

    await waitFor(() => {
      expect(loadStreamEditDraft(10)?.state.stream.name).toBe('Locally preserved edit')
    }, { timeout: 3000 })

    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
    expect(within(page).getByTestId('stream-lifecycle-draft')).toHaveTextContent(
      'Local draft saved · not applied',
    )
    expect(within(page).getByText(/auto-save only to this browser/i)).toBeInTheDocument()
  })

  it('restores a matching per-Stream local draft without replacing server identity', async () => {
    const draft = hydratedStream()
    draft.stream.name = 'Restored local Stream name'
    saveStreamEditDraft(10, draft, 'destinations')

    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')

    expect(await within(page).findByTestId('edit-stream-destinations')).toBeInTheDocument()
    await waitFor(() => {
      expect(within(page).getByTestId('stream-lifecycle-draft')).toHaveTextContent(
        'Local draft saved · not applied',
      )
    }, { timeout: 3000 })
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
  })

  it('does not write a dirty running Stream and keeps the local draft while Stop remains available', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'RUNNING' })
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await waitFor(() => expect(within(page).getByTestId('stream-run-control-switch')).toHaveTextContent('Running'))
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' local-only')

    await waitFor(() => expect(loadStreamEditDraft(10)).not.toBeNull(), { timeout: 3000 })
    expect(within(page).getByTestId('wizard-save-now')).toBeDisabled()
    expect(within(page).getByTestId('wizard-apply-and-start')).toBeDisabled()
    expect(within(page).getByTestId('stream-run-control-switch')).toBeEnabled()
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
  })

  it('Apply & start saves the reviewed draft before starting the Stream', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await waitFor(() => expect(within(page).getByTestId('wizard-apply-and-start')).toBeEnabled())
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Apply then start')

    await user.click(within(page).getByTestId('wizard-apply-and-start'))

    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(startRuntimeStream).toHaveBeenCalledWith(10))
    expect(persistWizardStreamEdits.mock.invocationCallOrder[0]).toBeLessThan(
      startRuntimeStream.mock.invocationCallOrder[0]!,
    )
  })

  it('Apply & start never starts a stale reviewed revision when the draft changes during save', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    let releaseSave: (value: { ok: boolean; errors: string[] }) => void = () => {}
    persistWizardStreamEdits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = resolve
        }),
    )
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await waitFor(() => expect(within(page).getByTestId('wizard-apply-and-start')).toBeEnabled())
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    const name = within(page).getByPlaceholderText('e.g. Cybereason Malop Stream')
    await user.clear(name)
    await user.type(name, 'Reviewed revision')

    await user.click(within(page).getByTestId('wizard-apply-and-start'))
    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))

    await user.clear(name)
    await user.type(name, 'Newer local draft')
    releaseSave({ ok: true, errors: [] })

    expect(await within(page).findByText(/draft changed while saving/i)).toBeInTheDocument()
    expect(startRuntimeStream).not.toHaveBeenCalled()
    expect(name).toHaveValue('Newer local draft')
  })

  it('Apply & start never starts when the explicit platform save fails', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    persistWizardStreamEdits.mockResolvedValueOnce({ ok: false, errors: ['save rejected'] })
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await waitFor(() => expect(within(page).getByTestId('wizard-apply-and-start')).toBeEnabled())
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' failed apply')

    await user.click(within(page).getByTestId('wizard-apply-and-start'))

    await waitFor(() => expect(persistWizardStreamEdits).toHaveBeenCalledTimes(1))
    expect(startRuntimeStream).not.toHaveBeenCalled()
    expect(within(page).getByText(/save rejected/i)).toBeInTheDocument()
  })

  it('does not claim Running when activation fails after the reviewed save', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    startRuntimeStream.mockResolvedValueOnce(null)
    vi.mocked(fetchStreamById).mockResolvedValue({ id: 10, name: 'Viewer Stream', status: 'STOPPED' })
    renderStreamEdit()
    const page = await screen.findByTestId('edit-stream-wizard')
    await waitFor(() => expect(within(page).getByTestId('wizard-apply-and-start')).toBeEnabled())
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' activation failure')

    await user.click(within(page).getByTestId('wizard-apply-and-start'))

    await waitFor(() => expect(startRuntimeStream).toHaveBeenCalledWith(10))
    expect(await within(page).findByText(/start failed or could not be verified/i)).toBeInTheDocument()
    expect(within(page).getByTestId('stream-lifecycle-runtime')).toHaveTextContent(/^RuntimeStopped/)
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
    const runNow = screen.getByRole('button', { name: 'Run Now' })
    await waitFor(() => expect(runNow).toBeEnabled(), { timeout: 5_000 })
    fireEvent.click(runNow)
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled(),
      { timeout: 5_000 },
    )
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

  it('blocks an external sidebar route while Stream edits are unconfirmed and allows it after a verified save', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    const router = renderStreamEditWithDataRouter()
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' pending edit')

    await user.click(screen.getByTestId('edit-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/streams/10/edit'))
    expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/Save now/)
    expect(screen.queryByText('Dashboard workspace')).not.toBeInTheDocument()

    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await user.click(screen.getByTestId('edit-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
  })

  it('rejects browser Back with unsaved Stream edits without breaking same-page wizard query navigation', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    const router = renderStreamEditWithDataRouter(['/monitoring', '/streams/10/edit'], 1)
    const page = await screen.findByTestId('edit-stream-wizard')
    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' unsaved back')

    await router.navigate('/streams/10/edit?step=destinations')
    expect(router.state.location.pathname).toBe('/streams/10/edit')
    expect(router.state.location.search).toBe('?step=destinations')

    await router.navigate(-1)
    expect(router.state.location.pathname).toBe('/streams/10/edit')
    await router.navigate(-1)
    await waitFor(() => expect(router.state.location.pathname).toBe('/streams/10/edit'))
    await waitFor(() => expect(within(page).getByTestId('edit-navigation-notice')).toHaveTextContent(/Save now/))

    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    await router.navigate(-1)
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
  })

  it('prevents hard reload only while an editable Stream has unconfirmed changes', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderStreamEditWithDataRouter()
    const page = await screen.findByTestId('edit-stream-wizard')
    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    expect(cleanUnload.defaultPrevented).toBe(false)

    await user.click(within(page).getByTestId('wizard-connect-tab-request'))
    await user.type(within(page).getByPlaceholderText('e.g. Cybereason Malop Stream'), ' unsaved reload')
    const dirtyUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyUnload)
    expect(dirtyUnload.defaultPrevented).toBe(true)

    await user.click(within(page).getByTestId('wizard-save-now'))
    await waitFor(() => expect(within(page).getByText('Changes saved')).toBeInTheDocument())
    const savedUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(savedUnload)
    expect(savedUnload.defaultPrevented).toBe(false)
  })

  it('does not restrict Viewer navigation away from a read-only Stream', async () => {
    const user = userEvent.setup()
    signIn('VIEWER')
    const router = renderStreamEditWithDataRouter()
    await screen.findByTestId('edit-stream-wizard')
    await user.click(screen.getByTestId('edit-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
    expect(persistWizardStreamEdits).not.toHaveBeenCalled()
  })
})
