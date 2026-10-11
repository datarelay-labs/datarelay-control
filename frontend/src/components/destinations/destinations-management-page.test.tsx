import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DestinationsManagementPage } from './destinations-management-page'
import { createDestination } from '../../api/gdcDestinations'

vi.mock('./use-destinations-overview-data', () => ({
  useDestinationsOverviewData: vi.fn(() => ({
    rows: [
      {
        id: 9,
        name: 'MDS',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 1,
        routes: [{ route_id: 1, stream_id: 1, stream_name: 'Stream A', route_enabled: true, route_status: 'ENABLED' }],
        created_at: null,
        updated_at: null,
        runtime: {
          connectedStreams: 1,
          connectedRoutes: 1,
          successRatePct: 99,
          currentEps: 1.2,
          capacityUsagePct: 12,
          capacityWarning: false,
          hasDeliveryActivity: true,
          health: 'Healthy',
          recentIssues: [],
          metricsWindowLabel: '1h',
        },
      },
      {
        id: 10,
        name: 'Capacity Hot',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.2', port: 514 },
        rate_limit_json: { capacity_limit_eps: 10, capacity_warning_threshold_pct: 70 },
        enabled: true,
        streams_using_count: 1,
        routes: [{ route_id: 2, stream_id: 2, stream_name: 'Stream B', route_enabled: true, route_status: 'ENABLED' }],
        created_at: null,
        updated_at: null,
        runtime: {
          connectedStreams: 1,
          connectedRoutes: 1,
          successRatePct: 100,
          currentEps: 8,
          capacityUsagePct: 80,
          capacityWarning: true,
          hasDeliveryActivity: true,
          health: 'Healthy',
          recentIssues: [],
          metricsWindowLabel: '1h',
        },
      },
      {
        id: 11,
        name: 'Delivery Warning',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.3', port: 514 },
        rate_limit_json: { capacity_limit_eps: 100, capacity_warning_threshold_pct: 70 },
        enabled: true,
        streams_using_count: 1,
        routes: [{ route_id: 3, stream_id: 3, stream_name: 'Stream C', route_enabled: true, route_status: 'ENABLED' }],
        created_at: null,
        updated_at: null,
        runtime: {
          connectedStreams: 1,
          connectedRoutes: 1,
          successRatePct: 90,
          currentEps: 10,
          capacityUsagePct: 10,
          capacityWarning: false,
          hasDeliveryActivity: true,
          health: 'Warning',
          recentIssues: ['Delivery degraded'],
          metricsWindowLabel: '1h',
        },
      },
    ],
    loading: false,
    runtimeLoading: false,
    error: null,
    runtimeError: null,
    refresh: vi.fn(),
  })),
}))

vi.mock('../../api/gdcDestinations', () => ({
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  deleteDestination: vi.fn(),
  previewTestDestination: vi.fn(),
  testDestination: vi.fn(async () => ({
    success: true,
    latency_ms: 3,
    message: 'ok',
    tested_at: '2026-05-09T12:00:00Z',
    detail: null,
  })),
  isDestinationStaleWriteError: () => false,
  DESTINATION_STALE_WRITE_CODE: 'DESTINATION_STALE_WRITE',
}))

function LocationStateProbe() {
  const location = useLocation()
  return <output data-testid="returned-wizard-location">{JSON.stringify(location.state)}</output>
}

describe('DestinationsManagementPage', () => {
  it('opens contextual Create and returns to saved Wizard only after the Destination API succeeds', async () => {
    const user = userEvent.setup()
    vi.mocked(createDestination).mockReset().mockResolvedValue({
      id: 91,
    } as Awaited<ReturnType<typeof createDestination>>)
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/destinations',
        state: { returnToSavedWizardDraft: true },
      }]}>
        <Routes>
          <Route path="/destinations" element={<DestinationsManagementPage />} />
          <Route path="/streams/new" element={<LocationStateProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    const dialog = await screen.findByRole('dialog')
    expect(screen.getByText(/Creating a destination for a saved Stream draft/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Name/i), 'New intake')
    await user.type(within(dialog).getByLabelText(/^Host/i), '127.0.0.1')
    await user.click(within(dialog).getByRole('button', { name: /Save Destination/i }))
    await waitFor(() => expect(createDestination).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('returned-wizard-location')).toHaveTextContent(
      JSON.stringify({ resumeSavedWizardDraft: true, createdDestinationId: 91 }),
    )
  })

  it('never returns to Wizard or hides an API failure while contextual Destination Save fails', async () => {
    const user = userEvent.setup()
    vi.mocked(createDestination).mockReset().mockRejectedValueOnce(new Error('Save rejected'))
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/destinations',
        state: { returnToSavedWizardDraft: true },
      }]}>
        <Routes>
          <Route path="/destinations" element={<DestinationsManagementPage />} />
          <Route path="/streams/new" element={<LocationStateProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Name/i), 'Rejected intake')
    await user.type(within(dialog).getByLabelText(/^Host/i), '127.0.0.1')
    await user.click(within(dialog).getByRole('button', { name: /Save Destination/i }))
    expect(await screen.findByTestId('destination-form-error')).toHaveTextContent('Save rejected')
    expect(screen.queryByTestId('returned-wizard-location')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('renders Test delivery action for each destination', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    const row = await screen.findByText('MDS')
    const tr = row.closest('tr')
    expect(tr).toBeTruthy()
    const actionButtons = within(tr as HTMLElement).getAllByRole('button')
    await user.click(actionButtons[actionButtons.length - 1])
    expect(await screen.findByRole('button', { name: /test delivery/i })).toBeInTheDocument()
  })

  it('shows runtime KPI columns', async () => {
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Success Rate')).toBeInTheDocument()
    expect(screen.getByText('EPS (Current)')).toBeInTheDocument()
    expect(screen.getAllByText(/Healthy/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('99%').length).toBeGreaterThanOrEqual(1)
  })

  it('applies and clears the capacity-warning operational deep link', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/destinations?filter=warning']}>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('destinations-operational-filter-chip')).toHaveTextContent('Capacity Warning')
    expect(screen.getByText('Capacity Hot')).toBeInTheDocument()
    expect(screen.queryByText('MDS')).not.toBeInTheDocument()
    expect(screen.queryByText('Delivery Warning')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('destinations-clear-operational-filter'))
    expect(await screen.findByText('MDS')).toBeInTheDocument()
    expect(screen.getByText('Capacity Hot')).toBeInTheDocument()
    expect(screen.getByText('Delivery Warning')).toBeInTheDocument()
  })

  it('shows an actionable error when webhook URL is not http(s)', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await user.click(screen.getByTestId('destinations-new'))
    const dialog = await screen.findByRole('dialog')
    const typeSelect = dialog.querySelector('form#dest-form select') as HTMLSelectElement
    expect(typeSelect).toBeTruthy()
    await user.selectOptions(typeSelect, 'WEBHOOK_POST')
    await user.type(within(dialog).getByLabelText(/^Name/i), 'bad-url-dest')
    const url = await within(dialog).findByLabelText(/^URL/i)
    await user.clear(url)
    await user.type(url, 'not-a-url')
    await user.click(within(dialog).getByRole('button', { name: /Save Destination/i }))
    const alert = await screen.findByTestId('destination-form-error')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent(/http:\/\/ or https:\/\//i)
    expect(alert).toHaveTextContent(/Fix the highlighted fields/i)
  })
})
