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
const fetchRouteMappingUiConfig = vi.hoisted(() => vi.fn())
const fetchRouteEnrichmentUiConfig = vi.hoisted(() => vi.fn())
const fetchMappingSourceSample = vi.hoisted(() => vi.fn())
const runTransformPreview = vi.hoisted(() => vi.fn())
const runMappingValidate = vi.hoisted(() => vi.fn())
const runMappingDraftPreview = vi.hoisted(() => vi.fn())
const runFinalEventDraftPreview = vi.hoisted(() => vi.fn())

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
  fetchRouteMappingUiConfig: (...args: unknown[]) => fetchRouteMappingUiConfig(...args),
  fetchRouteEnrichmentUiConfig: (...args: unknown[]) => fetchRouteEnrichmentUiConfig(...args),
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
    runTransformPreview: (...args: unknown[]) => runTransformPreview(...args),
    runMappingValidate: (...args: unknown[]) => runMappingValidate(...args),
    runMappingDraftPreview: (...args: unknown[]) => runMappingDraftPreview(...args),
    runFinalEventDraftPreview: (...args: unknown[]) => runFinalEventDraftPreview(...args),
  }
})

vi.mock('../../utils/mappingSourceSample', async () => {
  const actual = await vi.importActual<typeof import('../../utils/mappingSourceSample')>(
    '../../utils/mappingSourceSample',
  )
  return {
    ...actual,
    loadMappingWorkspaceContext: vi.fn(async () => null),
    fetchMappingSourceSample: (...args: unknown[]) => fetchMappingSourceSample(...args),
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

const inheritedMapping = {
  route_id: 42,
  inherit_stream_mapping: true,
  mapping: { field_mappings: {} },
}

const inheritedEnrichment = {
  route_id: 42,
  inherit_stream_enrichment: true,
  enrichment: { enrichment: {} },
}

const overrideMapping = {
  route_id: 42,
  inherit_stream_mapping: false,
  mapping: {
    field_mappings: {
      dest: '$.src',
      transform_rules: [
        {
          mode: 'jsonata',
          output_field: 'event_source',
          expression: 'vendor & product',
        },
      ],
    },
    event_array_path: '$.items',
  },
}

const overrideSample = {
  ok: true,
  sourceType: 'HTTP_API_POLLING' as const,
  rawPayload: { src: 'a', vendor: 'v', product: 'p' },
  treeDocument: { src: 'a', vendor: 'v', product: 'p' },
  extractedEvents: [{ src: 'a', vendor: 'v', product: 'p' }],
  unionSchema: null,
  eventArrayPath: '',
  eventRootPath: '$',
  sampleEventIndex: 0,
  message: null,
  recordsLabel: '1',
  fetchedAt: '2026-09-25T00:00:00Z',
}

const overrideEnrichment = {
  route_id: 42,
  inherit_stream_enrichment: false,
  enrichment: { enrichment: {} },
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
    fetchRouteMappingUiConfig.mockResolvedValue(inheritedMapping)
    fetchRouteEnrichmentUiConfig.mockResolvedValue(inheritedEnrichment)
    fetchMappingSourceSample.mockResolvedValue(null)
    runTransformPreview.mockResolvedValue({
      transformed_result: { event_source: 'vp' },
      message: 'ok',
      save_blocked: false,
      warnings: [],
      errors: [],
      field_results: [],
    })
    runMappingValidate.mockResolvedValue({ warnings: [] })
    runMappingDraftPreview.mockResolvedValue({ mapped_events: [{ dest: 'a' }], preview_event_count: 1, missing_fields: [] })
    runFinalEventDraftPreview.mockResolvedValue({ final_events: [{ dest: 'a' }] })
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

  it('lets a viewer inspect a transform override without mutation requests', async () => {
    const user = userEvent.setup()
    fetchRouteMappingUiConfig.mockResolvedValue(overrideMapping)
    fetchRouteEnrichmentUiConfig.mockResolvedValue(overrideEnrichment)
    fetchMappingSourceSample.mockResolvedValue(overrideSample)
    signIn('VIEWER')
    renderRouteEdit()

    await user.click(await screen.findByTestId('route-edit-tab-transform'))
    const panel = await screen.findByTestId('route-edit-transform-panel')
    const modes = within(panel).getByRole('tablist', { name: 'Mapping mode' })
    const advanced = within(modes).getByRole('tab', { name: /Advanced/ })
    const expert = within(modes).getByRole('tab', { name: /Expert/ })
    const basic = within(modes).getByRole('tab', { name: /Basic/ })
    expect(advanced).toBeEnabled()
    expect(expert).toBeEnabled()
    expect(basic).toBeEnabled()

    await user.click(advanced)
    const expression = await within(panel).findByDisplayValue('vendor & product')
    expect(expression).toBeDisabled()
    expect(within(panel).getByRole('button', { name: 'Add JSONata rule' })).toBeDisabled()
    expect(within(panel).getByRole('button', { name: 'Remove rule' })).toBeDisabled()
    const preview = within(panel).getByRole('button', { name: 'Preview' })
    expect(preview).toBeEnabled()
    await user.click(preview)
    await waitFor(() => {
      expect(runTransformPreview).toHaveBeenCalled()
    })

    await user.click(expert)
    expect(within(panel).getByRole('button', { name: 'Add Regex extract rule' })).toBeDisabled()

    await user.click(basic)
    const transformed = within(panel).getByRole('button', { name: 'Transformed' })
    const tableView = within(panel).getByRole('button', { name: 'Table' })
    expect(transformed).toBeEnabled()
    expect(tableView).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'JSON' })).toBeEnabled()
    await user.click(transformed)
    await user.click(tableView)
    expect(within(panel).getByRole('button', { name: 'Add row' })).toBeDisabled()
    for (const button of within(panel).getAllByRole('button', { name: 'Edit row' })) {
      expect(button).toBeDisabled()
    }
    for (const button of within(panel).getAllByRole('button', { name: 'Delete row' })) {
      expect(button).toBeDisabled()
    }
    expect(within(panel).getByRole('textbox', { name: /Event array path/i })).toBeDisabled()
    expect(within(panel).getByRole('searchbox', { name: 'Search mapping rows' })).toBeEnabled()

    expect(saveRouteMappingUiConfig).not.toHaveBeenCalled()
    expect(saveRouteEnrichmentUiConfig).not.toHaveBeenCalled()
    expect(updateRoute).not.toHaveBeenCalled()
  })

  it('keeps transform override editing available for an operator', async () => {
    const user = userEvent.setup()
    fetchRouteMappingUiConfig.mockResolvedValue(overrideMapping)
    fetchRouteEnrichmentUiConfig.mockResolvedValue(overrideEnrichment)
    fetchMappingSourceSample.mockResolvedValue(overrideSample)
    signIn('OPERATOR')
    renderRouteEdit()

    await user.click(await screen.findByTestId('route-edit-tab-transform'))
    const panel = await screen.findByTestId('route-edit-transform-panel')
    expect(within(panel).getByTestId('route-transform-save')).toBeInTheDocument()
    const modes = within(panel).getByRole('tablist', { name: 'Mapping mode' })
    await user.click(within(modes).getByRole('tab', { name: /Advanced/ }))
    expect(await within(panel).findByDisplayValue('vendor & product')).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Add JSONata rule' })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Preview' })).toBeEnabled()
    await user.click(within(modes).getByRole('tab', { name: /Basic/ }))
    expect(within(panel).getByRole('button', { name: 'Add row' })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Transformed' })).toBeEnabled()
  })

  it('links an existing route into governance workspace with resolved stream context', async () => {
    signIn('OPERATOR')
    renderRouteEdit()
    const link = await screen.findByTestId('route-edit-governance-workspace-link')
    await waitFor(() => {
      expect(link).toHaveAttribute('href', '/governance/workspace?stream_id=10&route_id=42')
    })
  })

  it('hides the governance workspace link for a viewer', async () => {
    signIn('VIEWER')
    renderRouteEdit()
    expect(await screen.findByTestId('route-edit-page')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: /Route Name/i })).toHaveValue('Route A'))
    expect(screen.queryByTestId('route-edit-governance-workspace-link')).not.toBeInTheDocument()
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
