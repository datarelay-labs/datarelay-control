import { describe, expect, it } from 'vitest'
import type { ConnectorRead } from '../api/gdcConnectors'
import type { ConnectorOperationsRow } from '../api/gdcConnectorsOperations'
import {
  computeConnectorHealth,
  connectorHealthBadgeClass,
  connectorHealthSortRank,
  connectorHealthTone,
  connectorTierFromCriticalStreams,
  dataFreshnessReason,
  formatAuthHealthCheckStatus,
  formatEventTrendDisplay,
  formatStreamsHealthPopoverSummary,
  formatStreamsHealthSummary,
  connectorStreamsFilterPath,
  countStreamsByHealth,
} from './connector-operational-health'

function baseConnector(overrides: Partial<ConnectorRead> = {}): ConnectorRead {
  return {
    id: 1,
    name: 'Test Connector',
    description: null,
    status: 'RUNNING',
    connector_type: 'generic_http',
    source_type: 'HTTP_API_POLLING',
    source_id: 1,
    stream_count: 2,
    host: 'http://example.com',
    base_url: 'http://example.com',
    verify_ssl: true,
    http_proxy: null,
    common_headers: {},
    auth_type: 'bearer',
    auth: {},
    ...overrides,
  }
}

function stream(
  id: number,
  health: 'healthy' | 'warning' | 'critical' | 'stopped',
  primary_issue: string | null = null,
) {
  return {
    stream_id: id,
    stream_name: `Stream ${id}`,
    status: 'RUNNING',
    enabled: true,
    health,
    primary_issue,
    events_1h: health === 'healthy' ? 50 : 0,
    last_success_at: health === 'healthy' ? new Date(Date.now() - 5 * 60_000).toISOString() : null,
  }
}

function opsWithStreams(
  streams: ConnectorOperationsRow['streams'],
  extra: Partial<ConnectorOperationsRow> = {},
): ConnectorOperationsRow {
  return {
    connector_id: 1,
    stream_count: streams.length,
    destination_count: 3,
    affected_stream_count: streams.filter((s) => s.health === 'warning' || s.health === 'critical').length,
    affected_destination_count: 3,
    streams,
    streams_healthy_count: streams.filter((s) => s.health === 'healthy').length,
    streams_warning_count: streams.filter((s) => s.health === 'warning').length,
    streams_critical_count: streams.filter((s) => s.health === 'critical').length,
    streams_stopped_count: streams.filter((s) => s.health === 'stopped').length,
    stale_stream_count: 0,
    last_event_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_event_at_active: new Date(Date.now() - 5 * 60_000).toISOString(),
    events_1h: 100,
    events_24h: 5000,
    events_last_1h: 100,
    events_previous_1h: 1000,
    event_trend_percent: -90,
    eps: 0.03,
    auth_health_check_interval: 'disabled',
    last_auth_check_at: null,
    last_auth_check_status: null,
    last_auth_error: null,
    ...extra,
  }
}

describe('connectorTierFromCriticalStreams', () => {
  it('Case 1: 1 stream, 1 critical → Connector Critical', () => {
    expect(connectorTierFromCriticalStreams(1, 1)).toBe('Critical')
    const connector = baseConnector({ last_auth_check_status: 'success' })
    const ops = opsWithStreams([stream(1, 'critical', 'Destination Error')])
    expect(computeConnectorHealth(connector, ops).health).toBe('Critical')
  })

  it('Case 2: 2 streams, 1 critical → Connector Warning', () => {
    expect(connectorTierFromCriticalStreams(2, 1)).toBe('Warning')
    const connector = baseConnector({ last_auth_check_status: 'success' })
    const ops = opsWithStreams([stream(1, 'healthy'), stream(2, 'critical', 'Destination Error')])
    const result = computeConnectorHealth(connector, ops)
    expect(result.health).toBe('Warning')
    expect(result.reason).toMatch(/Stream Failed/)
  })

  it('2 streams, 2 critical → Connector Critical', () => {
    expect(connectorTierFromCriticalStreams(2, 2)).toBe('Critical')
  })
})

