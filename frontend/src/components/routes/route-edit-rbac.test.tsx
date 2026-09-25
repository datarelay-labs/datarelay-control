import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, persistSession, type SessionRole } from '../../auth/session'
import { RouteEditPage } from './route-edit-page'

const fetchRouteById = vi.hoisted(() => vi.fn())
const updateRoute = vi.hoisted(() => vi.fn())
const createRoute = vi.hoisted(() => vi.fn())
const saveRouteMappingUiConfig = vi.hoisted(() => vi.fn())
const saveRouteEnrichmentUiConfig = vi.hoisted(() => vi.fn())
const patchRouteProtectionRule = vi.hoisted(() => vi.fn())
const patchRouteClassificationRule = vi.hoisted(() => vi.fn())
const patchRoutePolicyRule = vi.hoisted(() => vi.fn())
const runRouteDeliveryPreview = vi.hoisted(() => vi.fn())

vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
  fetchRouteByIdFresh: (...args: unknown[]) => fetchRouteById(...args),
  updateRoute: (...args: unknown[]) => updateRoute(...args),
  createRoute: (...args: unknown[]) => createRoute(...args),
  isRouteStaleWriteError: () => false,
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: vi.fn(async () => ({ id: 10, name: 'Stream A', connector_id: 1 })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => ({ id: 1, name: 'Connector A' })),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => [{ id: 5, name: 'Dest A' }]),
}))

vi.mock('../../api/gdcRouteTransform', () => ({
  fetchRouteMappingUiConfig: vi.fn(async () => ({
    route_id: 42,
    inherit_stream_mapping: true,
    mapping: { field_mappings: {} },
  })),
  fetchRouteEnrichmentUiConfig: vi.fn(async () => ({
    route_id: 42,
    inherit_stream_enrichment: true,
    enrichment: { enrichment: {} },
  })),
  fetchRouteTransformEffective: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    mapping_source: 'stream',
    enrichment_source: 'stream',
    fallback_used: true,
    mapping_count: 0,
    enrichment_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  saveRouteMappingUiConfig: (...args: unknown[]) => saveRouteMappingUiConfig(...args),
  saveRouteEnrichmentUiConfig: (...args: unknown[]) => saveRouteEnrichmentUiConfig(...args),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 1,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  fetchRouteProtectionRules: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    protection_enabled: true,
    rules: [
      {
        id: 7,
        route_id: 42,
        stream_id: 10,
        field_path: '$.email',
        sensitivity_class: 'pii',
        protection_mode: 'partial_mask',
        enabled: true,
        source_finding_id: null,
        created_by: 'operator',
        created_at: '2026-06-14T10:00:00Z',
        updated_at: '2026-06-14T10:00:00Z',
      },
    ],
    rule_count: 1,
  })),
  patchRouteProtectionRule: (...args: unknown[]) => patchRouteProtectionRule(...args),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 1,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  fetchRouteClassificationRules: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    rules: [
      {
        id: 9,
        route_id: 42,
        stream_id: 10,
        name: 'pii-internal',
        enabled: true,
        condition_json: { sensitivity_class: 'pii' },
        classification_level: 'INTERNAL',
        created_at: '2026-06-14T10:00:00Z',
        updated_at: '2026-06-14T10:00:00Z',
      },
    ],
    rule_count: 1,
  })),
  patchRouteClassificationRule: (...args: unknown[]) => patchRouteClassificationRule(...args),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 1,
    processing_status: 'Inherited',
  })),
  fetchRoutePolicyRules: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    rules: [
      {
        id: 9,
        route_id: 42,
        stream_id: 10,
        name: 'pii-audit',
        enabled: true,
        condition_json: { sensitivity_class: 'pii' },
        action_type: 'audit_only',
        created_at: '2026-06-14T10:00:00Z',
        updated_at: '2026-06-14T10:00:00Z',
      },
    ],
    rule_count: 1,
  })),
  patchRoutePolicyRule: (...args: unknown[]) => patchRoutePolicyRule(...args),
}))

vi.mock('../../api/gdcRuntime', () => ({
  searchRuntimeDeliveryLogs: vi.fn(async () => ({ logs: [] })),
}))

vi.mock('../../api/gdcRuntimePreview', async () => {
  const actual = await vi.importActual<typeof import('../../api/gdcRuntimePreview')>(
    '../../api/gdcRuntimePreview',
  )
  return {
    ...actual,
    runRouteDeliveryPreview: (...args: unknown[]) => runRouteDeliveryPreview(...args),
  }
})

vi.mock('../../utils/mappingSourceSample', async () => {
  const actual = await vi.importActual<typeof import('../../utils/mappingSourceSample')>(
    '../../utils/mappingSourceSample',
  )
  return {
    ...actual,
    loadMappingWorkspaceContext: vi.fn(async () => null),
    fetchMappingSourceSample: vi.fn(async () => null),
  }
})

vi.mock('./route-detail-health-panel', () => ({
  RouteDetailHealthPanel: () => <div data-testid="route-detail-health-panel" />,
}))

const savedRoute = {
  id: 42,
  name: 'Route A',
  description: 'desc',
  enabled: true,
  stream_id: 10,
  destination_id: 5,
  failure_policy: 'LOG_AND_CONTINUE',
  formatter_config_json: { delivery_mode: 'Reliable' },
  rate_limit_json: { enabled: false },
  updated_at: '2026-09-21T10:00:00Z',
}

function signIn(role: SessionRole, capabilities?: Record<string, boolean>) {
  persistSession({
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user: { username: role.toLowerCase(), role, status: 'ACTIVE', capabilities },
  })
}

