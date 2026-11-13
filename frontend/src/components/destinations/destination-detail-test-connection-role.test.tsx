import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestinationDetailPage } from './destination-detail-page'
import { useDestinationDetailData } from './use-destination-detail-data'

const caps = vi.hoisted(() => ({ validation_mutations: true }))

vi.mock('../../lib/rbac', () => ({
  useSessionCapabilities: () => ({ validation_mutations: caps.validation_mutations }),
}))

vi.mock('./use-destination-detail-data', () => ({ useDestinationDetailData: vi.fn() }))

const runConnectivityTest = vi.fn()

function bundle() {
  return {
    destination: { id: 5, name: 'Splunk', destination_type: 'WEBHOOK_POST', enabled: true, config_json: {} },
    listRow: null,
    uiHealth: 'Healthy',
    healthState: 'HEALTHY',
    snapshotUpdatedAt: null,
    connectedStreams: [],
    connectedRoutes: [],
    successRatePct: null,
    currentEps: null,
    failed24h: null,
    avgLatencyMs: null,
    lastDeliveryAt: null,
    lastErrorMessage: null,
    recentActivity: [],
    recentFailures: [],
    recentLogsState: 'verified',
    healthRow: null,
    failuresAnalytics: null,
    loading: false,
    runtimeLoading: false,
    error: null,
    refresh: vi.fn(),
    runConnectivityTest,
    testBusy: false,
  }
}

function mount() {
  vi.mocked(useDestinationDetailData).mockReturnValue(bundle() as never)
  return render(
    <MemoryRouter initialEntries={['/destinations/5']}>
      <Routes>
        <Route path="/destinations/:destinationId" element={<DestinationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Destination detail Test Connection by role (F-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    caps.validation_mutations = true
  })

  it('is disabled for a role without validation_mutations, with an explanation, and never calls the API', async () => {
    caps.validation_mutations = false
    mount()
    const button = screen.getByRole('button', { name: 'Test Connection' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringMatching(/Operator or Administrator/))
    expect(screen.getByText('Requires Operator or Administrator')).toBeInTheDocument()
    await userEvent.setup().click(button)
    expect(runConnectivityTest).not.toHaveBeenCalled()
  })

  it('stays enabled for Operators and shows a failed result as a visible alert', async () => {
    runConnectivityTest.mockResolvedValue({ success: false, message: 'You do not have permission to do this.' })
    mount()
    const button = screen.getByRole('button', { name: 'Test Connection' })
    expect(button).toBeEnabled()
    expect(screen.queryByText('Requires Operator or Administrator')).toBeNull()
    await userEvent.setup().click(button)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed: You do not have permission'))
  })

  it('shows a final not-found state without a futile Retry for a missing Destination (F-019)', () => {
    vi.mocked(useDestinationDetailData).mockReturnValue({
      ...bundle(), destination: null, error: 'Destination not found.',
    } as never)
    render(
      <MemoryRouter initialEntries={['/destinations/99999']}>
        <Routes>
          <Route path="/destinations/:destinationId" element={<DestinationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('destination-not-found')).toHaveTextContent('Destination not found')
    expect(screen.getByRole('link', { name: 'Back to Destinations' })).toHaveAttribute('href', '/destinations')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
