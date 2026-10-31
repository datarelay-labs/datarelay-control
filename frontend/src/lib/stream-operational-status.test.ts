import { describe, expect, it } from 'vitest'
import {
  countOperationalIssues,
  effectiveStreamSeverity,
  normalizeSeverityInput,
  worstOperationalSeverity,
} from './stream-operational-status'

describe('stream-operational-status', () => {
  it('flags routesError as warning even when status is RUNNING', () => {
    expect(
      effectiveStreamSeverity({
        status: 'RUNNING',
        routesError: 1,
        deliveryPctKnown: true,
        deliveryPct: 99,
      }),
    ).toBe('warning')
  })

  it('treats idle route counts as healthy when delivery success is strong', () => {
    expect(
      effectiveStreamSeverity({
        status: 'RUNNING',
        routesDegraded: 2,
        routesError: 0,
        deliveryPctKnown: true,
        deliveryPct: 100,
      }),
    ).toBe('healthy')
  })

  it('counts operational issues across rows', () => {
    const count = countOperationalIssues([
      { status: 'RUNNING', routesError: 0, deliveryPctKnown: true, deliveryPct: 99 },
      { status: 'DEGRADED', routesError: 0, deliveryPctKnown: true, deliveryPct: 80 },
      { status: 'ERROR', routesError: 2, deliveryPctKnown: true, deliveryPct: 50 },
    ])
    expect(count).toBe(2)
  })

  it('picks critical over warning for group worst', () => {
    expect(worstOperationalSeverity(['healthy', 'warning', 'critical'])).toBe('critical')
  })

  it('RUNNING with snapshot IDLE (not observed yet) is unknown, not healthy (scenario 2)', () => {
    expect(
      effectiveStreamSeverity({
        status: 'RUNNING',
        routesError: 0,
        deliveryPctKnown: false,
        deliveryPct: 0,
        operationalHealthStatus: 'IDLE',
        hasRuntimeApiSnapshot: true,
      }),
    ).toBe('unknown')
  })

  it('RUNNING or UNKNOWN with no runtime snapshot and no known delivery is unknown (scenario 1)', () => {
    for (const status of ['RUNNING', 'UNKNOWN'] as const) {
      expect(
        effectiveStreamSeverity({
          status,
          routesError: 0,
          deliveryPctKnown: false,
          deliveryPct: 0,
          hasRuntimeApiSnapshot: false,
        }),
      ).toBe('unknown')
    }
  })

  it('does not assume 100% delivery when the percentage is missing', () => {
    expect(countOperationalIssues([{ status: 'RUNNING', deliveryPctKnown: true }])).toBe(0)
    expect(effectiveStreamSeverity(normalizeSeverityInput({ status: 'RUNNING', deliveryPctKnown: true }))).toBe('unknown')
  })

  it('ranks unknown above stopped/healthy and below warning/critical (scenario 12)', () => {
    expect(worstOperationalSeverity(['healthy', 'unknown'])).toBe('unknown')
    expect(worstOperationalSeverity(['stopped', 'unknown'])).toBe('unknown')
    expect(worstOperationalSeverity(['unknown', 'warning'])).toBe('warning')
    expect(worstOperationalSeverity(['unknown', 'critical'])).toBe('critical')
  })
})
