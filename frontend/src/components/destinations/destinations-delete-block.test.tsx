import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DestinationsManagementPage } from './destinations-management-page'
import { clearDestinationsListSnapshot } from './destinations-list-cache'

const fetchDestinationsList = vi.fn()
const deleteDestination = vi.fn()

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  previewTestDestination: vi.fn(),
  testDestination: vi.fn(),
  deleteDestination: (...args: unknown[]) => deleteDestination(...args),
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

function row(overrides: Record<string, unknown>) {
  return {
    id: 11,
    name: 'Disabled Hook',
    destination_type: 'WEBHOOK_POST',
    config_json: { url: 'https://hook.example/ingest', payload_mode: 'SINGLE_EVENT_OBJECT' },
    rate_limit_json: {},
    enabled: false,
    updated_at: '2026-01-02T00:00:00Z',
    streams_using_count: 1,
    routes: [{ route_id: 5, stream_id: 3, stream_name: 'Orders' }],
    ...overrides,
  }
}

async function openDelete(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByText(name)
  await user.click(screen.getByRole('button', { name: new RegExp(`destination actions for ${name}`, 'i') }))
  await user.click(await screen.findByRole('button', { name: 'Delete' }))
}

beforeEach(() => {
  clearDestinationsListSnapshot()
  fetchDestinationsList.mockReset()
  deleteDestination.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DestinationsManagementPage - delete is never a silent no-op (F-144)', () => {
  it('opens the dialog with the reason and a disabled confirm for a disabled destination that still has routes', async () => {
    fetchDestinationsList.mockResolvedValue([row({})])
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openDelete(user, 'Disabled Hook')

    const block = await screen.findByTestId('destination-delete-dialog-block')
    expect(block).toHaveTextContent(/route/i)
    expect(screen.getByTestId('destination-delete-dialog-dependencies')).toBeInTheDocument()
    expect(screen.getByTestId('destination-delete-dialog-confirm')).toBeDisabled()
    expect(deleteDestination).not.toHaveBeenCalled()
  })

  it('tells the user to disable an enabled destination first', async () => {
    fetchDestinationsList.mockResolvedValue([
      row({ id: 12, name: 'Live Hook', enabled: true, routes: [], streams_using_count: 0 }),
    ])
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openDelete(user, 'Live Hook')

    expect(await screen.findByTestId('destination-delete-dialog-block')).toHaveTextContent(
      /disable it before deleting/i,
    )
    expect(screen.getByTestId('destination-delete-dialog-confirm')).toBeDisabled()
  })

  it('allows deleting a disabled destination with no routes after typing its name', async () => {
    fetchDestinationsList.mockResolvedValue([row({ id: 13, name: 'Free Hook', routes: [], streams_using_count: 0 })])
    deleteDestination.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <DestinationsManagementPage />
      </MemoryRouter>,
    )
    await openDelete(user, 'Free Hook')

    expect(screen.queryByTestId('destination-delete-dialog-block')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('destination-delete-dialog-type-name'), 'Free Hook')
    await user.click(screen.getByTestId('destination-delete-dialog-confirm'))
    await waitFor(() => expect(deleteDestination).toHaveBeenCalledTimes(1))
  })
})
