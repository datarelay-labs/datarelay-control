import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSession, persistSession } from '../../auth/session'
import { RouteEditPage } from './route-edit-page'

const fetchStreamsListResult = vi.hoisted(() => vi.fn())
const fetchStreamById = vi.hoisted(() => vi.fn())
const fetchDestinationsList = vi.hoisted(() => vi.fn())
const createRoute = vi.hoisted(() => vi.fn())

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsListResult: (...args: unknown[]) => fetchStreamsListResult(...args),
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
}))
vi.mock('../../api/gdcRoutes', () => ({
  createRoute: (...args: unknown[]) => createRoute(...args),
  fetchRouteById: vi.fn(async () => null),
  fetchRouteByIdFresh: vi.fn(async () => null),
  updateRoute: vi.fn(),
  isRouteStaleWriteError: () => false,
}))
vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))
vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => ({ id: 1, name: 'Fixture connector' })),
}))
vi.mock('../../api/gdcAudit', () => ({
  listAuditLogs: vi.fn(async () => ({ items: [], total: 0 })),
}))
vi.mock('./route-detail-health-panel', () => ({
  RouteDetailHealthPanel: () => null,
}))

const streams = [
  { id: 10, name: 'Stream A', connector_id: 1, source_id: 1 },
  { id: 11, name: 'Stream B', connector_id: 1, source_id: 1 },
]

function mount(path = '/routes/new/edit') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/routes/new/edit?stream_id=999">Switch to unavailable Stream</Link>
      <Routes>
        <Route path="/routes/:routeId/edit" element={<RouteEditPage />} />
        <Route path="/streams/:streamId/runtime" element={<div>Stream runtime opened</div>} />
        <Route path="/streams/new" element={<div>Create stream opened</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Route catalog creation requires an explicit Stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    persistSession({
      access_token: 'route-create-test',
      refresh_token: 'route-create-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      user: { username: 'operator', role: 'OPERATOR', status: 'ACTIVE' },
    })
    fetchStreamsListResult.mockResolvedValue({ ok: true, status: 200, data: streams })
    fetchStreamById.mockImplementation(async (id: number) => streams.find((s) => s.id === id) ?? null)
    fetchDestinationsList.mockResolvedValue([{ id: 5, name: 'Webhook destination' }])
    createRoute.mockResolvedValue({
      id: 99,
      stream_id: 11,
      destination_id: 5,
      name: 'New Route',
      enabled: true,
      failure_policy: 'retry',
      formatter_config_json: { delivery_mode: 'Reliable' },
      rate_limit_json: { enabled: false },
    })
  })

  afterEach(() => clearSession())

  it('prevents the old null-stream HTTP 422 POST and shows an actionable message', async () => {
    const user = userEvent.setup()
    mount()
    const select = await screen.findByTestId('route-edit-stream-select')
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Stream A' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Stream B' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Select an existing Stream before creating this Route.')
    expect(createRoute).not.toHaveBeenCalled()
  })

  it('creates a route bound to the operator-selected Stream and Destination', async () => {
    const user = userEvent.setup()
    mount()
    const select = await screen.findByTestId('route-edit-stream-select')
    await waitFor(() => expect(select).toBeEnabled())
    await user.selectOptions(select, '11')
    await waitFor(() => expect(screen.getByDisplayValue('Webhook destination')).toHaveValue('5'))
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    await waitFor(() => {
      expect(createRoute).toHaveBeenCalledWith(expect.objectContaining({
        stream_id: 11,
        destination_id: 5,
        name: 'New Route',
      }))
    })
    expect(await screen.findByText('Stream runtime opened')).toBeInTheDocument()
  })

  it('honors an explicit existing stream_id deep-link context, never guessing an ID', async () => {
    const user = userEvent.setup()
    mount('/routes/new/edit?stream_id=11')
    const select = await screen.findByTestId('route-edit-stream-select')
    await waitFor(() => expect(select).toHaveValue('11'))
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    await waitFor(() => expect(createRoute).toHaveBeenCalledWith(expect.objectContaining({ stream_id: 11 })))
  })

  it('keeps an invalid URL stream_id unselected and requires correction', async () => {
    const user = userEvent.setup()
    mount('/routes/new/edit?stream_id=999')
    const select = await screen.findByTestId('route-edit-stream-select')
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('')
    expect(screen.getByRole('alert')).toHaveTextContent('Stream #999 is not available')
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    expect(createRoute).not.toHaveBeenCalled()
    await user.selectOptions(select, '10')
    expect(screen.queryByText('Stream #999 is not available')).not.toBeInTheDocument()
  })

  it('clears a previous Stream when URL context changes without component remount', async () => {
    const user = userEvent.setup()
    mount('/routes/new/edit?stream_id=11')
    const select = await screen.findByTestId('route-edit-stream-select')
    await waitFor(() => expect(select).toHaveValue('11'))
    await user.click(screen.getByRole('link', { name: 'Switch to unavailable Stream' }))
    await waitFor(() => {
      expect(select).toHaveValue('')
      expect(screen.getByText('Stream #999 is not available. Choose an existing Stream.')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    expect(createRoute).not.toHaveBeenCalled()
  })

  it('shows create-first guidance for an empty Stream catalog instead of POST', async () => {
    const user = userEvent.setup()
    fetchStreamsListResult.mockResolvedValue({ ok: true, status: 200, data: [] })
    mount()
    await waitFor(() => expect(screen.getByText(/No Streams are available/)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Create a Stream first' })).toHaveAttribute('href', '/streams/new')
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    expect(createRoute).not.toHaveBeenCalled()
  })

  it('exposes Stream catalog failures distinctly from an empty catalog', async () => {
    const user = userEvent.setup()
    fetchStreamsListResult.mockResolvedValue({ ok: false, status: 503, message: 'Stream service unavailable', authRequired: false })
    mount()
    await waitFor(() => expect(screen.getByText(/Unable to load Streams: Stream service unavailable/)).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Create a Stream first' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create Route' }))
    expect(createRoute).not.toHaveBeenCalled()
  })
})
