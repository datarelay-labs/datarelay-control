import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MappingUIConfigResponse } from '../../api/types/gdcApi'
import { StreamEditDeliveryPanel } from './stream-edit-delivery-panel'

const fetchStreamMappingUiConfig = vi.fn()
const fetchDestinationsList = vi.fn()
const deleteRoute = vi.fn()

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: (...args: unknown[]) => fetchStreamMappingUiConfig(...args),
  saveRuntimeRouteEnabledState: vi.fn(),
  saveRuntimeRouteFailurePolicy: vi.fn(),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

vi.mock('../../api/gdcRoutes', () => ({
  createRoute: vi.fn(),
  deleteRoute: (...args: unknown[]) => deleteRoute(...args),
  updateRoute: vi.fn(),
  updateRouteWithFreshToken: vi.fn(),
}))

vi.mock('./message-prefix-delivery-preview', () => ({
  MessagePrefixDeliveryPreview: () => null,
}))

function mappingConfig(routes: MappingUIConfigResponse['routes']): MappingUIConfigResponse {
  return {
    stream_id: 10,
    stream_name: 'Test Stream',
    stream_enabled: true,
    stream_status: 'ENABLED',
    source_id: 1,
    source_type: 'HTTP_POLL',
    source_config: {},
    mapping: { exists: false, event_array_path: null, event_root_path: null, field_mappings: {}, raw_payload_mode: null },
    enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
    routes,
    message: 'ok',
  }
}

const destinations = [
  {
    id: 150,
    name: 'AS4 SYNC',
    destination_type: 'SYSLOG_TCP',
    config_json: { host: '10.70.10.20', port: 514 },
  },
  {
    id: 151,
    name: 'JSON VALIDATION Webhook',
    destination_type: 'WEBHOOK_POST',
    config_json: { url: 'https://example.test/hook' },
  },
]

