import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteDetailHealthPanel } from './route-detail-health-panel'

const health = vi.fn()
const failures = vi.fn()
const retries = vi.fn()
const logs = vi.fn()
vi.mock('../../api/gdcRuntimeHealth', () => ({ fetchRouteHealthDetail: (...args: unknown[]) => health(...args) }))
vi.mock('../../api/gdcRuntimeAnalytics', () => ({
  fetchRouteFailuresForRoute: (...args: unknown[]) => failures(...args),
  fetchRetriesSummary: (...args: unknown[]) => retries(...args),
}))
vi.mock('../../api/gdcRuntime', () => ({ searchRuntimeDeliveryLogs: (...args: unknown[]) => logs(...args) }))
vi.mock('../runtime/operational-health/health-score-card', () => ({ HealthScoreCard: ({ score }: { score: { score: number } }) => <div data-testid="score">Score {score.score}</div> }))
vi.mock('../runtime/operational-health/health-trend-mini-chart', () => ({ HealthTrendMiniChart: () => <div>Failure trend chart</div> }))

const time = { since: '2026-10-14T00:00:00Z', until: '2026-10-14T00:01:00Z' }
function routeHealth(id: number, score = 95) {
  return { route_id: id, stream_id: 10, score: { score, metrics: { success_count: 10, failure_count: 0, retry_event_count: 1, retry_rate: 0.1, failure_rate: 0 } }, time }
}
function routeFailures(id: number) {
  return { route_id: id, filters: { route_id: id, stream_id: 10 }, totals: { success_events: 10, failure_events: 0 }, failure_trend: [], latency_ms_avg: 4, latency_ms_p95: 9, time }
}
function node(routeId: number) {
  return <MemoryRouter><RouteDetailHealthPanel routeId={routeId} streamId={10} /></MemoryRouter>
}

