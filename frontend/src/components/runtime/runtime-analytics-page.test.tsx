import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeAnalyticsPage } from './runtime-analytics-page'
import { observabilitySummaryFixture } from '../../test/runtimeApiFixtures'
import type {
  RetrySummaryResponse,
  RouteFailuresAnalyticsResponse,
  StreamRetriesAnalyticsResponse,
} from '../../api/types/gdcApi'

const snapshotParam = (params?: { snapshot_id?: string }) => params?.snapshot_id ?? '2026-01-02T00:00:00Z'

vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(async (_window: string, params?: { snapshot_id?: string }) =>
    observabilitySummaryFixture(snapshotParam(params)),
  ),
}))

const emptyFailures = (snapshot_id = '2026-01-02T00:00:00Z'): RouteFailuresAnalyticsResponse => ({
  time: { window: '24h', since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', snapshot_id },
  filters: { stream_id: null, route_id: null, destination_id: null },
  totals: { failure_events: 0, success_events: 0, overall_failure_rate: 0 },
  latency_ms_avg: null,
  latency_ms_p95: null,
  last_failure_at: null,
  last_success_at: null,
  outcomes_by_route: [],
  failures_by_destination: [],
  failures_by_stream: [],
  failure_trend: [],
  top_error_codes: [],
  top_failed_stages: [],
  unstable_routes: [],
})

const emptyRetries = (snapshot_id = '2026-01-02T00:00:00Z'): RetrySummaryResponse => ({
  time: { window: '24h', since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', snapshot_id },
  filters: { stream_id: null, route_id: null, destination_id: null },
  retry_success_events: 0,
  retry_failed_events: 0,
  total_retry_outcome_events: 0,
  retry_column_sum: 0,
})

const emptyRank = (snapshot_id = '2026-01-02T00:00:00Z'): StreamRetriesAnalyticsResponse => ({
  time: { window: '24h', since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', snapshot_id },
  filters: { stream_id: null, route_id: null, destination_id: null },
  retry_heavy_streams: [],
  retry_heavy_routes: [],
})

vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchRouteFailuresAnalytics: vi.fn(async (params?: { snapshot_id?: string }) => emptyFailures(snapshotParam(params))),
  fetchRetriesSummary: vi.fn(async (params?: { snapshot_id?: string }) => emptyRetries(snapshotParam(params))),
  fetchStreamRetriesAnalytics: vi.fn(async (params?: { snapshot_id?: string }) => emptyRank(snapshotParam(params))),
}))

async function resetAnalyticsMocks(): Promise<void> {
  const mod = await import('../../api/gdcRuntimeAnalytics')
  vi.mocked(mod.fetchRouteFailuresAnalytics).mockReset()
  vi.mocked(mod.fetchRetriesSummary).mockReset()
  vi.mocked(mod.fetchStreamRetriesAnalytics).mockReset()
  vi.mocked(mod.fetchRouteFailuresAnalytics).mockImplementation(async (params?: { snapshot_id?: string }) =>
    emptyFailures(snapshotParam(params)),
  )
  vi.mocked(mod.fetchRetriesSummary).mockImplementation(async (params?: { snapshot_id?: string }) =>
    emptyRetries(snapshotParam(params)),
  )
  vi.mocked(mod.fetchStreamRetriesAnalytics).mockImplementation(async (params?: { snapshot_id?: string }) =>
    emptyRank(snapshotParam(params)),
  )
}

