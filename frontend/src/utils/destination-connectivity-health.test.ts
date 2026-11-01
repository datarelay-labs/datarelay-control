import { describe, expect, it } from 'vitest'
import {
  isDestinationConnectivityVerified,
  resolveDestinationListUiHealth,
} from './destination-connectivity-health'

describe('destination-connectivity-health', () => {
  it('treats explicit connectivity success as verified', () => {
    expect(
      isDestinationConnectivityVerified({
        last_connectivity_test_success: true,
        last_connectivity_test_at: '2026-06-23T10:00:00Z',
      }),
    ).toBe(true)
  })

  it('treats failed connectivity as not verified', () => {
    expect(
      isDestinationConnectivityVerified({
        last_connectivity_test_success: false,
        last_connectivity_test_at: '2026-06-23T10:00:00Z',
      }),
    ).toBe(false)
  })

  const PROBE_OK = {
    enabled: true,
    last_connectivity_test_success: true,
    last_connectivity_test_at: '2026-06-23T10:00:00Z',
  }
  const snapshot = (overrides: Record<string, unknown> = {}) =>
    ({
      destination_id: 1,
      destination_name: 'MDS',
      destination_type: 'SYSLOG_TCP',
      enabled: true,
      health_status: 'ERROR',
      inbound_eps_1m: 0,
      failed_eps_1m: 0,
      avg_latency_ms: null,
      route_count: 1,
      last_success_at: null,
      last_error_at: null,
      last_error_message: null,
      ...overrides,
    }) as Parameters<typeof resolveDestinationListUiHealth>[1]

  it('never masks a snapshot ERROR with a passing probe (Unknown/Healthy must not hide Critical)', () => {
    expect(resolveDestinationListUiHealth(PROBE_OK, snapshot(), 'Critical')).toBe('Critical')
    expect(resolveDestinationListUiHealth(PROBE_OK, snapshot({ health_status: 'ERROR' }), undefined)).toBe('Critical')
  })

  it('never masks a snapshot DEGRADED with a passing probe', () => {
    expect(resolveDestinationListUiHealth(PROBE_OK, snapshot({ health_status: 'DEGRADED' }), 'Warning')).toBe('Warning')
    expect(resolveDestinationListUiHealth(PROBE_OK, snapshot({ health_status: 'DEGRADED' }), undefined)).toBe('Warning')
  })

  it('reads probe-only destinations as Connectivity verified - No deliveries observed, not Healthy', () => {
    const label = 'Connectivity verified · No deliveries observed'
    expect(
      resolveDestinationListUiHealth(PROBE_OK, snapshot({ health_status: 'IDLE' }), 'No Data'),
    ).toBe(label)
    expect(resolveDestinationListUiHealth(PROBE_OK, null, undefined)).toBe(label)
    expect(resolveDestinationListUiHealth(PROBE_OK, undefined, undefined)).not.toBe('Healthy')
  })

  it('keeps Healthy only when the snapshot reports an observed delivery', () => {
    expect(
      resolveDestinationListUiHealth(
        PROBE_OK,
        snapshot({ health_status: 'HEALTHY', inbound_eps_1m: 2, last_success_at: '2026-06-23T10:00:00Z' }),
        'Healthy',
      ),
    ).toBe('Healthy')
  })

  it('keeps disabled and untested idle destinations unchanged', () => {
    expect(resolveDestinationListUiHealth({ ...PROBE_OK, enabled: false }, null, undefined)).toBe('Disabled')
    expect(
      resolveDestinationListUiHealth(
        { enabled: true, last_connectivity_test_success: null, last_connectivity_test_at: null },
        null,
        undefined,
      ),
    ).toBe('Idle')
  })
})
