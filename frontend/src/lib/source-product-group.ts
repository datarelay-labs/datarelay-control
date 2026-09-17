/**
 * M31.1 — Source Product Group labels: prefer connector.product_group, heuristic fallback.
 */

import type { StreamConsoleRow } from '../api/streamRows'
import { computeGroupOperationalStats } from './stream-console-metrics'
import {
  countOperationalIssues,
  effectiveStreamSeverity,
  normalizeSeverityInput,
  severityToRuntimeStatus,
  worstOperationalSeverity,
  type StreamOperationalSeverity,
} from './stream-operational-status'

const PRODUCT_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['crowdstrike', 'CrowdStrike'],
  ['falcon', 'CrowdStrike'],
  ['okta', 'Okta'],
  ['microsoft 365', 'Microsoft 365'],
  ['office365', 'Microsoft 365'],
  ['m365', 'Microsoft 365'],
  ['azure', 'Microsoft Azure'],
  ['aws', 'Amazon Web Services'],
  ['amazon s3', 'Amazon S3'],
  ['splunk', 'Splunk'],
  ['sentinel', 'Microsoft Sentinel'],
  ['palo alto', 'Palo Alto Networks'],
  ['google', 'Google Cloud'],
  ['gcp', 'Google Cloud'],
  ['datadog', 'Datadog'],
  ['elastic', 'Elastic'],
  ['proofpoint', 'Proofpoint'],
  ['zscaler', 'Zscaler'],
  ['carbon black', 'VMware Carbon Black'],
]

export const SOURCE_PRODUCT_OTHER = 'Other sources' as const

/** Optional connector metadata — populated when API exposes `product_group` (no backend change required to read). */
export type SourceProductMetadata = {
  product_group?: string | null
  name?: string | null
}

/** Derive operator-facing product label from connector metadata or naming heuristic. */
export function resolveSourceProductLabel(
  connectorName: string | null | undefined,
  metadata?: SourceProductMetadata | null,
): string {
  const fromApi = metadata?.product_group?.trim()
  if (fromApi) return fromApi
  const raw = String(connectorName ?? metadata?.name ?? '').trim()
  if (!raw) return SOURCE_PRODUCT_OTHER
  const lower = raw.toLowerCase()
  for (const [needle, label] of PRODUCT_ALIASES) {
    if (lower.includes(needle)) return label
  }
  return raw
}

export type StreamRuntimeStatus = 'RUNNING' | 'DEGRADED' | 'ERROR' | 'STOPPED' | 'IDLE' | 'UNKNOWN'

const STATUS_RANK: Record<StreamRuntimeStatus, number> = {
  ERROR: 4,
  DEGRADED: 3,
  RUNNING: 2,
  STOPPED: 1,
  IDLE: 1,
  UNKNOWN: 0,
}

export function worstStreamStatus(statuses: readonly StreamRuntimeStatus[]): StreamRuntimeStatus {
  let worst: StreamRuntimeStatus = 'UNKNOWN'
  let rank = -1
  for (const s of statuses) {
    const r = STATUS_RANK[s] ?? 0
    if (r > rank) {
      rank = r
      worst = s
    }
  }
  return worst
}

export function countStreamIssues(statuses: readonly StreamRuntimeStatus[]): number {
  return statuses.filter((s) => s === 'ERROR' || s === 'DEGRADED').length
}

/** Issue count using delivery paths and success rate — aligns with operator severity. */
export function countStreamRowIssues(
  rows: readonly { status: StreamRuntimeStatus; routesError?: number; routesDegraded?: number; deliveryPctKnown?: boolean; deliveryPct?: number }[],
): number {
  return countOperationalIssues(rows)
}

export function worstStreamRowStatus(
  rows: readonly { status: StreamRuntimeStatus; routesError?: number; routesDegraded?: number; deliveryPctKnown?: boolean; deliveryPct?: number }[],
): StreamRuntimeStatus {
  const severities = rows.map((r) => effectiveStreamSeverity(normalizeSeverityInput(r)))
  return severityToRuntimeStatus(worstOperationalSeverity(severities))
}

export type ProductStreamGroup<T> = {
  productLabel: string
  rows: T[]
  /** Worst backend-mapped status — kept for legacy callers. */
  worstStatus: StreamRuntimeStatus
  /** Worst operational severity across member streams (inheritance). */
  operationalSeverity: StreamOperationalSeverity
  issueCount: number
  criticalCount: number
  warningCount: number
  stoppedCount: number
  totalEvents: number
}

export function groupRowsBySourceProduct<
  T extends { connectorName: string; connectorProductGroup?: string | null; status: StreamRuntimeStatus },
>(rows: readonly T[]): ProductStreamGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const label = resolveSourceProductLabel(row.connectorName, { product_group: row.connectorProductGroup })
    const list = buckets.get(label) ?? []
    list.push(row)
    buckets.set(label, list)
  }
  const out: ProductStreamGroup<T>[] = []
  for (const [productLabel, groupRows] of buckets) {
    const stats = computeGroupOperationalStats(groupRows as unknown as StreamConsoleRow[])
    out.push({
      productLabel,
      rows: groupRows,
      worstStatus: stats.worstStatus,
      operationalSeverity: stats.operationalSeverity,
      issueCount: stats.issueCount,
      criticalCount: stats.criticalCount,
      warningCount: stats.warningCount,
      stoppedCount: stats.stoppedCount,
      totalEvents: stats.totalEvents,
    })
  }
  return out
}