function renderRouteEdit(path = '/routes/42/edit') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/routes/:routeId/edit" element={<RouteEditPage />} />
        <Route path="/routes/new" element={<RouteEditPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RouteEditPage workspace capability visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    fetchRouteById.mockResolvedValue(savedRoute)
    updateRoute.mockResolvedValue({ ...savedRoute, name: 'Route B' })
    createRoute.mockResolvedValue({ ...savedRoute, id: 99 })
    runRouteDeliveryPreview.mockResolvedValue({
      route_id: 42,
      destination_id: 5,
      destination_type: 'WEBHOOK_POST',
      route_enabled: true,
      destination_enabled: true,
      message_count: 1,
      resolved_formatter_config: {},
      preview_messages: [{ body: '{}' }],
    })
  })

  afterEach(() => {
    clearSession()
  })

  it('keeps a viewer on read-only route edit without mutation requests', async () => {
    const user = userEvent.setup()
    signIn('VIEWER')
    renderRouteEdit()

    expect(await screen.findByTestId('route-edit-readonly-banner')).toHaveTextContent(/Read-only session/i)
    expect(screen.getByTestId('route-detail-health-panel')).toBeInTheDocument()
    expect(screen.getByTestId('route-edit-cancel')).toBeEnabled()
    expect(screen.queryByTestId('route-edit-save')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-edit-tab-transform')).toBeEnabled()
    expect(screen.getByTestId('route-edit-tab-protection')).toBeEnabled()
    expect(screen.getByTestId('route-edit-tab-classification')).toBeEnabled()
    expect(screen.getByTestId('route-edit-tab-policy')).toBeEnabled()

    const routeName = await screen.findByRole('textbox', { name: /Route Name/i })
    expect(routeName).toBeDisabled()
    expect(routeName).toHaveValue('Route A')

    const preview = screen.getByTestId('route-edit-preview-delivery')
    expect(preview).toBeEnabled()
    await user.click(preview)
    await waitFor(() => {
      expect(runRouteDeliveryPreview).toHaveBeenCalledWith(
        expect.objectContaining({ route_id: 42 }),
      )
    })

    await user.click(screen.getByTestId('route-edit-tab-transform'))
    const inherit = await screen.findByTestId('route-transform-inherit')
    expect(inherit).toBeDisabled()
    fireEvent.click(inherit)
    expect(screen.queryByTestId('route-transform-save')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('route-edit-tab-protection'))
    const protectionRules = await screen.findByTestId('protection-rules-table')
    expect(within(protectionRules).queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('route-edit-tab-classification'))
    const classificationRow = await screen.findByTestId('classification-rule-row-9')
    expect(within(classificationRow).queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('route-edit-tab-policy'))
    const policyRow = await screen.findByTestId('policy-rule-row-9')
    expect(within(policyRow).queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()

    expect(updateRoute).not.toHaveBeenCalled()
    expect(createRoute).not.toHaveBeenCalled()
    expect(saveRouteMappingUiConfig).not.toHaveBeenCalled()
    expect(saveRouteEnrichmentUiConfig).not.toHaveBeenCalled()
    expect(patchRouteProtectionRule).not.toHaveBeenCalled()
    expect(patchRouteClassificationRule).not.toHaveBeenCalled()
    expect(patchRoutePolicyRule).not.toHaveBeenCalled()
  })

  it('hides create for a viewer opening a new route', async () => {
    signIn('VIEWER')
    renderRouteEdit('/routes/new')
    expect(await screen.findByRole('heading', { name: 'New Route' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Route' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Route Name/i })).toBeDisabled()
    expect(createRoute).not.toHaveBeenCalled()
    expect(updateRoute).not.toHaveBeenCalled()
  })

  it('keeps route save available for an operator', async () => {
    const user = userEvent.setup()
    signIn('OPERATOR')
    renderRouteEdit()

    const page = await screen.findByTestId('route-edit-page')
    const routeName = await within(page).findByRole('textbox', { name: /Route Name/i })
    expect(routeName).toBeEnabled()
    await waitFor(() => expect(routeName).toHaveValue('Route A'))
    expect(screen.queryByTestId('route-edit-readonly-banner')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('route-edit-tab-protection'))
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeEnabled()
    await user.click(screen.getByTestId('route-edit-tab-transform'))
    expect(await screen.findByTestId('route-transform-save')).toBeInTheDocument()
    expect(screen.getByTestId('route-transform-inherit')).toBeEnabled()

    await user.click(screen.getByTestId('route-edit-tab-delivery'))
    fireEvent.change(screen.getByRole('textbox', { name: /Route Name/i }), { target: { value: 'Route B' } })
    await user.click(screen.getByTestId('route-edit-save'))

    await waitFor(() => {
      expect(updateRoute).toHaveBeenCalled()
    })
  })

  it('keeps route save available for an administrator', async () => {
    signIn('ADMINISTRATOR')
    renderRouteEdit()
    expect(await screen.findByTestId('route-edit-save')).toHaveTextContent('Save Route')
    expect(screen.getByRole('textbox', { name: /Route Name/i })).toBeEnabled()
    expect(screen.queryByTestId('route-edit-readonly-banner')).not.toBeInTheDocument()
  })

  it('honors a server capability override that grants workspace mutations', async () => {
    signIn('VIEWER', { workspace_mutations: true })
    renderRouteEdit()
    expect(await screen.findByTestId('route-edit-save')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Route Name/i })).toBeEnabled()
    expect(screen.queryByTestId('route-edit-readonly-banner')).not.toBeInTheDocument()
  })
})