describe('StreamEditDeliveryPanel route removal', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    fetchDestinationsList.mockResolvedValue(destinations)
    deleteRoute.mockResolvedValue(undefined)
  })

  it('renders a prominent save action for each route prefix template', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingConfig([
        {
          route_id: 22,
          destination_id: 150,
          destination_name: 'AS4 SYNC',
          destination_type: 'SYSLOG_TCP',
          route_enabled: true,
          destination_enabled: true,
          formatter_config: {},
          route_rate_limit: {},
          failure_policy: 'RETRY_AND_BACKOFF',
        },
      ]),
    )

    render(<StreamEditDeliveryPanel streamId={10} />)

    await waitFor(() => {
      expect(screen.getByTestId('save-prefix-22')).toBeInTheDocument()
    })

    expect(screen.getByTestId('save-prefix-22')).toHaveTextContent('Save prefix template')
    expect(screen.getByTestId('save-prefix-action-22')).toHaveTextContent(
      'Prefix changes are not applied until you save this route.',
    )
  })

  it('removes the route row immediately after delete without waiting for a full page reload', async () => {
    const routeRow = {
      route_id: 22,
      destination_id: 150,
      destination_name: 'AS4 SYNC',
      destination_type: 'SYSLOG_TCP',
      route_enabled: false,
      destination_enabled: true,
      formatter_config: {},
      route_rate_limit: {},
      failure_policy: 'RETRY_AND_BACKOFF',
    }
    fetchStreamMappingUiConfig
      .mockResolvedValueOnce(mappingConfig([routeRow]))
      .mockResolvedValueOnce(mappingConfig([]))

    render(<StreamEditDeliveryPanel streamId={10} />)

    await waitFor(() => {
      expect(screen.getByText('Routes (1)')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove route' }))
    const impact = await screen.findByTestId('route-remove-dialog-impact')
    expect(impact).toHaveTextContent(
      'Removes this delivery path from the stream. The destination and parent stream are kept.',
    )
    expect(impact).toHaveTextContent(
      'Permanently removes transform, protection, classification, and policy configuration for this path.',
    )
    expect(impact).toHaveTextContent(
      'Historical delivery logs are kept, but they are no longer associated with this path.',
    )
    expect(screen.getByTestId('route-remove-dialog-reversibility')).toHaveTextContent(
      'does not restore the deleted route configuration',
    )
    fireEvent.click(screen.getByTestId('route-remove-dialog-confirm'))

    await waitFor(() => {
      expect(deleteRoute).toHaveBeenCalledWith(22, { streamId: 10 })
    })
    await waitFor(() => {
      expect(screen.getByText('Routes (0)')).toBeInTheDocument()
    })
    expect(screen.getByText('Route removed from this stream.')).toBeInTheDocument()
    expect(fetchStreamMappingUiConfig).toHaveBeenLastCalledWith(10, { fresh: true })
  })

  it('keeps route removal disabled until the route is turned off', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingConfig([
        {
          route_id: 22,
          destination_id: 150,
          destination_name: 'AS4 SYNC',
          destination_type: 'SYSLOG_TCP',
          route_enabled: true,
          destination_enabled: true,
          formatter_config: {},
          route_rate_limit: {},
          failure_policy: 'RETRY_AND_BACKOFF',
        },
      ]),
    )

    render(<StreamEditDeliveryPanel streamId={10} />)

    const remove = await screen.findByRole('button', { name: 'Remove route (disabled until route is off)' })
    expect(remove).toBeDisabled()
    deleteRoute.mockClear()
    fireEvent.click(remove)
    expect(screen.queryByTestId('route-remove-dialog')).not.toBeInTheDocument()
    expect(deleteRoute).not.toHaveBeenCalled()
  })

  it('drops a stale route row when delete returns route-not-found', async () => {
    const routeRow = {
      route_id: 22,
      destination_id: 150,
      destination_name: 'AS4 SYNC',
      destination_type: 'SYSLOG_TCP',
      route_enabled: false,
      destination_enabled: true,
      formatter_config: {},
      route_rate_limit: {},
      failure_policy: 'RETRY_AND_BACKOFF',
    }
    fetchStreamMappingUiConfig
      .mockResolvedValueOnce(mappingConfig([routeRow]))
      .mockResolvedValueOnce(mappingConfig([]))
    deleteRoute.mockRejectedValue(new Error('404 AS400_CREDIT_NOT_FOUND, route not found: 22'))

    render(<StreamEditDeliveryPanel streamId={10} />)

    await waitFor(() => {
      expect(screen.getByText('Routes (1)')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove route' }))
    fireEvent.click(await screen.findByTestId('route-remove-dialog-confirm'))

    await waitFor(() => {
      expect(screen.getByText('Routes (0)')).toBeInTheDocument()
    })
    expect(screen.queryByText(/Remove route:/)).not.toBeInTheDocument()
  })

  it('marks prefix save available only when the draft differs from persisted baseline', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(
      mappingConfig([
        {
          route_id: 22,
          destination_id: 150,
          destination_name: 'AS4 SYNC',
          destination_type: 'SYSLOG_TCP',
          route_enabled: true,
          destination_enabled: true,
          formatter_config: {
            message_prefix_enabled: false,
            message_prefix_template: '<134> gdc generic-connector event:',
          },
          route_rate_limit: {},
          failure_policy: 'RETRY_AND_BACKOFF',
        },
      ]),
    )

    render(<StreamEditDeliveryPanel streamId={10} />)
    await waitFor(() => expect(screen.getByTestId('save-prefix-22')).toBeDisabled())
    // SYSLOG default is prefix On; fixture persists enabled=false — wait for hydrate before editing.
    await waitFor(() => {
      const prefixToggle = screen.getByText('On').closest('label')?.querySelector('input[type="checkbox"]')
      expect(prefixToggle).not.toBeChecked()
    })

    const textarea = screen.getByDisplayValue('<134> gdc generic-connector event:')
    fireEvent.change(textarea, { target: { value: 'CUSTOM-PREFIX' } })
    await waitFor(() => expect(screen.getByTestId('save-prefix-22')).not.toBeDisabled())
    expect(screen.getByTestId('save-prefix-action-22')).toHaveTextContent(/Unsaved prefix edits/)

    fireEvent.change(screen.getByDisplayValue('CUSTOM-PREFIX'), {
      target: { value: '<134> gdc generic-connector event:' },
    })
    await waitFor(() => expect(screen.getByTestId('save-prefix-22')).toBeDisabled())
  })

  it('surfaces destination list API failure without clearing the catalog as empty', async () => {
    fetchStreamMappingUiConfig.mockResolvedValue(mappingConfig([]))
    fetchDestinationsList.mockResolvedValue(null)

    render(<StreamEditDeliveryPanel streamId={10} />)

    await waitFor(() => {
      expect(screen.getByText(/Failed to load destinations/i)).toBeInTheDocument()
    })
    expect(screen.queryByText(/Could not load stream delivery configuration/i)).not.toBeInTheDocument()
    // Mapping still loads; destination picker must not pretend the catalog is empty-success.
    expect(screen.getByText(/Routes \(0\)/)).toBeInTheDocument()
  })

})
