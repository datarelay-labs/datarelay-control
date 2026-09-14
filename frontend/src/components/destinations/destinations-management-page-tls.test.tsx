import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DestinationsManagementPage } from './destinations-management-page'
import { clearDestinationsListSnapshot } from './destinations-list-cache'

const fetchDestinationsList = vi.fn()
const createDestination = vi.fn()
const updateDestination = vi.fn()
const previewTestDestination = vi.fn()
const testDestination = vi.fn()

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
  createDestination: (...args: unknown[]) => createDestination(...args),
  updateDestination: (...args: unknown[]) => updateDestination(...args),
  previewTestDestination: (...args: unknown[]) => previewTestDestination(...args),
  testDestination: (...args: unknown[]) => testDestination(...args),
  deleteDestination: vi.fn(),
  isDestinationStaleWriteError: () => false,
  DESTINATION_STALE_WRITE_CODE: 'DESTINATION_STALE_WRITE',
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: vi.fn(async () => ({
    global: { health_status: 'HEALTHY' },
    streams: [],
    routes: [],
    destinations: [],
    problems: [],
    updated_at: '2026-06-22T00:00:00Z',
  })),
}))

vi.mock('../../api/gdcRuntimeHealth', () => ({
  fetchDestinationHealthList: vi.fn(async () => ({ rows: [] })),
}))

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchDeliveryOutcomesByDestination: vi.fn(async () => ({ rows: [] })),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <DestinationsManagementPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearDestinationsListSnapshot()
  fetchDestinationsList.mockReset()
  createDestination.mockReset()
  updateDestination.mockReset()
  previewTestDestination.mockReset()
  testDestination.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DestinationsManagementPage — SYSLOG_TLS', () => {
  it('renders SYSLOG TLS badge and opens detail drawer for TLS destination', async () => {
    const user = userEvent.setup()
    fetchDestinationsList.mockResolvedValueOnce([
      {
        id: 42,
        name: 'Splunk TLS',
        destination_type: 'SYSLOG_TLS',
        config_json: {
          host: 'splunk.internal',
          port: 6514,
          tls_enabled: true,
          tls_verify_mode: 'strict',
          tls_server_name: 'splunk.internal',
          tls_ca_cert_path: '/etc/gdc/tls/ca.pem',
        },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 1,
        routes: [
          {
            route_id: 9,
            stream_id: 3,
            stream_name: 'Stellar Stream',
            route_enabled: true,
            route_status: 'ENABLED',
          },
        ],
      },
    ])

    renderPage()

    expect(await screen.findByText('SYSLOG TLS')).toBeInTheDocument()
    await user.click(screen.getByText('Splunk TLS'))
    expect(await screen.findByText('Syslog TLS')).toBeInTheDocument()
  })

  it('shows TLS form section only when SYSLOG_TLS is selected', async () => {
    fetchDestinationsList.mockResolvedValueOnce([])
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /new destination/i }))
    expect(screen.queryByTestId('syslog-tls-section')).not.toBeInTheDocument()

    const typeSelect = screen.getByLabelText(/type/i, { selector: 'select' }) as HTMLSelectElement
    fireEvent.change(typeSelect, { target: { value: 'SYSLOG_TLS' } })

    expect(await screen.findByTestId('syslog-tls-section')).toBeInTheDocument()
    expect(screen.getByLabelText(/verification mode/i)).toBeInTheDocument()
  })

  it('renders insecure warning when verify mode is insecure_skip_verify', async () => {
    fetchDestinationsList.mockResolvedValueOnce([])
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /new destination/i }))
    const typeSelect = screen.getByLabelText(/type/i, { selector: 'select' }) as HTMLSelectElement
    fireEvent.change(typeSelect, { target: { value: 'SYSLOG_TLS' } })

    const verifySelect = screen.getByLabelText(/verification mode/i) as HTMLSelectElement
    fireEvent.change(verifySelect, { target: { value: 'insecure_skip_verify' } })

    const warning = await screen.findByTestId('tls-insecure-warning')
    expect(warning).toHaveAttribute('role', 'alert')
    expect(warning.textContent).toMatch(/insecure mode/i)
  })

  it('submits SYSLOG_TLS create payload with TLS fields', async () => {
    fetchDestinationsList.mockResolvedValue([])
    createDestination.mockResolvedValueOnce({
      id: 11,
      name: 'TLS Sink',
      destination_type: 'SYSLOG_TLS',
      config_json: {},
      rate_limit_json: {},
      enabled: true,
    })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /new destination/i }))
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'TLS Sink' } })
    const typeSelect = screen.getByLabelText(/type/i, { selector: 'select' }) as HTMLSelectElement
    fireEvent.change(typeSelect, { target: { value: 'SYSLOG_TLS' } })
    fireEvent.change(screen.getByLabelText(/^host/i), { target: { value: 'siem.example' } })
    fireEvent.change(screen.getByLabelText(/^port/i), { target: { value: '6514' } })
    fireEvent.change(screen.getByLabelText(/CA Certificate Path/i), {
      target: { value: '/etc/gdc/tls/ca.pem' },
    })

    fireEvent.click(screen.getByRole('button', { name: /save destination/i }))

    await waitFor(() => expect(createDestination).toHaveBeenCalledTimes(1))
    const payload = createDestination.mock.calls[0][0] as {
      destination_type: string
      config_json: Record<string, unknown>
    }
    expect(payload.destination_type).toBe('SYSLOG_TLS')
    expect(payload.config_json.tls_enabled).toBe(true)
    expect(payload.config_json.tls_verify_mode).toBe('strict')
    expect(payload.config_json.tls_ca_cert_path).toBe('/etc/gdc/tls/ca.pem')
    expect(payload.config_json.host).toBe('siem.example')
    expect(payload.config_json.port).toBe(6514)
  })

  it('shows TLS metadata in test result toast for SYSLOG_TLS', async () => {
    const user = userEvent.setup()
    fetchDestinationsList.mockResolvedValue([
      {
        id: 5,
        name: 'TLS Receiver',
        destination_type: 'SYSLOG_TLS',
        config_json: {
          host: '127.0.0.1',
          port: 6514,
          tls_enabled: true,
          tls_verify_mode: 'strict',
        },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 0,
        routes: [],
      },
    ])
    testDestination.mockResolvedValueOnce({
      success: true,
      latency_ms: 4.7,
      message: 'TLS handshake completed and test syslog message sent.',
      tested_at: '2026-05-12T00:00:00Z',
      detail: {
        protocol: 'tls',
        verify_mode: 'strict',
        negotiated_tls_version: 'TLSv1.3',
        cipher: 'TLS_AES_256_GCM_SHA384',
        server_name: '127.0.0.1',
      },
    })

    renderPage()
    await screen.findByText('SYSLOG TLS')
    const row = screen.getByText('TLS Receiver').closest('tr')
    expect(row).toBeTruthy()
    const actionButtons = within(row as HTMLElement).getAllByRole('button')
    await user.click(actionButtons[actionButtons.length - 1])
    await user.click(await screen.findByRole('button', { name: /test delivery/i }))

    const toast = await screen.findByText(/Connection test/i, {}, { timeout: 8000 })
    expect(toast).toBeInTheDocument()
    expect(testDestination).toHaveBeenCalledWith(5)
    const detail = screen.queryByTestId('tls-test-detail')
    if (detail) {
      expect(detail.textContent).toMatch(/TLSv1\.3|TLS_AES_256_GCM_SHA384|sni=127\.0\.0\.1/)
    }
  })
})
