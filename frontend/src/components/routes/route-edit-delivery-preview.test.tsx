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

  it('shows metadata-only formatted output without disclosing payloads, headers or secrets', async () => {
    runRouteDeliveryPreview.mockResolvedValueOnce({
      route_id: 42,
      destination_id: 5,
      destination_type: 'WEBHOOK_POST',
      message_count: 2,
      preview_messages: [
        { body: 'synthetic_secret_123', headers: { Authorization: 'Bearer hidden_token_123' } },
        { body: { password: 'do_not_disclose_123', api_key: 'key_secret_123' } },
      ],
    })
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-preview-delivery'))
    const panel = await screen.findByTestId('route-edit-delivery-preview-output')
    expect(panel).toHaveTextContent('Formatted output metadata — no send')
    expect(panel).toHaveTextContent('Message 1')
    expect(panel).toHaveTextContent('Message 2')
    expect(panel).toHaveTextContent('Text body')
    expect(panel).toHaveTextContent('Structured body')
    expect(panel).not.toHaveTextContent(/synthetic_secret_123|Bearer hidden_token_123|do_not_disclose_123|key_secret_123/)
    expect(screen.getByTestId('route-edit-delivery-preview-status')).toHaveTextContent('no events were sent')
  })

  it('bounds large preview message lists to three summaries without implying delivery success', async () => {
    runRouteDeliveryPreview.mockResolvedValueOnce({
      route_id: 42,
      destination_id: 5,
      destination_type: 'WEBHOOK_POST',
      message_count: 8,
      preview_messages: Array.from({ length: 8 }, (_, index) => ({ body: 'private-' + index })),
    })
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-preview-delivery'))
    const panel = await screen.findByTestId('route-edit-delivery-preview-output')
    expect(panel).toHaveTextContent('Showing 3 of 8 formatted messages')
    expect(panel).toHaveTextContent('Message 3')
    expect(panel).not.toHaveTextContent('Message 4')
    expect(panel).not.toHaveTextContent('private-0')
    expect(panel).toHaveTextContent('not receiver-confirmed')
  })

  it('clears any previous success output if a later no-send preview fails', async () => {
    renderRouteEdit()
    const button = await screen.findByTestId('route-edit-preview-delivery')
    fireEvent.click(button)
    expect(await screen.findByTestId('route-edit-delivery-preview-output')).toBeInTheDocument()
    runRouteDeliveryPreview.mockRejectedValueOnce(new Error('preview unavailable'))
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByTestId('route-edit-delivery-preview-status')).toHaveTextContent('preview unavailable')
      expect(screen.queryByTestId('route-edit-delivery-preview-output')).not.toBeInTheDocument()
    })
  })

  it('rejects mismatched route preview evidence without displaying output', async () => {
    runRouteDeliveryPreview.mockResolvedValueOnce({
      route_id: 99,
      destination_id: 5,
      destination_type: 'WEBHOOK_POST',
      message_count: 1,
      preview_messages: [{ body: { token: 'hidden' } }],
    })
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-preview-delivery'))
    // The status element exists during the pending network operation.
    // Wait for the terminal fail-closed identity rejection, not its first render.
    await waitFor(() => {
      expect(screen.getByTestId('route-edit-delivery-preview-status')).toHaveTextContent(
        'did not match the saved Route and Destination',
      )
      expect(screen.queryByTestId('route-edit-delivery-preview-output')).not.toBeInTheDocument()
    })
  })

  it('hides prior no-send output whenever the persisted Route has unsaved edits', async () => {
    renderRouteEdit()
    fireEvent.click(await screen.findByTestId('route-edit-preview-delivery'))
    expect(await screen.findByTestId('route-edit-delivery-preview-output')).toBeInTheDocument()
    fireEvent.change(await screen.findByDisplayValue('Route A'), { target: { value: 'Edited route' } })
    expect(await screen.findByTestId('route-edit-unsaved-hint')).toBeInTheDocument()
    expect(screen.queryByTestId('route-edit-delivery-preview-output')).not.toBeInTheDocument()
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
