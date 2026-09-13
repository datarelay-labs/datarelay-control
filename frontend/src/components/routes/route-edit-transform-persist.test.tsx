import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteEditPage } from './route-edit-page'

const fetchRouteById = vi.fn()
const updateRoute = vi.fn()
const fetchStreamById = vi.fn()
const fetchConnectorById = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchRouteMappingUiConfig = vi.fn()
const fetchRouteEnrichmentUiConfig = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRoutePolicyEffective = vi.fn()
const saveRouteMappingUiConfig = vi.fn()
const saveRouteEnrichmentUiConfig = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
  fetchRouteByIdFresh: (...args: unknown[]) => fetchRouteById(...args),
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
  fetchRouteMappingUiConfig: (...args: unknown[]) => fetchRouteMappingUiConfig(...args),
  fetchRouteEnrichmentUiConfig: (...args: unknown[]) => fetchRouteEnrichmentUiConfig(...args),
  fetchRouteTransformEffective: (...args: unknown[]) => fetchRouteTransformEffective(...args),
  saveRouteMappingUiConfig: (...args: unknown[]) => saveRouteMappingUiConfig(...args),
  saveRouteEnrichmentUiConfig: (...args: unknown[]) => saveRouteEnrichmentUiConfig(...args),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  loadMappingWorkspaceContext: vi.fn(async () => ({
    stream: { id: 10, name: 'Stream A', stream_type: 'HTTP_API_POLLING' },
    cfg: {
      stream_name: 'Stream A',
      stream_status: 'RUNNING',
      source_type: 'HTTP_API_POLLING',
      mapping: { event_array_path: '$.items', event_root_path: '$.event', field_mappings: { a: '$.a' } },
      enrichment: { exists: true, enrichment: { vendor: 'stream' } },
    },
    connectorName: 'Connector A',
    sample: { eventArrayPath: '$.items', eventRootPath: '$.event', extractedEvents: [{ a: 1 }] },
  })),
}))

vi.mock('../mappings/mapping-workspace', () => ({
  MappingWorkspace: () => <div data-testid="mapping-workspace-stub">Mapping workspace</div>,
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

describe('RouteEditPage transform persist', () => {
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
    fetchRouteProtectionEffective.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
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
    fetchRouteMappingUiConfig.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      inherit_stream_mapping: false,
      mapping: {
        exists: true,
        event_array_path: '$.items',
        event_root_path: '$.event',
        field_mappings: { a: '$.a' },
        raw_payload_mode: null,
      },
      stream_mapping: {
        exists: true,
        event_array_path: '$.items',
        event_root_path: '$.event',
        field_mappings: { a: '$.a' },
        raw_payload_mode: null,
      },
      message: 'ok',
    })
    fetchRouteEnrichmentUiConfig.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      inherit_stream_enrichment: false,
      enrichment: { exists: true, enabled: true, enrichment: { vendor: 'stream' }, override_policy: 'KEEP_EXISTING' },
      stream_enrichment: { exists: true, enabled: true, enrichment: { vendor: 'stream' }, override_policy: 'KEEP_EXISTING' },
      message: 'ok',
    })
    saveRouteMappingUiConfig.mockResolvedValue({ route_id: 42, stream_id: 10, mapping_saved: true, inherit_stream_mapping: true, message: 'ok' })
    saveRouteEnrichmentUiConfig.mockResolvedValue({ route_id: 42, stream_id: 10, enrichment_saved: true, inherit_stream_enrichment: true, message: 'ok' })
  })

  it('loads delivery fields and shows processing status', async () => {
    renderRouteEdit()
    expect(await screen.findByTestId('route-transform-processing-status')).toHaveTextContent('Transform: Inherited')
    expect(screen.getByTestId('route-protection-processing-status')).toHaveTextContent('Protection: Inherited')
    expect(screen.getByTestId('route-classification-processing-status')).toHaveTextContent('Classification: Inherited')
    expect(screen.getByDisplayValue('50')).toBeInTheDocument()
  })

  it('persists inherit transform from transform tab', async () => {
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-tab-transform'))
    expect(await screen.findByTestId('route-transform-override')).toBeChecked()
    fireEvent.click(screen.getByTestId('route-transform-inherit'))
    expect(screen.getByTestId('route-transform-inherit')).toBeChecked()
    await waitFor(() => expect(screen.getByTestId('route-transform-save')).not.toBeDisabled())
    fireEvent.click(screen.getByTestId('route-transform-save'))
    await waitFor(() => {
      expect(saveRouteMappingUiConfig).toHaveBeenCalledWith(42, { inherit: true })
      expect(saveRouteEnrichmentUiConfig).toHaveBeenCalledWith(42, { inherit: true })
    })
  })
})
