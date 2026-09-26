import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchStreamFailoverRoutes } from '../../../api/gdcFailoverRouting'
import { fetchRuntimeRunTrace, runStreamOnce } from '../../../api/gdcRuntime'
import { proveStreamRunOnce } from './prove-stream-run-once'

vi.mock('../../../api/gdcRuntime', () => ({
  runStreamOnce: vi.fn(),
  fetchRuntimeRunTrace: vi.fn(),
}))

vi.mock('../../../api/gdcFailoverRouting', () => ({
  fetchStreamFailoverRoutes: vi.fn(),
}))

describe('proveStreamRunOnce', () => {
  beforeEach(() => {
    vi.mocked(runStreamOnce).mockReset()
    vi.mocked(fetchRuntimeRunTrace).mockReset()
    vi.mocked(fetchStreamFailoverRoutes).mockReset()
  })

  it('stays unverified when the trace run id does not match', async () => {
    vi.mocked(runStreamOnce).mockResolvedValue({
      stream_id: 42,
      outcome: 'completed',
      message: null,
      extracted_event_count: 1,
      mapped_event_count: 1,
      enriched_event_count: 1,
      delivered_batch_event_count: 1,
      checkpoint_updated: true,
      transaction_committed: true,
      runtime_run_id: 'run-new',
    })
    vi.mocked(fetchRuntimeRunTrace).mockResolvedValue({
      run_id: 'run-old',
      anchor_log_id: 1,
      stream_id: 42,
      connector: null,
      stream: null,
      routes: [],
      destinations: [],
      timeline: [
        {
          id: 1,
          created_at: '2026-09-26T01:00:00Z',
          stage: 'route_send_success',
          level: 'info',
          status: 'ok',
          message: 'sent',
          route_id: 7,
          destination_id: 11,
          latency_ms: 1,
          retry_count: 0,
          http_status: 200,
          error_code: null,
        },
      ],
      checkpoint: null,
    })

    const proof = await proveStreamRunOnce(42, null)
    expect(proof.status).toBe('unverified')
    expect(proof.routes).toEqual([])
  })

  it('attributes failover success to the secondary destination', async () => {
    vi.mocked(runStreamOnce).mockResolvedValue({
      stream_id: 42,
      outcome: 'completed',
      message: null,
      extracted_event_count: 1,
      mapped_event_count: null,
      enriched_event_count: null,
      delivered_batch_event_count: 1,
      checkpoint_updated: true,
      transaction_committed: true,
      runtime_run_id: 'run-f',
    })
    vi.mocked(fetchRuntimeRunTrace).mockResolvedValue({
      run_id: 'run-f',
      anchor_log_id: 1,
      stream_id: 42,
      connector: null,
      stream: { id: 42, name: 'Primary stream' },
      routes: [{ id: 7, destination_id: 11, label: 'Primary route' }],
      destinations: [],
      timeline: [
        {
          id: 1,
          created_at: '2026-09-26T01:00:00Z',
          stage: 'route_send_failed',
          level: 'error',
          status: 'failed',
          message: 'primary failed',
          route_id: 7,
          destination_id: 11,
          latency_ms: 1,
          retry_count: 0,
          http_status: 500,
          error_code: 'send_failed',
        },
        {
          id: 2,
          created_at: '2026-09-26T01:01:00Z',
          stage: 'failover_route_send_success',
          level: 'info',
          status: 'ok',
          message: 'failover sent',
          route_id: 7,
          destination_id: null,
          latency_ms: 2,
          retry_count: 0,
          http_status: 200,
          error_code: null,
        },
      ],
      checkpoint: null,
    })
    vi.mocked(fetchStreamFailoverRoutes).mockResolvedValue({
      stream_id: 42,
      route_count: 1,
      routes: [
        {
          id: 1,
          stream_id: 42,
          primary_destination_id: 11,
          primary_destination_name: 'Primary',
          secondary_destination_id: 22,
          secondary_destination_name: 'Secondary',
          enabled: true,
          policy: 'failover',
          created_at: '2026-09-26T00:00:00Z',
          updated_at: '2026-09-26T00:00:00Z',
        },
      ],
    })

    const proof = await proveStreamRunOnce(42, null)
    expect(proof.status).toBe('proven')
    expect(proof.routes[0]).toMatchObject({ destinationId: 22, destinationLabel: 'Secondary', status: 'proven' })
  })
})
