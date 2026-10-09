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
      reason: 'Health degraded', severity: 'warning', href: '/routes/12/edit',
    }])
    expect(dashboardPriorityInvestigations(input, 0)).toEqual([])
    expect(dashboardPriorityInvestigations(null)).toEqual([])
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
})
