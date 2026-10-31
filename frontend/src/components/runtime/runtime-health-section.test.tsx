import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { HealthBadge } from './operational-health/health-badge'
import { RuntimeHealthSection } from './runtime-health-section'
import type {
  DestinationHealthListResponse,
  HealthOverviewResponse,
  RouteHealthListResponse,
  StreamHealthListResponse,
} from '../../api/types/gdcApi'

const TIME = { window: '24h', since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z' }
const FILTERS = { stream_id: null, route_id: null, destination_id: null }

const emptyOverview = (): HealthOverviewResponse => ({
  time: TIME,
  filters: FILTERS,
  scoring_mode: 'current_runtime',
  streams: { healthy: 0, degraded: 0, unhealthy: 0, critical: 0 },
  routes: { healthy: 0, degraded: 0, unhealthy: 0, critical: 0 },
  destinations: { healthy: 0, degraded: 0, unhealthy: 0, critical: 0 },
  average_stream_score: null,
  average_route_score: null,
  average_destination_score: null,
  worst_routes: [],
  worst_streams: [],
  worst_destinations: [],
})

const emptyStreams = (): StreamHealthListResponse => ({
  time: TIME,
  filters: FILTERS,
  scoring_mode: 'current_runtime',
  rows: [],
})

const emptyRoutes = (): RouteHealthListResponse => ({
  time: TIME,
  filters: FILTERS,
  scoring_mode: 'current_runtime',
  rows: [],
})

const emptyDestinations = (): DestinationHealthListResponse => ({
  time: TIME,
  filters: FILTERS,
  scoring_mode: 'current_runtime',
  rows: [],
})

vi.mock('../../api/gdcRuntimeHealth', () => ({
  fetchHealthOverview: vi.fn(async () => emptyOverview()),
  fetchStreamHealthList: vi.fn(async () => emptyStreams()),
  fetchRouteHealthList: vi.fn(async () => emptyRoutes()),
  fetchDestinationHealthList: vi.fn(async () => emptyDestinations()),
}))

describe('HealthBadge', () => {
  it('renders level and score with tooltip from factors', () => {
    const { container } = render(
      <HealthBadge
        level="CRITICAL"
        score={12}
        factors={[
          { code: 'failure_rate', label: 'Failure rate >= 50%', delta: -60, detail: 'failure_rate=80%' },
        ]}
      />,
    )
    expect(screen.getByText(/CRITICAL/i)).toBeInTheDocument()
    const badge = container.querySelector('[data-health-level="CRITICAL"]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('data-health-score')).toBe('12')
    expect(badge?.getAttribute('title') ?? '').toContain('Failure rate')
  })

  it('renders baseline tooltip when factors empty', () => {
    const { container } = render(<HealthBadge level="HEALTHY" score={100} factors={[]} />)
    const badge = container.querySelector('[data-health-level="HEALTHY"]')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title') ?? '').toMatch(/baseline 100/i)
  })
})

describe('RuntimeHealthSection', () => {
  it('renders Not verified banner copy (never "All scored entities are HEALTHY") when nothing has been scored', async () => {
    render(
      <MemoryRouter>
        <RuntimeHealthSection query={{ window: '24h' }} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('runtime-health-section')).toBeInTheDocument()
    const banner = screen.getByTestId('runtime-health-banner')
    expect(banner.textContent).toMatch(/Not verified: no entities were scored/i)
    expect(banner.textContent).not.toMatch(/All scored entities are HEALTHY/i)
    expect(screen.getByTestId('runtime-health-routes-table').textContent).toMatch(/No unhealthy routes/i)
    expect(screen.getByTestId('runtime-health-streams-table').textContent).toMatch(/No degraded streams/i)
    expect(screen.getByTestId('runtime-health-destinations-table').textContent).toMatch(
      /No destination delivery activity/i,
    )
  })

  it('renders unhealthy route row with health badge and logs deep-link', async () => {
    const mod = await import('../../api/gdcRuntimeHealth')
    vi.mocked(mod.fetchRouteHealthList).mockResolvedValueOnce({
      ...emptyRoutes(),
      rows: [
        {
          route_id: 42,
          stream_id: 7,
          destination_id: 3,
          score: 28,
          level: 'CRITICAL',
          factors: [
            { code: 'failure_rate', label: 'Failure rate >= 50%', delta: -60, detail: null },
          ],
          metrics: {
            failure_count: 9,
            success_count: 1,
            retry_event_count: 0,
            retry_count_sum: 0,
            failure_rate: 0.9,
            retry_rate: 0,
            latency_ms_avg: null,
            latency_ms_p95: null,
            last_failure_at: null,
            last_success_at: null,
          },
        },
      ],
    })
    vi.mocked(mod.fetchHealthOverview).mockResolvedValueOnce({
      ...emptyOverview(),
      routes: { healthy: 0, degraded: 0, unhealthy: 0, critical: 1 },
      average_route_score: 28,
    })

    render(
      <MemoryRouter>
        <RuntimeHealthSection query={{ window: '24h' }} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/#42/)).toBeInTheDocument()
    const routesTable = screen.getByTestId('runtime-health-routes-table')
    expect(routesTable.textContent).toContain('CRITICAL')
    const link = routesTable.querySelector('a[href*="route_id=42"]')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toContain('stage=route_send_failed')
    expect(link?.getAttribute('href')).toContain('status=failed')
  })

  it('renders degraded stream row with stream name and stays accessible', async () => {
    const mod = await import('../../api/gdcRuntimeHealth')
    vi.mocked(mod.fetchStreamHealthList).mockResolvedValueOnce({
      ...emptyStreams(),
      rows: [
        {
          stream_id: 99,
          stream_name: 'orders-poll',
          connector_id: 4,
          score: 75,
          level: 'DEGRADED',
          factors: [
            { code: 'failure_rate', label: 'Failure rate >= 2%', delta: -8, detail: null },
          ],
          metrics: {
            failure_count: 3,
            success_count: 47,
            retry_event_count: 0,
            retry_count_sum: 0,
            failure_rate: 0.06,
            retry_rate: 0,
            latency_ms_avg: null,
            latency_ms_p95: null,
            last_failure_at: null,
            last_success_at: null,
          },
        },
      ],
    })

    render(
      <MemoryRouter>
        <RuntimeHealthSection query={{ window: '24h' }} />
      </MemoryRouter>,
    )

    const streamsTable = await screen.findByTestId('runtime-health-streams-table')
    expect(streamsTable.textContent).toContain('orders-poll')
    expect(streamsTable.textContent).toContain('DEGRADED')
    const link = streamsTable.querySelector('a[href*="stream_id=99"]')
    expect(link).not.toBeNull()
  })

  it('renders destination row with type and last failure deep-link', async () => {
    const mod = await import('../../api/gdcRuntimeHealth')
    vi.mocked(mod.fetchDestinationHealthList).mockResolvedValueOnce({
      ...emptyDestinations(),
      rows: [
        {
          destination_id: 5,
          destination_name: 'siem-webhook',
          destination_type: 'WEBHOOK_POST',
          score: 55,
          level: 'UNHEALTHY',
          factors: [],
          metrics: {
            failure_count: 4,
            success_count: 6,
            retry_event_count: 1,
            retry_count_sum: 2,
            failure_rate: 0.4,
            retry_rate: 0.1,
            latency_ms_avg: 240,
            latency_ms_p95: 600,
            last_failure_at: '2026-01-01T00:00:00Z',
            last_success_at: '2026-01-01T00:01:00Z',
          },
        },
      ],
    })

    render(
      <MemoryRouter>
        <RuntimeHealthSection query={{ window: '24h' }} />
      </MemoryRouter>,
    )

    const destTable = await screen.findByTestId('runtime-health-destinations-table')
    expect(destTable.textContent).toContain('siem-webhook')
    expect(destTable.textContent).toContain('WEBHOOK_POST')
    expect(destTable.textContent).toContain('UNHEALTHY')
    const link = destTable.querySelector('a[href*="destination_id=5"]')
    expect(link).not.toBeNull()
  })
})
