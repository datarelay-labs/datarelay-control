import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DestinationsManagementPage } from './destinations-management-page'
import { clearDestinationsListSnapshot } from './destinations-list-cache'

const fetchDestinationsList = vi.fn()
const updateDestination = vi.fn()
const previewTestDestination = vi.fn()

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
  createDestination: vi.fn(),
  updateDestination: (...args: unknown[]) => updateDestination(...args),
  previewTestDestination: (...args: unknown[]) => previewTestDestination(...args),
  testDestination: vi.fn(),
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

const WEBHOOK_ROW = {
  id: 7,
  name: 'Protected Hook',
  destination_type: 'WEBHOOK_POST',
  // The API masks every header value in reads.
  config_json: {
    url: 'https://hook.example/ingest',
    payload_mode: 'SINGLE_EVENT_OBJECT',
    headers: { Authorization: '********', 'X-BFS-Dest': '********' },
  },
  rate_limit_json: {},
  enabled: true,
  updated_at: '2026-01-02T00:00:00Z',
  streams_using_count: 0,
  routes: [],
}

async function openEditSheet(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Protected Hook')
  await user.click(screen.getByRole('button', { name: /destination actions for protected hook/i }))
  await user.click(await screen.findByRole('button', { name: 'Edit' }))
}

beforeEach(() => {
  clearDestinationsListSnapshot()
  fetchDestinationsList.mockReset()
  updateDestination.mockReset()
  previewTestDestination.mockReset()
  fetchDestinationsList.mockResolvedValue([WEBHOOK_ROW])
  updateDestination.mockResolvedValue({ ...WEBHOOK_ROW, updated_at: '2026-01-03T00:00:00Z' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DestinationsManagementPage - webhook headers survive an edit (F-137)', () => {
  it('sends the masked headers back so the API keeps the stored values', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openEditSheet(user)

    expect(await screen.findByTestId('webhook-stored-headers')).toHaveTextContent('Authorization')
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateDestination).toHaveBeenCalledTimes(1))
    const body = updateDestination.mock.calls[0][1] as { config_json: Record<string, unknown> }
    expect(body.config_json.headers).toEqual({ Authorization: '********', 'X-BFS-Dest': '********' })
    expect(body.config_json.url).toBe('https://hook.example/ingest')
  })

  it('deletes a header only after an explicit Remove', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openEditSheet(user)

    await user.click(await screen.findByRole('button', { name: 'Remove header X-BFS-Dest' }))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(updateDestination).toHaveBeenCalledTimes(1))
    const body = updateDestination.mock.calls[0][1] as { config_json: Record<string, unknown> }
    expect(body.config_json.headers).toEqual({ Authorization: '********' })
  })

  it('never sends the mask placeholder as a real header value when testing unsaved form values', async () => {
    const user = userEvent.setup()
    previewTestDestination.mockResolvedValue({ success: true, latency_ms: 3, message: 'ok' })
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openEditSheet(user)
    await user.click(await screen.findByRole('button', { name: /test connection/i }))

    await waitFor(() => expect(previewTestDestination).toHaveBeenCalledTimes(1))
    const body = previewTestDestination.mock.calls[0][0] as { config_json: Record<string, unknown> }
    expect(body.config_json.headers).toBeUndefined()
  })
})