describe('computeConnectorHealth', () => {
  it('auth success + all streams healthy → Healthy', () => {
    const connector = baseConnector({ last_auth_check_status: 'success' })
    const ops = opsWithStreams([stream(1, 'healthy'), stream(2, 'healthy')])
    expect(computeConnectorHealth(connector, ops)).toEqual({ health: 'Healthy', reason: 'Auth OK' })
  })

  it('auth success + 2 streams warning → Warning', () => {
    const connector = baseConnector({ last_auth_check_status: 'success' })
    const ops = opsWithStreams([
      stream(1, 'healthy'),
      stream(2, 'warning', 'No Data (1h)'),
      stream(3, 'warning', 'Destination Error'),
    ])
    const result = computeConnectorHealth(connector, ops)
    expect(result.health).toBe('Warning')
    expect(result.reason).toMatch(/Streams Warning/)
  })

  it('Case 3: auth failed + streams failed → Authentication Failed only', () => {
    const connector = baseConnector({
      last_auth_check_status: 'failed',
      last_auth_error: '401 Unauthorized',
    })
    const ops = opsWithStreams([
      stream(1, 'critical', 'Destination Error'),
      stream(2, 'critical', 'Destination Error'),
    ])
    expect(computeConnectorHealth(connector, ops)).toEqual({
      health: 'Critical',
      reason: 'Authentication Failed',
    })
  })

  it('reads Not verified (neutral), never Healthy/Auth OK, when no operations summary was loaded', () => {
    const connector = baseConnector({ last_auth_check_status: 'success' })
    expect(computeConnectorHealth(connector, undefined)).toEqual({
      health: 'Not verified',
      reason: 'Operations summary not available',
    })
    expect(connectorHealthTone('Not verified')).toBe('neutral')
    expect(connectorHealthBadgeClass('Not verified')).toContain('slate')
    expect(connectorHealthSortRank('Not verified')).toBeGreaterThan(connectorHealthSortRank('Healthy'))
  })

  it('keeps an auth failure Critical even without an operations summary', () => {
    const connector = baseConnector({ last_auth_check_status: 'failed', last_auth_error: '401' })
    expect(computeConnectorHealth(connector, undefined).health).toBe('Critical')
  })

  it('marks stopped connectors as Stopped', () => {
    const connector = baseConnector({ status: 'STOPPED' })
    expect(computeConnectorHealth(connector, undefined)).toEqual({ health: 'Stopped', reason: 'Disabled' })
  })
})

describe('formatStreamsHealthSummary', () => {
  it('Case 5: shows (4 Healthy / 1 Critical)', () => {
    const counts = countStreamsByHealth([
      stream(1, 'healthy'),
      stream(2, 'healthy'),
      stream(3, 'healthy'),
      stream(4, 'healthy'),
      stream(5, 'critical', 'Destination Error'),
    ])
    expect(formatStreamsHealthSummary(counts)).toBe('(4 Healthy / 1 Critical)')
  })
})

describe('formatStreamsHealthPopoverSummary', () => {
  it('lists health counts for popover header', () => {
    const counts = countStreamsByHealth([
      stream(1, 'healthy'),
      stream(2, 'healthy'),
      stream(3, 'healthy'),
      stream(4, 'healthy'),
      stream(5, 'warning', 'Destination Error'),
      stream(6, 'critical', 'Destination Error'),
    ])
    expect(formatStreamsHealthPopoverSummary(counts)).toEqual(['Healthy: 4', 'Warning: 1', 'Critical: 1'])
  })
})

describe('formatEventTrendDisplay', () => {
  it('Case 3: 100 vs 1000 → ↓ 90% critical candidate', () => {
    expect(formatEventTrendDisplay(-90)).toEqual({
      label: 'Traffic Drop Detected',
      severity: 'critical_candidate',
      percent: -90,
    })
  })

  it('50% drop → warning', () => {
    expect(formatEventTrendDisplay(-50)?.severity).toBe('warning')
    expect(formatEventTrendDisplay(-50)?.label).toBe('↓ 50%')
  })

  it('ignores increases and small drops', () => {
    expect(formatEventTrendDisplay(10)).toBeNull()
    expect(formatEventTrendDisplay(-30)).toBeNull()
  })
})

describe('connectorStreamsFilterPath', () => {
  it('Case 4: View Streams → /streams?connector=<id>', () => {
    expect(connectorStreamsFilterPath(42, 'Cybereason')).toBe('/streams?connector=42')
  })
})

describe('formatAuthHealthCheckStatus', () => {
  it('Case 4: scheduler not implemented → Manual Only', () => {
    expect(formatAuthHealthCheckStatus('15m')).toEqual({
      configured: 'Every 15m',
      execution: 'Manual Only',
    })
    expect(formatAuthHealthCheckStatus('disabled')).toEqual({
      configured: 'Disabled',
      execution: 'Manual Only',
    })
  })
})

describe('dataFreshnessReason', () => {
  const now = Date.parse('2026-06-21T12:00:00Z')

  it('returns Never when no timestamp', () => {
    expect(dataFreshnessReason(null, now)).toBe('Never')
  })

  it('returns No Data (1h) after 1 hour', () => {
    const iso = new Date(now - 70 * 60_000).toISOString()
    expect(dataFreshnessReason(iso, now)).toBe('No Data (1h)')
  })
})
