/**
 * Test-only rendering entry for pixel/DOM acceptance. Not a product route or
 * an operational source; no HTTP API, mutation, credentials or receiver claims.
 */
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { OperationalSnapshotResponse } from '../../src/api/operationalSnapshot'
import { DashboardLiveFlowsPanel } from '../../src/components/dashboard/dashboard-live-flows-panel'
import '../../src/index.css'

const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'healthy'
const updatedAt = scenario === 'stale'
  ? new Date(Date.now() - 5 * 60 * 1000).toISOString() : new Date().toISOString()

const snapshot: OperationalSnapshotResponse = {
  updated_at: updatedAt,
  global: {
    health_status: 'HEALTHY', total_streams: 1, enabled_streams: 1,
    running_streams: 1, error_streams: 0, total_routes: 4, enabled_routes: 4,
    total_destinations: 4, enabled_destinations: 4, total_eps_1m: 28.4,
    total_eps_5m: 27.1, avg_latency_ms: 27, last_activity_at: updatedAt,
  },
  streams: [{
    stream_id: 7, stream_name: 'Security Event Collection',
    connector_id: 4, source_id: 12,
    enabled: true, status: 'RUNNING', health_status: 'HEALTHY',
    eps_1m: 28.4, eps_5m: 27.1, success_rate_5m: 99.3,
    failure_rate_5m: 0.7, avg_latency_ms: 27, route_count: 4,
    healthy_route_count: 3, failed_route_count: 1,
    last_success_at: updatedAt, last_error_at: null, last_error_message: null,
    checkpoint_updated_at: updatedAt, checkpoint_lag_seconds: 1,
  }],
  routes: [
    { route_id: 12, stream_id: 7, stream_name: 'Security Event Collection',
      destination_id: 23, destination_name: 'SIEM Ingest', destination_type: 'SYSLOG_UDP',
      enabled: true, failure_policy: 'retry', health_status: 'HEALTHY',
      delivered_eps_1m: 12.4, failed_eps_1m: 0, success_rate_5m: 99.8,
      retry_rate_5m: 0, avg_latency_ms: 21,
      last_success_at: updatedAt, last_error_at: null, last_error_message: null },
    { route_id: 13, stream_id: 7, stream_name: 'Security Event Collection',
      destination_id: 25, destination_name: 'S3 Archive', destination_type: 'S3',
      enabled: true, failure_policy: 'retry', health_status: 'HEALTHY',
      delivered_eps_1m: 8.8, failed_eps_1m: 0, success_rate_5m: 99.6,
      retry_rate_5m: 0, avg_latency_ms: 25,
      last_success_at: updatedAt, last_error_at: null, last_error_message: null },
    { route_id: 14, stream_id: 7, stream_name: 'Security Event Collection',
      destination_id: 27, destination_name: 'UDP Receiver', destination_type: 'SYSLOG_UDP',
      enabled: true, failure_policy: 'retry', health_status: 'DEGRADED',
      delivered_eps_1m: 2.9, failed_eps_1m: 0.8, success_rate_5m: 91.5,
      retry_rate_5m: 0.2, avg_latency_ms: 171,
      last_success_at: updatedAt, last_error_at: updatedAt, last_error_message: 'Intermittent delivery timeout' },
    { route_id: 15, stream_id: 7, stream_name: 'Security Event Collection',
      destination_id: 29, destination_name: 'Backup Endpoint', destination_type: 'HTTP',
      enabled: true, failure_policy: 'retry', health_status: 'IDLE',
      delivered_eps_1m: 0, failed_eps_1m: 0, success_rate_5m: 0,
      retry_rate_5m: 0, avg_latency_ms: null,
      last_success_at: null, last_error_at: null, last_error_message: null },
  ],
  destinations: [
    { destination_id: 23, destination_name: 'SIEM Ingest', destination_type: 'SYSLOG_UDP',
      enabled: true, health_status: 'HEALTHY', inbound_eps_1m: 12.4, failed_eps_1m: 0,
      avg_latency_ms: 21, route_count: 1, last_success_at: updatedAt, last_error_at: null, last_error_message: null },
    { destination_id: 25, destination_name: 'S3 Archive', destination_type: 'S3',
      enabled: true, health_status: 'HEALTHY', inbound_eps_1m: 8.8, failed_eps_1m: 0,
      avg_latency_ms: 25, route_count: 1, last_success_at: updatedAt, last_error_at: null, last_error_message: null },
    { destination_id: 27, destination_name: 'UDP Receiver', destination_type: 'SYSLOG_UDP',
      enabled: true, health_status: 'DEGRADED', inbound_eps_1m: 2.9, failed_eps_1m: .8,
      avg_latency_ms: 171, route_count: 1, last_success_at: updatedAt, last_error_at: updatedAt, last_error_message: 'Intermittent delivery timeout' },
    { destination_id: 29, destination_name: 'Backup Endpoint', destination_type: 'HTTP',
      enabled: true, health_status: 'IDLE', inbound_eps_1m: 0, failed_eps_1m: 0,
      avg_latency_ms: null, route_count: 1, last_success_at: null, last_error_at: null, last_error_message: null },
  ],
  problems: [],
}

document.documentElement.setAttribute('data-dr-theme', 'dark')
document.documentElement.classList.add('dark')
document.body.style.background = '#051323'
document.body.style.color = '#eaf4ff'
document.body.style.margin = '0'
document.body.style.fontFamily = 'Inter, ui-sans-serif, system-ui, sans-serif'

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <div style={{ maxWidth: 1740, margin: '0 auto', padding: '28px 34px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 25, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 2, color: '#64cbf8', marginBottom: 7 }}>DATARELAY CONTROL · OPERATIONS</div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 720 }}>Routing Data Flows</h1>
        </div>
        <span data-testid="visual-fixture-only"
          style={{ padding: '8px 12px', border: '1px solid #985c22', color: '#ffc87b', borderRadius: 8, fontSize: 11 }}>
          VISUAL TEST FIXTURE · NOT LIVE TRAFFIC
        </span>
      </div>
      <DashboardLiveFlowsPanel snapshot={snapshot} />
    </div>
  </MemoryRouter>,
)