describe('RuntimeAnalyticsPage', () => {
  beforeEach(async () => {
    await resetAnalyticsMocks()
    const obs = await import('../../api/observabilitySummary')
    vi.mocked(obs.fetchObservabilitySummary).mockReset()
    vi.mocked(obs.fetchObservabilitySummary).mockImplementation(async (_window: string, params?: { snapshot_id?: string }) =>
      observabilitySummaryFixture(snapshotParam(params)),
    )
  })

  it('renders empty operational copy when no samples exist', async () => {
    render(
      <MemoryRouter>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: /Delivery analytics/i })).toBeInTheDocument()
    expect(await screen.findByText(/No delivery outcomes in this window/i)).toBeInTheDocument()
  })

  it('does not silently interpret malformed analytics URL IDs as valid narrow-scoped outcomes', async () => {
    const mod = await import('../../api/gdcRuntimeAnalytics')
    render(
      <MemoryRouter initialEntries={['/monitoring/analytics?stream_id=-2&route_id=42junk&destination_id=3.5']}>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(mod.fetchRouteFailuresAnalytics).toHaveBeenCalled())
    expect(vi.mocked(mod.fetchRouteFailuresAnalytics).mock.calls[0]?.[0]).toMatchObject({
      stream_id: undefined, route_id: undefined, destination_id: undefined,
    })
    const notice = screen.getByRole('status', { name: 'Invalid analytics filters' })
    expect(notice).toHaveTextContent('Invalid Stream ID ignored')
    expect(notice).toHaveTextContent('Invalid Route ID ignored')
    expect(notice).toHaveTextContent('Invalid Destination ID ignored')
  })

  it('retains valid exact Route, Stream and Destination scope from a Data Flows deep link', async () => {
    const mod = await import('../../api/gdcRuntimeAnalytics')
    render(
      <MemoryRouter initialEntries={['/monitoring/analytics?window=24h&stream_id=2&route_id=42&destination_id=10']}>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(mod.fetchRouteFailuresAnalytics).toHaveBeenCalledWith(expect.objectContaining({
      stream_id: 2, route_id: 42, destination_id: 10, window: '24h',
    })))
    expect(screen.queryByRole('status', { name: 'Invalid analytics filters' })).not.toBeInTheDocument()
  })

  it('rejects pasted nonnumeric Route IDs rather than presenting truncated ID results', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><RuntimeAnalyticsPage /></MemoryRouter>)
    const field = screen.getByLabelText('route_id')
    await user.type(field, '12oops')
    expect(field).toHaveValue('12')
  })

  it('always offers a read-only way back to the exact scoped Route logs when analytics has no outcomes', async () => {
    render(
      <MemoryRouter initialEntries={['/monitoring/analytics?window=24h&stream_id=2&route_id=42&destination_id=10']}>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No delivery outcomes in this window/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Route #42 logs' }))
      .toHaveAttribute('href', '/logs?route_id=42&stream_id=2&destination_id=10')
  })

  it('never invents a return path for invalid or unspecified Route URL scope', async () => {
    const invalid = render(
      <MemoryRouter initialEntries={['/monitoring/analytics?route_id=42junk&stream_id=2']}>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: /Back to Route .* logs/ })).not.toBeInTheDocument()
    invalid.unmount()
    render(<MemoryRouter><RuntimeAnalyticsPage /></MemoryRouter>)
    expect(screen.queryByRole('link', { name: /Back to Route .* logs/ })).not.toBeInTheDocument()
  })

  it('renders unstable route row when API returns candidates', async () => {
    const mod = await import('../../api/gdcRuntimeAnalytics')
    vi.mocked(mod.fetchRouteFailuresAnalytics).mockImplementationOnce(async (params?: { snapshot_id?: string }) => ({
      ...emptyFailures(snapshotParam(params)),
      unstable_routes: [
        {
          route_id: 77,
          stream_id: 3,
          destination_id: 9,
          failure_count: 8,
          success_count: 2,
          failure_rate: 0.8,
          sample_total: 10,
        },
      ],
    }))
    render(
      <MemoryRouter>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/#77/)).toBeInTheDocument()
    expect(screen.getByText(/80\.0%/)).toBeInTheDocument()
    const logsLink = screen.getByRole('link', { name: /Open logs/i })
    expect(logsLink.getAttribute('href')).toContain('status=failed')
    expect(logsLink.getAttribute('href')).toContain('stage=route_send_failed')
  })

  it('renders failure trend as a histogram with visualization semantics', async () => {
    const mod = await import('../../api/gdcRuntimeAnalytics')
    vi.mocked(mod.fetchRouteFailuresAnalytics).mockImplementationOnce(async (params?: { snapshot_id?: string }) => ({
      ...emptyFailures(snapshotParam(params)),
      visualization_meta: {
        'analytics.delivery_failures.bucket_histogram': {
          metric_id: 'delivery_outcomes.failure',
          chart_metric_id: 'analytics.delivery_failures.bucket_histogram',
          aggregation_type: 'bucket_failure_event_sum',
          visualization_type: 'histogram',
          normalization_rule: 'raw_count',
          bucket_unit: 'bucket',
          bucket_size_seconds: 300,
          y_axis_semantics: 'Failed delivery outcome event counts per fixed bucket.',
          avg_vs_peak_semantics: 'Histogram bucket counts are independent values, not a running total.',
          cumulative_semantics: 'histogram_not_cumulative',
          subset_semantics: 'filtered_metric',
          chart_window_semantics: 'Fixed buckets over the resolved analytics window and filters.',
          snapshot_alignment_required: true,
          display_unit: 'failures',
          tooltip_template: '{metric_family}: {value} failures; histogram bucket; snapshot {snapshot_time}.',
          generated_at: '2026-01-02T00:00:00Z',
        },
      },
      failure_trend: [{ bucket_start: '2026-01-01T23:55:00Z', failure_count: 2 }],
      totals: { failure_events: 2, success_events: 0, overall_failure_rate: 1 },
    }))
    render(
      <MemoryRouter>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: /Failure histogram/i })).toBeInTheDocument()
    expect(screen.getByText(/Normalization: raw_count/i)).toBeInTheDocument()
  })

  it('keeps the previous analytics data when a refresh snapshot mismatches', async () => {
    const user = userEvent.setup()
    const mod = await import('../../api/gdcRuntimeAnalytics')
    const obs = await import('../../api/observabilitySummary')
    vi.mocked(obs.fetchObservabilitySummary).mockImplementation(async (_window: string, params?: { snapshot_id?: string }) => {
      const snapshot_id = snapshotParam(params)
      return {
        ...observabilitySummaryFixture(snapshot_id),
        totals: { ...observabilitySummaryFixture(snapshot_id).totals, delivery_failed_events: 5 },
      }
    })
    let failuresCall = 0
    vi.mocked(mod.fetchRouteFailuresAnalytics).mockImplementation(async (params?: { snapshot_id?: string }) => {
      failuresCall += 1
      if (failuresCall === 1) {
        return {
          ...emptyFailures(snapshotParam(params)),
          totals: { failure_events: 5, success_events: 10, overall_failure_rate: 1 / 3 },
        }
      }
      return {
        ...emptyFailures('older-snapshot'),
        totals: { failure_events: 99, success_events: 0, overall_failure_rate: 1 },
      }
    })
    render(
      <MemoryRouter>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('5')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Refresh/i }))
    await waitFor(() => expect(screen.queryByText(/Loading analytics/i)).not.toBeInTheDocument())
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.queryByText('99')).not.toBeInTheDocument()
    expect(screen.queryByText(/older-snapshot/i)).not.toBeInTheDocument()
  })

  it('retry-heavy stream logs link includes status=retry and retry stage', async () => {
    const mod = await import('../../api/gdcRuntimeAnalytics')
    vi.mocked(mod.fetchStreamRetriesAnalytics).mockImplementation(async (params?: { snapshot_id?: string }) => ({
      ...emptyRank(snapshotParam(params)),
      retry_heavy_streams: [{ stream_id: 44, retry_event_count: 2, retry_column_sum: 4 }],
    }))
    render(
      <MemoryRouter>
        <RuntimeAnalyticsPage />
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /Open logs/i })
    expect(link.getAttribute('href')).toContain('status=retry')
    expect(link.getAttribute('href')).toContain('stage=route_retry_failed')
    expect(link.getAttribute('href')).toContain('stream_id=44')
  })
})
