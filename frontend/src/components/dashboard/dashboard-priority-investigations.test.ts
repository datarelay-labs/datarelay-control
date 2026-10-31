import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { dashboardPriorityInvestigations } from './dashboard-priority-investigations'

function snapshot(patch: Partial<OperationalSnapshotResponse>): OperationalSnapshotResponse {
  return {
    global: {} as OperationalSnapshotResponse['global'],
    streams: [], routes: [], destinations: [], problems: [], updated_at: '2026-10-09T00:00:00Z',
    ...patch,
  }
}

describe('Dashboard priority investigations', () => {
  it('uses real resource IDs, prioritizes errors, and never displays raw error text', () => {
    const input = snapshot({
      streams: [
        {
          stream_id: 1, stream_name: 'Payment API Stream', enabled: true,
          health_status: 'ERROR', last_error_message: 'Bearer secret do not display',
        } as OperationalSnapshotResponse['streams'][number],
        {
          stream_id: 2, stream_name: 'Healthy Stream', enabled: true, health_status: 'HEALTHY',
        } as OperationalSnapshotResponse['streams'][number],
      ],
      destinations: [{
        destination_id: 9, destination_name: 'Splunk Receiver', enabled: true, health_status: 'DEGRADED',
      } as OperationalSnapshotResponse['destinations'][number]],
      problems: [{
        scope: 'destination', destination_id: 9, severity: 'warning',
        title: 'Endpoint unavailable',
      } as OperationalSnapshotResponse['problems'][number]],
    })
    const result = dashboardPriorityInvestigations(input)
    expect(result.map((row) => row.key)).toEqual(['stream-1', 'destination-9'])
    expect(result[0]).toMatchObject({ href: '/streams/1/runtime', resource: 'Payment API Stream', severity: 'critical' })
    expect(result[1]).toMatchObject({ href: '/destinations/9', reason: 'Endpoint unavailable', severity: 'warning' })
    expect(JSON.stringify(result)).not.toContain('Bearer secret')
  })

  it('avoids fake deep links, idle or disabled warnings, and retains Route identity', () => {
    const input = snapshot({
      streams: [
        { stream_id: -1, stream_name: 'Invalid', enabled: true, health_status: 'ERROR' },
        { stream_id: 4, stream_name: 'Idle', enabled: true, health_status: 'IDLE' },
        { stream_id: 5, stream_name: 'Disabled', enabled: false, health_status: 'ERROR' },
      ] as OperationalSnapshotResponse['streams'],
      routes: [{
        route_id: 12, enabled: true, health_status: 'DEGRADED',
        destination_id: 6, destination_name: 'External SIEM',
      } as OperationalSnapshotResponse['routes'][number]],
      destinations: [{
        destination_id: Number.NaN, destination_name: 'Bad', enabled: true, health_status: 'ERROR',
      } as OperationalSnapshotResponse['destinations'][number]],
    })
    expect(dashboardPriorityInvestigations(input)).toEqual([{
      key: 'route-12', kind: 'Route', resource: 'Route #12 → External SIEM',
      reason: 'Health degraded', severity: 'warning', href: '/logs?route_id=12&destination_id=6',
    }])
    expect(dashboardPriorityInvestigations(input, 0)).toEqual([])
    expect(dashboardPriorityInvestigations(null)).toEqual([])
  })

  it('takes failed Route operator cards to read-only scoped delivery evidence, not configuration', () => {
    const s = snapshot({
      routes: [{
        route_id: 42, stream_id: 2, destination_id: 10,
        destination_name: 'Finance sink', enabled: true, health_status: 'ERROR',
        failed_eps_1m: 0,
      } as OperationalSnapshotResponse['routes'][number]],
    })
    const [route] = dashboardPriorityInvestigations(s)
    expect(route).toMatchObject({
      key: 'route-42', severity: 'critical',
      href: '/logs?route_id=42&stream_id=2&destination_id=10',
    })
    expect(route?.href).not.toContain('/edit')
    expect(route?.href).not.toContain('status=failed')
  })

  it('preserves route ID but omits invalid Stream and Destination scopes rather than guessing telemetry', () => {
    const s = snapshot({
      routes: [{
        route_id: 91, stream_id: -1, destination_id: Number.NaN,
        destination_name: '', enabled: true, health_status: 'DEGRADED',
      } as OperationalSnapshotResponse['routes'][number]],
    })
    const [route] = dashboardPriorityInvestigations(s)
    expect(route?.href).toBe('/logs?route_id=91')
    expect(route?.resource).toBe('Route #91 → destination unknown')
  })

  it('bounds cards to three and shows explicit critical problems above warnings', () => {
    const input = snapshot({
      destinations: [1, 2, 3, 4].map((id) => ({
        destination_id: id, destination_name: `Sink ${id}`, enabled: true,
        health_status: 'DEGRADED',
      })) as OperationalSnapshotResponse['destinations'],
      problems: [{
        scope: 'destination', destination_id: 4, severity: 'critical', title: 'Connection failed',
      } as OperationalSnapshotResponse['problems'][number]],
    })
    const result = dashboardPriorityInvestigations(input)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ key: 'destination-4', severity: 'critical' })
  })
  describe('Source/auth failure (F-015)', () => {
    const sourceSnapshot = (patch: Partial<OperationalSnapshotResponse['problems'][number]> = {}) =>
      snapshot({
        streams: [{
          stream_id: 7, stream_name: 'Okta Events', enabled: true, health_status: 'HEALTHY', connector_id: 12,
        } as OperationalSnapshotResponse['streams'][number]],
        problems: [{
          scope: 'stream', stream_id: 7, severity: 'critical',
          title: 'Stream Okta Events: source authentication failed (HTTP 401)',
          message: 'The latest source request through Connector Okta Prod failed with HTTP 401.',
          error_code: 'SOURCE_AUTH_FAILED', http_status: 401, connector_id: 12, connector_name: 'Okta Prod',
          ...patch,
        } as OperationalSnapshotResponse['problems'][number]],
      })

    it('surfaces a 401 on an otherwise HEALTHY Stream, naming Stream and Connector with deep links', () => {
      const [item] = dashboardPriorityInvestigations(sourceSnapshot())
      expect(item).toMatchObject({
        key: 'stream-7',
        resource: 'Okta Events',
        severity: 'critical',
        reason: 'Source authentication failed (HTTP 401)',
        href: '/streams/7/runtime',
        connector: { name: 'Okta Prod', href: '/connectors/12' },
      })
    })

    it('words a 403 as access denied and a non-auth failure as a fetch failure', () => {
      expect(dashboardPriorityInvestigations(sourceSnapshot({ http_status: 403 }))[0].reason)
        .toBe('Source access denied (HTTP 403)')
      expect(
        dashboardPriorityInvestigations(
          sourceSnapshot({ error_code: 'SOURCE_FETCH_FAILED', http_status: 502 }),
        )[0].reason,
      ).toBe('Source fetch failing (HTTP 502)')
    })

    it('falls back to the connector id when the name is unavailable and never invents a link', () => {
      const [withId] = dashboardPriorityInvestigations(sourceSnapshot({ connector_name: null }))
      expect(withId.connector).toEqual({ name: 'Connector #12', href: '/connectors/12' })
      const [none] = dashboardPriorityInvestigations(
        sourceSnapshot({ connector_name: null, connector_id: null }),
      )
      expect(none.connector).toBeUndefined()
    })

    it('leads with the source problem over a generic one and does not leak the message text', () => {
      const input = sourceSnapshot()
      input.problems.unshift({
        scope: 'stream', stream_id: 7, severity: 'warning', title: 'Generic slowdown', message: 'm',
        last_seen_at: null, route_id: null, destination_id: null,
      })
      const [item] = dashboardPriorityInvestigations(input)
      expect(item.reason).toBe('Source authentication failed (HTTP 401)')
      expect(item.severity).toBe('critical')
    })

    it('adds no Connector context for non-source problems', () => {
      const [item] = dashboardPriorityInvestigations(snapshot({
        streams: [{
          stream_id: 3, stream_name: 'S', enabled: true, health_status: 'ERROR',
        } as OperationalSnapshotResponse['streams'][number]],
      }))
      expect(item.connector).toBeUndefined()
    })
  })
})
