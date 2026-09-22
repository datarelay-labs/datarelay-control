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
const runRouteDeliveryPreview = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
  fetchRouteByIdFresh: (...args: unknown[]) => fetchRouteByIdFresh(...args),
  updateRoute: (...args: unknown[]) => updateRoute(...args),
  createRoute: vi.fn(),
  isRouteStaleWriteError: () => false,
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

vi.mock('../../api/gdcRuntimePreview', async () => {
  const actual = await vi.importActual<typeof import('../../api/gdcRuntimePreview')>(
    '../../api/gdcRuntimePreview',
  )
  return {
    ...actual,
    runRouteDeliveryPreview: (...args: unknown[]) => runRouteDeliveryPreview(...args),
  }
})

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

describe('RouteEditPage delivery preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRouteById.mockResolvedValue(savedRoute)
    fetchRouteByIdFresh.mockResolvedValue(savedRoute)
    fetchStreamById.mockResolvedValue({ id: 10, name: 'Stream A', connector_id: 1 })
    fetchConnectorById.mockResolvedValue({ id: 1, name: 'Connector A' })
    fetchDestinationsList.mockResolvedValue([{ id: 5, name: 'Dest A' }])
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

  it('runs route-delivery preview and reports no-send success', async () => {
    renderRouteEdit()
    const button = await screen.findByTestId('route-edit-preview-delivery')
    expect(button).toHaveTextContent('Preview Delivery')
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    await waitFor(() => {
      expect(runRouteDeliveryPreview).toHaveBeenCalledWith({
        route_id: 42,
        events: [
          {
            event_id: 'route-edit-preview',
            message: 'Route delivery preview sample (not sent)',
          },
        ],
      })
    })

    const status = await screen.findByTestId('route-edit-delivery-preview-status')
    expect(status).toHaveTextContent(/Delivery preview ready — no events were sent/)
    expect(status).toHaveTextContent(/WEBHOOK_POST/)
    expect(status).not.toHaveTextContent(/delivery succeeded/i)
  })

  it('shows actionable failure text when preview API fails', async () => {
    runRouteDeliveryPreview.mockRejectedValueOnce(new Error('400: [ROUTE_DISABLED] route is disabled'))
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-preview-delivery'))

    const status = await screen.findByTestId('route-edit-delivery-preview-status')
    await waitFor(() => {
      expect(status).toHaveTextContent(/Delivery preview failed/)
      expect(status).toHaveTextContent(/ROUTE_DISABLED/)
    })
    expect(runRouteDeliveryPreview).toHaveBeenCalledTimes(1)
  })

  it('blocks preview while unsaved edits exist and does not call the API', async () => {
    renderRouteEdit()
    await screen.findByTestId('route-edit-preview-delivery')

    // Wait for async route hydrate before editing — preview button mounts before the name field.
    const nameInput = await screen.findByDisplayValue('Route A')
    fireEvent.change(nameInput, { target: { value: 'Route A edited' } })
    expect(await screen.findByTestId('route-edit-unsaved-hint')).toBeInTheDocument()

    const button = screen.getByTestId('route-edit-preview-delivery')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      expect.stringContaining('Save or discard unsaved edits before preview'),
    )
    expect(runRouteDeliveryPreview).not.toHaveBeenCalled()
  })

  it('disables preview in create mode until a route exists', async () => {
    renderRouteEdit('/routes/new')
    const button = await screen.findByTestId('route-edit-preview-delivery')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      expect.stringContaining('Create and save the route before running a delivery preview'),
    )
    expect(runRouteDeliveryPreview).not.toHaveBeenCalled()
  })
})
