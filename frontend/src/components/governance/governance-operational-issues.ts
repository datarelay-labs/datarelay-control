import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import type { DashboardSummaryResponse } from '../../api/types/gdcApi'
import { isLowVolumeEps } from '../../lib/low-volume-signal'

export type GovernanceOperationalIssueCounts = {
  /** null = authoritative operational snapshot unavailable. */
  noDataStreams: number | null
  /** null = authoritative operational snapshot unavailable. */
  lowVolumeStreams: number | null
  /** null = API data unavailable (not the same as 0 drift alerts). */
  schemaDriftCount: number | null
  /** null = authoritative operational snapshot unavailable. */
  destinationCapacityWarnings: number | null
}

function safeNonNeg(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

/** Lightweight subset of dashboard operational issue derivation for Governance Overview. */
export function deriveGovernanceOperationalIssues(
  snapshot: OperationalSnapshotResponse | null,
  dashboard: DashboardSummaryResponse | null,
): GovernanceOperationalIssueCounts {
  const noDataStreams =
    snapshot == null
      ? null
      : snapshot.streams.filter((stream) => stream.enabled && stream.health_status === 'IDLE').length

  const lowVolumeStreams =
    snapshot == null
      ? null
      : snapshot.streams.filter(
          (stream) => stream.enabled && isLowVolumeEps(stream.eps_1m, stream.eps_5m),
        ).length

  const destinationCapacityWarnings =
    snapshot == null
      ? null
      : snapshot.problems.filter(
          (problem) => problem.scope === 'destination' && problem.severity === 'warning',
        ).length

  // Explicit OPEN StreamSchemaFieldDrift aggregate from dashboard/summary.
  // If that field is absent (API failed or unavailable) return null, not 0.
  const schemaDriftCount =
    dashboard?.open_schema_field_drift_count != null
      ? safeNonNeg(dashboard.open_schema_field_drift_count)
      : null

  return {
    noDataStreams,
    lowVolumeStreams,
    schemaDriftCount,
    destinationCapacityWarnings,
  }
}
