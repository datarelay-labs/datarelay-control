import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteEditPage } from './route-edit-page'

const fetchRouteById = vi.fn()
const fetchRouteByIdFresh = vi.fn()
const updateRoute = vi.fn()
const fetchStreamById = vi.fn()
const fetchConnectorById = vi.fn()
const fetchDestinationsList = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
  fetchRouteByIdFresh: (...args: unknown[]) => fetchRouteByIdFresh(...args),
  updateRoute: (...args: unknown[]) => updateRoute(...args),
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
  fetchRouteMappingUiConfig: vi.fn().mockResolvedValue({
    route_id: 42,
    inherit_stream_mapping: true,
    mapping: { field_mappings: {} },
  }),
  fetchRouteEnrichmentUiConfig: vi.fn().mockResolvedValue({
    route_id: 42,
    inherit_stream_enrichment: true,
    enrichment: { enrichment: {} },
  }),
  fetchRouteTransformEffective: vi.fn().mockResolvedValue({
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
  }),
  saveRouteMappingUiConfig: vi.fn(),
  saveRouteEnrichmentUiConfig: vi.fn(),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: vi.fn().mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  }),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: vi.fn().mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  }),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: vi.fn().mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
  }),
}))

vi.mock('./route-detail-health-panel', () => ({
  RouteDetailHealthPanel: () => null,
}))

function renderRouteEdit() {
  return render(
    <MemoryRouter initialEntries={['/routes/42/edit']}>
      <Routes>
        <Route path="/routes/:routeId/edit" element={<RouteEditPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RouteEditPage stale-write conflict', () => {
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
    fetchRouteByIdFresh.mockImplementation((...args: unknown[]) => fetchRouteById(...args))
    fetchStreamById.mockResolvedValue({ id: 10, name: 'Stream A', connector_id: 1 })
    fetchConnectorById.mockResolvedValue({ id: 1, name: 'Connector A' })
    fetchDestinationsList.mockResolvedValue([{ id: 5, name: 'Dest A' }])
  })

  it('sends expected_updated_at and preserves dirty edits on ROUTE_STALE_WRITE 409', async () => {
    updateRoute.mockRejectedValue(new Error('409: [ROUTE_STALE_WRITE] Route changed since you started editing.'))
    renderRouteEdit()
    const perSecond = await screen.findByDisplayValue('50')
    fireEvent.change(perSecond, { target: { value: '77' } })
    expect(screen.getByTestId('route-edit-unsaved-hint')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('route-edit-save'))
    expect(await screen.findByTestId('route-edit-stale-conflict')).toBeInTheDocument()
    expect(updateRoute).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        expected_updated_at: '2026-01-01T00:00:00Z',
      }),
    )
    expect(screen.getByDisplayValue('77')).toBeInTheDocument()
    expect(screen.getByTestId('route-edit-save-status')).toHaveTextContent('Conflict')
    expect(screen.getByTestId('route-edit-unsaved-hint')).toBeInTheDocument()
  })

  it('refresh latest requires discard confirmation while dirty, then reloads server baseline', async () => {
    updateRoute.mockRejectedValue(new Error('409: [ROUTE_STALE_WRITE] stale'))
    fetchRouteById
      .mockResolvedValueOnce({
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
      .mockResolvedValue({
        id: 42,
        name: 'Route B server',
        description: 'server desc',
        enabled: true,
        stream_id: 10,
        destination_id: 5,
        failure_policy: 'LOG_AND_CONTINUE',
        formatter_config_json: { delivery_mode: 'Reliable' },
        rate_limit_json: { enabled: true, per_second: 12, burst_size: 100 },
        updated_at: '2026-01-02T00:00:00Z',
      })
    renderRouteEdit()
    const perSecond = await screen.findByDisplayValue('50')
    fireEvent.change(perSecond, { target: { value: '77' } })
    fireEvent.click(screen.getByTestId('route-edit-save'))
    expect(await screen.findByTestId('route-edit-stale-conflict')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('route-edit-stale-refresh'))
    expect(await screen.findByTestId('route-edit-refresh-discard-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('route-edit-refresh-discard-dialog-confirm'))
    await waitFor(() => {
      expect(screen.getByDisplayValue('12')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('route-edit-stale-conflict')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-edit-unsaved-hint')).not.toBeInTheDocument()
  })
})