describe('M5-01 Route-scoped operational evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    health.mockImplementation(async (id: number) => routeHealth(id))
    failures.mockImplementation(async (id: number) => routeFailures(id))
    retries.mockImplementation(async ({ route_id }: { route_id: number }) => ({ total_retry_outcome_events: 1, filters: { route_id, stream_id: 10 } }))
    logs.mockResolvedValue({ logs: [] })
  })

  it('removes previous Route score and policy evidence immediately on selection change', async () => {
    logs.mockImplementation(async ({ route_id, stage }: { route_id: number; stage: string }) => ({ logs: route_id === 1 && stage === 'policy_blocked' ? [{ route_id: 1, stream_id: 10, stage, created_at: time.until, message: 'Route one policy outcome' }] : [] }))
    const { rerender } = render(node(1))
    expect(await screen.findByTestId('score')).toHaveTextContent('95')
    expect(screen.getByText('Route one policy outcome')).toBeInTheDocument()
    health.mockImplementation(() => new Promise(() => {}))
    rerender(node(2))
    expect(screen.queryByTestId('score')).not.toBeInTheDocument()
    expect(screen.queryByText('Route one policy outcome')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-health-loading')).toBeInTheDocument()
  })

  it('does not convert unavailable reads into a known empty or healthy result', async () => {
    health.mockResolvedValue(null)
    failures.mockResolvedValue(null)
    retries.mockResolvedValue(null)
    logs.mockResolvedValue(null)
    render(node(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
    expect(screen.queryByText(/no committed route delivery outcomes/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('score')).not.toBeInTheDocument()
    expect(screen.getByText(/source collection volume is reported separately/i)).toBeInTheDocument()
  })

  it('rejects a successful response for another Route instead of attaching it to the current label', async () => {
    health.mockResolvedValue(routeHealth(999, 97))
    failures.mockResolvedValue(routeFailures(999))
    render(node(2))
    expect(await screen.findByRole('alert')).toHaveTextContent('Route identity')
    expect(screen.queryByTestId('score')).not.toBeInTheDocument()
  })

  it('keeps a delayed response from a prior Route out of the new selection', async () => {
    let resolveOld!: (value: unknown) => void
    health.mockImplementation((id: number) => id === 1 ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(routeHealth(id, 72)))
    const { rerender } = render(node(1))
    await waitFor(() => expect(health).toHaveBeenCalledWith(1, expect.anything()))
    rerender(node(2))
    expect(await screen.findByTestId('score')).toHaveTextContent('72')
    await act(async () => resolveOld(routeHealth(1, 99)))
    expect(screen.getByTestId('score')).toHaveTextContent('72')
    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('href', expect.stringContaining('route_id=2'))
    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('href', expect.stringContaining('stream_id=10'))
  })

  it('retains available Route health while labelling unavailable supporting evidence', async () => {
    failures.mockResolvedValue(null)
    logs.mockResolvedValue(null)
    render(node(1))
    expect(await screen.findByTestId('score')).toHaveTextContent('95')
    expect(screen.getByRole('status')).toHaveTextContent('Delivery metrics')
    expect(screen.getByRole('status')).toHaveTextContent('policy evidence')
    expect(screen.queryByText(/no committed route delivery outcomes/i)).not.toBeInTheDocument()
  })

  it('displays the actual observation window without inventing a freshness timestamp', async () => {
    render(node(1))
    expect(await screen.findByTestId('score')).toBeInTheDocument()
    expect(screen.getByLabelText('Route observation window')).toHaveTextContent('2026-10-14T00:01:00Z')
    expect(screen.getByText(/gateway delivery outcomes, not receiver ingestion confirmation/i)).toBeInTheDocument()
  })

  it('does not make evidence requests for an invalid Route identifier', async () => {
    render(node(0))
    expect(await screen.findByRole('alert')).toHaveTextContent('valid Route')
    expect(health).not.toHaveBeenCalled()
    expect(failures).not.toHaveBeenCalled()
    expect(retries).not.toHaveBeenCalled()
    expect(logs).not.toHaveBeenCalled()
  })
})


describe('M5-01 honest empty and partial evidence', () => {
  it('does not present an empty-window score as healthy', async () => {
    const empty = routeHealth(1, 100)
    empty.score.metrics.success_count = 0
    health.mockResolvedValue(empty)
    failures.mockResolvedValue(null)
    retries.mockResolvedValue(null)
    logs.mockResolvedValue({ logs: [] })
    render(node(1))
    expect(await screen.findByTestId('route-health-empty')).toHaveTextContent('health is not established')
    expect(screen.queryByTestId('score')).not.toBeInTheDocument()
  })

  it('keeps valid health when the optional policy request rejects', async () => {
    health.mockResolvedValue(routeHealth(1))
    failures.mockResolvedValue(routeFailures(1))
    retries.mockResolvedValue(null)
    logs.mockRejectedValue(new Error('policy read unavailable'))
    render(node(1))
    expect(await screen.findByTestId('score')).toHaveTextContent('95')
    expect(screen.getByRole('status')).toHaveTextContent('policy evidence')
  })
})


describe('M5-01 missing measurements and response scope', () => {
  it('keeps missing outcome counts unknown rather than converting them into measured zero', async () => {
    health.mockResolvedValue({ ...routeHealth(1), score: { score: 100, metrics: {} } })
    failures.mockResolvedValue(null)
    retries.mockResolvedValue(null)
    logs.mockResolvedValue({ logs: [] })
    render(node(1))
    expect(await screen.findByTestId('route-health-empty')).toHaveTextContent('missing outcome counts are not zero')
    expect(screen.queryByText(/No committed Route delivery outcomes/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('score')).not.toBeInTheDocument()
  })

  it('rejects an unscoped retry aggregate instead of labelling it as the selected Route', async () => {
    health.mockResolvedValue(routeHealth(1))
    failures.mockResolvedValue(routeFailures(1))
    retries.mockResolvedValue({ total_retry_outcome_events: 999, filters: { route_id: null } })
    logs.mockResolvedValue({ logs: [] })
    render(node(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('Route identity')
    expect(screen.queryByText('999')).not.toBeInTheDocument()
  })

  it('excludes another Route policy log without exposing its message', async () => {
    health.mockResolvedValue(routeHealth(1))
    failures.mockResolvedValue(routeFailures(1))
    retries.mockResolvedValue(null)
    logs.mockResolvedValue({ logs: [{ route_id: 2, stream_id: 10, stage: 'policy_blocked', created_at: time.until, message: 'other-route-private-business-data' }] })
    render(node(1))
    expect(await screen.findByTestId('score')).toHaveTextContent('95')
    expect(screen.getByRole('status')).toHaveTextContent('another path was excluded')
    expect(screen.queryByText('other-route-private-business-data')).not.toBeInTheDocument()
  })
})


describe('M5-02 observation timestamp provenance', () => {
  it('uses provided generation time when the snapshot identifier is opaque', async () => {
    health.mockResolvedValue({ ...routeHealth(1), time: { ...time, snapshot_id: 'snapshot-opaque-id', generated_at: '2026-10-14T00:00:30Z' } })
    failures.mockResolvedValue(routeFailures(1))
    retries.mockResolvedValue(null)
    logs.mockResolvedValue({ logs: [] })
    render(node(1))
    expect(await screen.findByTestId('score')).toBeInTheDocument()
    expect(screen.getByLabelText('Route observation window')).toHaveTextContent('Snapshot 2026-10-14T00:00:30Z')
    expect(screen.getByLabelText('Route observation window')).not.toHaveTextContent('Snapshot 2026-10-14T00:01:00Z')
  })
})
