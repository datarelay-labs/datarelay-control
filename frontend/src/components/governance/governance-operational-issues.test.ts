import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { HealthOverviewResponse } from '../../api/types/gdcApi'
import { deriveGovernanceOperationalIssues } from './governance-operational-issues'

function snapshot(eps1m: number, eps5m: number): OperationalSnapshotResponse {
  return {
    streams: [
      {
        enabled: true,
        eps_1m: eps1m,
        eps_5m: eps5m,
      },
    ],
    routes: [],
    destinations: [],
    problems: [],
  } as unknown as OperationalSnapshotResponse
}

const degradedHealth = {
  streams: { degraded: 4 },
} as unknown as HealthOverviewResponse

describe('deriveGovernanceOperationalIssues', () => {
  it('does not classify generic degraded health as low volume', () => {
    const issues = deriveGovernanceOperationalIssues(degradedHealth, null, snapshot(20, 20))
    expect(issues.lowVolumeStreams).toBe(0)
  })

  it('derives low volume only from observed EPS evidence', () => {
    const issues = deriveGovernanceOperationalIssues(degradedHealth, null, snapshot(0.01, 0.01))
    expect(issues.lowVolumeStreams).toBe(1)
  })

  it('reports low-volume evidence as unavailable without an operational snapshot', () => {
    const issues = deriveGovernanceOperationalIssues(degradedHealth, null, null)
    expect(issues.lowVolumeStreams).toBeNull()
  })
})
