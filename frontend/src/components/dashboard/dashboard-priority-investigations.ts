import type {
  OperationalHealthStatus,
  OperationalProblem,
  OperationalSnapshotResponse,
} from '../../api/operationalSnapshot'
import {
  connectorDetailPath,
  destinationDetailPath,
  logsExplorerPath,
  streamRuntimePath,
} from '../../config/nav-paths'

export type DashboardInvestigation = {
  key: string
  kind: 'Stream' | 'Route' | 'Destination'
  resource: string
  reason: string
  severity: 'critical' | 'warning'
  href: string
  /** Present for Source/auth failures: the Connector the failing Stream reads through. */
  connector?: { name: string; href: string | null }
}

const isValidId = (id: number | null | undefined): id is number =>
  typeof id === 'number' && Number.isSafeInteger(id) && id > 0

function issueReason(health: OperationalHealthStatus, problemTitle?: string): string {
  const reason = problemTitle?.trim()
  if (reason) return reason
  return health === 'ERROR' ? 'Health error reported' : 'Health degraded'
}

function isSourceProblem(problem: OperationalProblem | undefined): problem is OperationalProblem {
  const code = problem?.error_code
  return code === 'SOURCE_AUTH_FAILED' || code === 'SOURCE_FETCH_FAILED'
}

function sourceReason(problem: OperationalProblem): string {
  const status = typeof problem.http_status === 'number' ? ` (HTTP ${problem.http_status})` : ''
  if (problem.error_code === 'SOURCE_AUTH_FAILED') {
    return problem.http_status === 403
      ? `Source access denied${status}`
      : `Source authentication failed${status}`
  }
  return `Source fetch failing${status}`
}

function sourceConnector(problem: OperationalProblem): DashboardInvestigation['connector'] {
  const name = problem.connector_name?.trim()
  const id = problem.connector_id
  if (!name && !isValidId(id)) return undefined
  return {
    name: name || `Connector #${id}`,
    href: isValidId(id) ? connectorDetailPath(String(id)) : null,
  }
}

function needsAttention(health: OperationalHealthStatus, hasProblem: boolean): boolean {
  return health === 'ERROR' || health === 'DEGRADED' || hasProblem
}

/**
 * No extra API requests and no guessed link IDs: prioritize resources already identified
 * by the operational snapshot. An aggregate count alone is not an exact drill-down.
 */
export function dashboardPriorityInvestigations(
  snapshot: OperationalSnapshotResponse | null,
  limit = 3,
): DashboardInvestigation[] {
  if (!snapshot || limit <= 0) return []
  const problems = Array.isArray(snapshot.problems) ? snapshot.problems : []
  const result: DashboardInvestigation[] = []

  for (const stream of snapshot.streams ?? []) {
    if (!isValidId(stream.stream_id) || !stream.enabled) continue
    const streamProblems = problems.filter((p) => p.scope === 'stream' && p.stream_id === stream.stream_id)
    // A Source/auth failure names the cause and the Connector, so it leads over generic problems.
    const sourceProblem = streamProblems.find(isSourceProblem)
    const problem = sourceProblem ?? streamProblems[0]
    if (!needsAttention(stream.health_status, problem != null)) continue
    result.push({
      key: `stream-${stream.stream_id}`,
      kind: 'Stream',
      resource: stream.stream_name?.trim() || `Stream #${stream.stream_id}`,
      reason: sourceProblem ? sourceReason(sourceProblem) : issueReason(stream.health_status, problem?.title),
      ...(sourceProblem ? { connector: sourceConnector(sourceProblem) } : {}),
      severity: stream.health_status === 'ERROR' || problem?.severity === 'critical' ? 'critical' : 'warning',
      href: streamRuntimePath(String(stream.stream_id)),
    })
  }

  for (const route of snapshot.routes ?? []) {
    if (!isValidId(route.route_id) || !route.enabled) continue
    const problem = problems.find((p) => p.scope === 'route' && p.route_id === route.route_id)
    if (!needsAttention(route.health_status, problem != null)) continue
    const target = route.destination_name?.trim() || (
      isValidId(route.destination_id) ? `Destination #${route.destination_id}` : 'destination unknown'
    )
    result.push({
      key: `route-${route.route_id}`,
      kind: 'Route',
      resource: `Route #${route.route_id} → ${target}`,
      reason: issueReason(route.health_status, problem?.title),
      severity: route.health_status === 'ERROR' || problem?.severity === 'critical' ? 'critical' : 'warning',
      // Investigation is read-only, even for Viewers; configuration stays in the
      // Route editor. Scope only to real identifiers in the runtime snapshot.
      href: logsExplorerPath({
        route_id: route.route_id,
        stream_id: isValidId(route.stream_id) ? route.stream_id : undefined,
        destination_id: isValidId(route.destination_id) ? route.destination_id : undefined,
      }),
    })
  }

  for (const destination of snapshot.destinations ?? []) {
    if (!isValidId(destination.destination_id) || !destination.enabled) continue
    const problem = problems.find((p) => p.scope === 'destination' && p.destination_id === destination.destination_id)
    if (!needsAttention(destination.health_status, problem != null)) continue
    result.push({
      key: `destination-${destination.destination_id}`,
      kind: 'Destination',
      resource: destination.destination_name?.trim() || `Destination #${destination.destination_id}`,
      reason: issueReason(destination.health_status, problem?.title),
      severity: destination.health_status === 'ERROR' || problem?.severity === 'critical' ? 'critical' : 'warning',
      href: destinationDetailPath(String(destination.destination_id)),
    })
  }

  return result.sort((a, b) => {
    const severity = Number(b.severity === 'critical') - Number(a.severity === 'critical')
    return severity || a.key.localeCompare(b.key)
  }).slice(0, limit)
}
