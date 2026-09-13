import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ReplayPanel } from './replay-panel'
import * as gdcReplay from '../../api/gdcReplay'

vi.mock('../../api/gdcReplay', () => ({
  fetchStreamReplaySummary: vi.fn(),
  fetchStreamReplayEvents: vi.fn(),
  replayStreamReplayEvent: vi.fn(),
  discardStreamReplayEvent: vi.fn(),
}))

const summary = {
  stream_id: 42,
  pending_count: 1,
  replayed_count: 1,
  failed_count: 1,
  discarded_count: 1,
  total_count: 4,
  last_recorded_at: '2026-06-04T12:00:00Z',
}

const events = [
  {
    id: 10,
    stream_id: 42,
    destination_id: 5,
    route_id: 3,
    dynamic_route_id: null,
    failover_route_id: null,
    delivery_kind: 'base_route',
    status: 'pending' as const,
    error_type: null,
    error_message: null,
    retry_count: 0,
    event_count: 2,
    created_at: '2026-06-04T11:00:00Z',
    updated_at: '2026-06-04T11:00:00Z',
    last_replay_at: null,
  },
  {
    id: 11,
    stream_id: 42,
    destination_id: 5,
    route_id: 3,
    dynamic_route_id: null,
    failover_route_id: null,
    delivery_kind: 'failover_secondary',
    status: 'failed' as const,
    error_type: 'RuntimeError',
    error_message: 'send failed',
    retry_count: 1,
    event_count: 1,
    created_at: '2026-06-04T10:00:00Z',
    updated_at: '2026-06-04T10:30:00Z',
    last_replay_at: '2026-06-04T10:30:00Z',
  },
  {
    id: 12,
    stream_id: 42,
    destination_id: 6,
    route_id: 3,
    dynamic_route_id: 7,
    failover_route_id: null,
    delivery_kind: 'dynamic_route',
    status: 'replayed' as const,
    error_type: null,
    error_message: null,
    retry_count: 1,
    event_count: 1,
    created_at: '2026-06-04T09:00:00Z',
    updated_at: '2026-06-04T09:05:00Z',
    last_replay_at: '2026-06-04T09:05:00Z',
  },
  {
    id: 13,
    stream_id: 42,
    destination_id: 5,
    route_id: 3,
    dynamic_route_id: null,
    failover_route_id: null,
    delivery_kind: 'base_route',
    status: 'discarded' as const,
    error_type: null,
    error_message: null,
    retry_count: 0,
    event_count: 1,
    created_at: '2026-06-04T08:00:00Z',
    updated_at: '2026-06-04T08:01:00Z',
    last_replay_at: null,
  },
]

describe('ReplayPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(gdcReplay.fetchStreamReplaySummary).mockResolvedValue(summary)
    vi.mocked(gdcReplay.fetchStreamReplayEvents).mockResolvedValue({
      stream_id: 42,
      events,
      event_count: events.length,
    })
    vi.mocked(gdcReplay.replayStreamReplayEvent).mockResolvedValue({
      id: 10,
      stream_id: 42,
      destination_id: 5,
      route_id: 3,
      status: 'replayed',
      retry_count: 1,
      outcome: 'replayed',
      message: 'ok',
    })
    vi.mocked(gdcReplay.discardStreamReplayEvent).mockResolvedValue({
      id: 10,
      stream_id: 42,
      destination_id: 5,
      route_id: 3,
      status: 'discarded',
      retry_count: 0,
      outcome: 'discarded',
      message: 'discarded',
    })
  })

  it('renders summary counts and status rows', async () => {
    render(<ReplayPanel streamId={42} canOperate />)
    await waitFor(() => expect(screen.getByTestId('replay-summary')).toBeInTheDocument())
    const summaryEl = screen.getByTestId('replay-summary')
    expect(summaryEl.textContent).toContain('Pending')
    expect(summaryEl.textContent).toContain('Failed')
    expect(screen.getByTestId('replay-event-row-10')).toBeInTheDocument()
    expect(screen.getByTestId('replay-event-row-11')).toBeInTheDocument()
    expect(screen.getByTestId('replay-event-row-12')).toBeInTheDocument()
    expect(screen.getByTestId('replay-event-row-13')).toBeInTheDocument()
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('replayed')).toBeInTheDocument()
    expect(screen.getByText('discarded')).toBeInTheDocument()
  })

  it('invokes replay and discard actions without throwing', async () => {
    const user = userEvent.setup()
    render(<ReplayPanel streamId={42} canOperate />)
    await waitFor(() => expect(screen.getByTestId('replay-event-replay-10')).toBeInTheDocument())
    await user.click(screen.getByTestId('replay-event-replay-10'))
    expect(await screen.findByTestId('replay-execute-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('replay-execute-dialog-confirm'))
    await waitFor(() => expect(gdcReplay.replayStreamReplayEvent).toHaveBeenCalledWith(10))
    await user.click(screen.getByTestId('replay-event-discard-11'))
    expect(await screen.findByTestId('replay-discard-dialog')).toBeInTheDocument()
    await user.click(screen.getByTestId('replay-discard-dialog-confirm'))
    await waitFor(() => expect(gdcReplay.discardStreamReplayEvent).toHaveBeenCalledWith(11))
  })

  it('surfaces duplicate-delivery risk before live replay', async () => {
    const user = userEvent.setup()
    render(<ReplayPanel streamId={42} canOperate />)
    await waitFor(() => expect(screen.getByTestId('replay-event-replay-10')).toBeInTheDocument())
    await user.click(screen.getByTestId('replay-event-replay-10'))
    const dialog = await screen.findByTestId('replay-execute-dialog')
    expect(dialog.textContent).toMatch(/Duplicate downstream delivery/i)
    expect(screen.getByTestId('replay-execute-dialog-cancel')).toBeInTheDocument()
  })
})
