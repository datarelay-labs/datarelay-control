import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteEditPage } from './route-edit-page'

const fetchRouteById = vi.fn()
const fetchStreamById = vi.fn()
const fetchConnectorById = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRouteClassificationRules = vi.fn()
const fetchRoutePolicyEffective = vi.fn()
const patchRouteClassificationRule = vi.fn()

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
  fetchRouteProtectionEffective: vi.fn(async () => ({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })),
  fetchRouteProtectionRules: vi.fn(async () => ({ route_id: 42, stream_id: 10, protection_enabled: true, rules: [], rule_count: 0 })),
  patchRouteProtectionRule: vi.fn(),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
  fetchRouteClassificationRules: (...args: unknown[]) => fetchRouteClassificationRules(...args),
  patchRouteClassificationRule: (...args: unknown[]) => patchRouteClassificationRule(...args),
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

describe('RouteEditPage classification persist', () => {
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
      processing_status: 'Inherited',
      message: 'ok',
    })
    fetchRouteClassificationEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 1,
      processing_status: 'Overridden',
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
    fetchRouteClassificationRules.mockResolvedValue({
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
    })
    patchRouteClassificationRule.mockResolvedValue({ rule: { id: 9, enabled: false } })
  })

  it('shows classification processing status', async () => {
    renderRouteEdit()
    expect(await screen.findByTestId('route-classification-processing-status')).toHaveTextContent(
      'Classification: Overridden',
    )
  })

  it('persists classification rule toggle from classification tab', async () => {
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-tab-classification'))
    const disableBtn = await screen.findByRole('button', { name: 'Disable' })
    fireEvent.click(disableBtn)
    await waitFor(() => {
      expect(patchRouteClassificationRule).toHaveBeenCalledWith(42, 9, { enabled: false })
    })
  })
})
