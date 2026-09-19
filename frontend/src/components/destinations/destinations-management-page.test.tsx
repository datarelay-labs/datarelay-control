import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DestinationsManagementPage } from './destinations-management-page'

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
          hasDeliveryActivity: true,
          health: 'Healthy',
          recentIssues: [],
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

describe('DestinationsManagementPage', () => {
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
