import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteEditPage } from './route-edit-page'

const fetchRouteById = vi.fn()
const fetchStreamById = vi.fn()
const fetchConnectorById = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRouteProtectionRules = vi.fn()
const fetchRoutePolicyEffective = vi.fn()
const patchRouteProtectionRule = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
  fetchRouteByIdFresh: (...args: unknown[]) => fetchRouteById(...args),
  updateRoute: vi.fn(),
  createRoute: vi.fn(),
  isRouteStaleWriteError: (err: unknown) =>
    err instanceof Error && /ROUTE_STALE_WRITE/i.test(err.message),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: (...args: unknown[]) => fetchConnectorById(...args),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

vi.mock('../../api/gdcRouteTransform', () => ({
  fetchRouteMappingUiConfig: vi.fn(),
  fetchRouteEnrichmentUiConfig: vi.fn(),
  fetchRouteTransformEffective: (...args: unknown[]) => fetchRouteTransformEffective(...args),
  saveRouteMappingUiConfig: vi.fn(),
  saveRouteEnrichmentUiConfig: vi.fn(),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
  fetchRouteProtectionRules: (...args: unknown[]) => fetchRouteProtectionRules(...args),
  patchRouteProtectionRule: (...args: unknown[]) => patchRouteProtectionRule(...args),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
}))

vi.mock('../../api/gdcRuntime', () => ({
  searchRuntimeDeliveryLogs: vi.fn(async () => ({ logs: [] })),
}))

vi.mock('./route-detail-health-panel', () => ({
  RouteDetailHealthPanel: () => null,
}))

function renderRouteEdit(routeId = '42') {
  return render(
    <MemoryRouter initialEntries={[`/routes/${routeId}/edit`]}>
      <Routes>
        <Route path="/routes/:routeId/edit" element={<RouteEditPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RouteEditPage protection persist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRouteById.mockResolvedValue({
      id: 42,
      name: 'Route A',
      description: 'desc',
      enabled: true,
      stream_id: 10,
      destination_id: 5,
      failure_policy: 'LOG_AND_CONTINUE',
      formatter_config_json: { delivery_mode: 'Reliable' },
      rate_limit_json: { enabled: true, per_second: 50, burst_size: 100 },
      updated_at: '2026-01-01T00:00:00Z',
    })
    fetchStreamById.mockResolvedValue({ id: 10, name: 'Stream A', connector_id: 1 })
    fetchConnectorById.mockResolvedValue({ id: 1, name: 'Connector A' })
    fetchDestinationsList.mockResolvedValue([{ id: 5, name: 'Dest A' }])
    fetchRouteTransformEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      mapping_source: 'stream',
      enrichment_source: 'stream',
      fallback_used: true,
      mapping_count: 1,
      enrichment_count: 1,
      processing_status: 'Overridden',
      message: 'ok',
    })
    fetchRouteProtectionEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 1,
      processing_status: 'Inherited',
      message: 'ok',
    })
    fetchRouteClassificationEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
      processing_status: 'Inherited',
      message: 'ok',
    })
    fetchRoutePolicyEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
      processing_status: 'Inherited',
    })
    fetchRouteProtectionRules.mockResolvedValue({
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
    })
    patchRouteProtectionRule.mockResolvedValue({ rule: { id: 7, enabled: false } })
  })

  it('shows transform and protection processing status', async () => {
    renderRouteEdit()
    expect(await screen.findByTestId('route-transform-processing-status')).toHaveTextContent('Transform: Overridden')
    expect(screen.getByTestId('route-protection-processing-status')).toHaveTextContent('Protection: Inherited')
  })

  it('persists protection rule toggle from protection tab', async () => {
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-tab-protection'))
    const disableBtn = await screen.findByRole('button', { name: 'Disable' })
    fireEvent.click(disableBtn)
    await waitFor(() => {
      expect(patchRouteProtectionRule).toHaveBeenCalledWith(42, 7, { enabled: false })
    })
  })
})
