import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'

function snapshot(
  eps1m: number,
  eps5m: number,
  healthStatus: 'HEALTHY' | 'DEGRADED' | 'IDLE' = 'HEALTHY',
  destinationWarning = false,
): OperationalSnapshotResponse {
  return {
    streams: [
      {
        enabled: true,
        health_status: healthStatus,
        eps_1m: eps1m,
        eps_5m: eps5m,
      },
    ],
    routes: [],
    destinations: [],
    problems: destinationWarning
      ? [{ scope: 'destination', severity: 'warning' }]
      : [],
  } as unknown as OperationalSnapshotResponse
}

describe('deriveGovernanceOperationalIssues', () => {
  it('does not classify generic degraded health as low volume', () => {
    const issues = deriveGovernanceOperationalIssues(snapshot(20, 20, 'DEGRADED'), null)
    expect(issues.lowVolumeStreams).toBe(0)
  })

  it('derives low volume only from observed EPS evidence', () => {
    const issues = deriveGovernanceOperationalIssues(snapshot(0.01, 0.01), null)
    expect(issues.lowVolumeStreams).toBe(1)
  })

  it('derives no-data and destination warning counts from the same snapshot', () => {
    const issues = deriveGovernanceOperationalIssues(snapshot(0, 0, 'IDLE', true), null)
    expect(issues.noDataStreams).toBe(1)
    expect(issues.destinationCapacityWarnings).toBe(1)
  })

  it('reports snapshot-derived evidence as unavailable without a snapshot', () => {
    const issues = deriveGovernanceOperationalIssues(null, null)
    expect(issues.noDataStreams).toBeNull()
    expect(issues.lowVolumeStreams).toBeNull()
    expect(issues.destinationCapacityWarnings).toBeNull()
  })
})
