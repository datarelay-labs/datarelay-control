import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSession, persistSession } from '../../auth/session'
import type { RouteRuntimeMetricsRow, StreamRuntimeMetricsResponse } from '../../api/types/gdcApi'
import { resolveRouteRuntimeRows, RouteOperationalPanel } from './route-operational-panel'

const route = (override: Partial<RouteRuntimeMetricsRow> = {}): RouteRuntimeMetricsRow => ({
  route_id: 7, destination_id: 11, destination_name: 'Finance sink',
  destination_type: 'HTTP', enabled: true, route_status: 'ENABLED',
  success_rate: 100, events_last_hour: 0, delivered_last_hour: 0,
  failed_last_hour: 0, avg_latency_ms: 0, p95_latency_ms: 0,
  max_latency_ms: 0, eps_current: 0, retry_count_last_hour: 0,
  last_success_at: null, last_failure_at: null, last_error_message: null,
  last_error_code: null, failure_policy: 'retry', connectivity_state: 'HEALTHY',
  disable_reason: null, latency_trend: [], success_rate_trend: [],
  ...override,
})

function mount(row: RouteRuntimeMetricsRow, viewer: boolean) {
  const metrics = { route_runtime: [row] } as StreamRuntimeMetricsResponse
  const toggle = vi.fn(async () => {})
  const view = render(
    <MemoryRouter>
      <RouteOperationalPanel
        streamSlug="finance-source"
        backendStreamId={42}
        metrics={metrics}
        loading={false}
        routeToggleBusyId={null}
        onToggleEnabled={toggle}
        routeActionsReadOnly={viewer}
      />
    </MemoryRouter>,
  )
  return { ...view, toggle }
}

afterEach(() => clearSession())

describe('Stream Route operator investigation UI', () => {
  it('fails closed for an active Viewer even when a caller accidentally requests mutation controls', () => {
    persistSession({
      access_token: 'viewer-test-token',
      refresh_token: 'viewer-refresh',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      user: { username: 'viewer', role: 'VIEWER', status: 'ACTIVE' },
    })
    mount(route(), false)
    expect(screen.getByRole('link', { name: 'Investigate Route #7 delivery logs' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('keeps evidence read-only for Viewer while routing to exact logs and 24h trends', () => {
    mount(route(), true)
    expect(screen.getByRole('link', { name: 'Investigate Route #7 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=7&stream_id=42&destination_id=11')
    expect(screen.getByRole('link', { name: 'Inspect Route #7 delivery trends (24h)' }))
      .toHaveAttribute('href', '/monitoring/analytics?window=24h&stream_id=42&route_id=7&destination_id=11')
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('keeps editors existing toggle/probe/edit actions and separates them from investigation', () => {
    mount(route({ delivered_last_hour: 3, failed_last_hour: 1, success_rate: 75 }), false)
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/routes/7/edit')
    expect(screen.getByRole('link', { name: 'Investigate Route #7 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=7&stream_id=42&destination_id=11')
    expect(screen.getByTestId('route-delivery-success-7')).toHaveTextContent('75.0%')
  })

  it('never displays 100% delivery success when no route delivery outcome was measured', () => {
    mount(route(), true)
    expect(screen.getByTestId('route-delivery-success-7')).toHaveTextContent('—')
    expect(screen.getByTestId('route-delivery-latency-7')).toHaveTextContent('—')
    expect(screen.getByText(/no observed route delivery outcomes/i)).toBeInTheDocument()
  })

  it('refuses fabricated per-Route links for invalid IDs, while preserving the Stream identity', () => {
    mount(route({ route_id: -8, destination_id: -3 }), true)
    expect(screen.queryByRole('link', { name: /Investigate Route .* delivery logs/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Inspect Route .* delivery trends/ })).not.toBeInTheDocument()
  })

  it('legacy route-health zero outcomes are IDLE rather than falsely healthy 100%', () => {
    const source = {
      route_runtime: [], metrics_window_seconds: 3600,
      route_health: [{
        route_id: 7, destination_name: 'Finance sink', destination_type: 'HTTP',
        enabled: true, success_count: 0, failed_count: 0,
        last_success_at: null, last_failure_at: null, avg_latency_ms: 0,
        failure_policy: 'retry', last_error_message: null,
      }],
    } as StreamRuntimeMetricsResponse
    const fallback = resolveRouteRuntimeRows(source)
    expect(fallback).toHaveLength(1)
    expect(fallback[0]?.connectivity_state).toBe('IDLE')
    expect(fallback[0]?.success_rate).not.toBe(100)
    expect(fallback[0]?.success_rate_trend).toEqual([])
    expect(fallback[0]?.latency_trend).toEqual([])
  })
})
