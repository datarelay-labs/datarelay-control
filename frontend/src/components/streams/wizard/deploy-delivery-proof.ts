export const DELIVERY_SUCCESS_STAGES = new Set([
  'route_send_success',
  'route_retry_success',
  'dynamic_route_send_success',
  'failover_route_send_success',
])
export const DELIVERY_FAILURE_STAGES = new Set([
  'route_send_failed',
  'route_retry_failed',
  'dynamic_route_send_failed',
  'failover_route_send_failed',
])

export type DeliveryProofStatus = 'proven' | 'unverified' | 'failed' | 'partial' | 'recovered'
export type DeliveryEvidenceScope = 'route' | 'dynamic' | 'failover'

export function deliveryProofStatusLabel(status: DeliveryProofStatus): string {
  switch (status) {
    case 'proven':
      return 'Delivery proven'
    case 'unverified':
      return 'Delivery unverified'
    case 'failed':
      return 'Delivery failed'
    case 'partial':
      return 'Partial delivery'
    case 'recovered':
      return 'Delivery recovered'
  }
}

export type RouteDeliveryProof = {
  routeId: number | null
  destinationId: number | null
  destinationLabel: string
  scope: DeliveryEvidenceScope
  status: 'proven' | 'failed'
  evidenceAt: string | null
}

export type ExactRunDeliveryProof = {
  status: DeliveryProofStatus
  streamId: number | null
  runtimeRunId: string | null
  commandAccepted: boolean
  evidenceAt: string | null
  routes: RouteDeliveryProof[]
  reason: string
}

/** Timeline rows are already scoped to one run. They do not carry run_id. */
export type DeliveryEvidenceRow = {
  route_id?: number | null
  destination_id?: number | null
  destination_label?: string | null
  stage?: string | null
  created_at?: string | null
  sequence?: number | null
  scope?: DeliveryEvidenceScope | null
}

export type PriorDeliveryProof = {
  streamId: number
  runtimeRunId: string | null
  status: DeliveryProofStatus
}

function stageScope(stage: string): DeliveryEvidenceScope | null {
  if (stage.startsWith('failover_route_send_')) return 'failover'
  if (stage.startsWith('dynamic_route_send_')) return 'dynamic'
  if (DELIVERY_SUCCESS_STAGES.has(stage) || DELIVERY_FAILURE_STAGES.has(stage)) return 'route'
  return null
}

function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const stamps = values.filter((value): value is string => Boolean(value && value.trim()))
  if (stamps.length === 0) return null
  return stamps.sort().at(-1) ?? null
}

function terminalRouteProof(bucket: DeliveryEvidenceRow[]): RouteDeliveryProof | null {
  const ordered = [...bucket].sort((a, b) => {
    const byTime = (a.created_at ?? '').localeCompare(b.created_at ?? '')
    if (byTime !== 0) return byTime
    return (a.sequence ?? 0) - (b.sequence ?? 0)
  })
  let terminal: DeliveryEvidenceRow | null = null
  let status: 'proven' | 'failed' | null = null
  for (const row of ordered) {
    const stage = (row.stage ?? '').trim()
    if (DELIVERY_SUCCESS_STAGES.has(stage)) {
      terminal = row
      status = 'proven'
    } else if (DELIVERY_FAILURE_STAGES.has(stage)) {
      terminal = row
      status = 'failed'
    }
  }
  if (terminal == null || status == null) return null
  const scope = terminal.scope ?? stageScope((terminal.stage ?? '').trim()) ?? 'route'
  const destinationLabel =
    terminal.destination_label?.trim() ||
    (scope === 'failover'
      ? 'secondary destination unknown'
      : scope === 'dynamic'
        ? 'dynamic target'
        : terminal.destination_id == null
          ? 'destination unavailable'
          : `destination ${terminal.destination_id}`)
  return {
    routeId: terminal.route_id ?? null,
    destinationId: terminal.destination_id ?? null,
    destinationLabel,
    scope,
    status,
    evidenceAt: terminal.created_at ?? null,
  }
}

/**
 * Prove delivery from exact-run evidence only.
 * The last terminal stage per route wins, so a later retry success overrides an earlier send failure.
 * Aggregate counts are not proof. A prior unverified run does not make the next success "recovered".
 */
export function evaluateExactRunDelivery(input: {
  streamId?: number | null
  runtimeRunId: string | null | undefined
  commandAccepted: boolean
  evidence: DeliveryEvidenceRow[] | null
  prior?: PriorDeliveryProof | null
}): ExactRunDeliveryProof {
  const runtimeRunId = input.runtimeRunId?.trim() || null
  const streamId = input.streamId ?? null
  const base = {
    streamId,
    runtimeRunId,
    commandAccepted: input.commandAccepted,
    evidenceAt: null,
    routes: [] as RouteDeliveryProof[],
  }
  if (!input.commandAccepted || runtimeRunId == null) {
    return {
      ...base,
      status: 'unverified',
      reason: 'Run Once did not return an exact runtime run id, so delivery is not proven.',
    }
  }
  if (input.evidence == null) {
    return {
      ...base,
      status: 'unverified',
      reason: 'Exact-run delivery evidence could not be loaded, so delivery is not proven.',
    }
  }

  const byRoute = new Map<string, DeliveryEvidenceRow[]>()
  for (const row of input.evidence) {
    const stage = (row.stage ?? '').trim()
    const scope = row.scope ?? stageScope(stage)
    if (scope == null) continue
    const key = scope === 'dynamic' ? `dynamic:${row.destination_id ?? 'unknown'}` : `route:${row.route_id ?? 'none'}`
    const bucket = byRoute.get(key) ?? []
    bucket.push({ ...row, scope })
    byRoute.set(key, bucket)
  }

  const routes = [...byRoute.values()]
    .map((bucket) => terminalRouteProof(bucket))
    .filter((route): route is RouteDeliveryProof => route != null)
    .sort((a, b) => (a.routeId ?? 0) - (b.routeId ?? 0) || a.destinationLabel.localeCompare(b.destinationLabel))
  const evidenceAt = latestTimestamp(routes.map((route) => route.evidenceAt))

  if (routes.length === 0) {
    return {
      ...base,
      status: 'unverified',
      reason: 'Run Once was accepted, but this run has no delivery success or failure evidence.',
    }
  }

  const provenCount = routes.filter((route) => route.status === 'proven').length
  const failedCount = routes.filter((route) => route.status === 'failed').length
  let status: DeliveryProofStatus
  let reason: string
  if (provenCount > 0 && failedCount === 0) {
    const prior = input.prior
    const sameStream = streamId != null && prior?.streamId === streamId
    const recoveredFrom =
      sameStream &&
      prior.runtimeRunId !== runtimeRunId &&
      (prior.status === 'failed' || prior.status === 'partial')
    status = recoveredFrom ? 'recovered' : 'proven'
    reason = recoveredFrom
      ? 'A later run delivered successfully after the previous run failed or only partially delivered.'
      : 'Exact-run delivery evidence shows successful delivery.'
  } else if (failedCount > 0 && provenCount === 0) {
    status = 'failed'
    reason = 'Exact-run delivery evidence shows delivery failure.'
  } else {
    status = 'partial'
    reason = 'Exact-run delivery evidence shows success on some routes and failure on others.'
  }

  return { ...base, status, evidenceAt, routes, reason }
}

export function deliveryProofLines(proof: ExactRunDeliveryProof): string[] {
  return [
    deliveryProofStatusLabel(proof.status),
    proof.reason,
    `Run id: ${proof.runtimeRunId ?? '—'}`,
    `Evidence: ${proof.evidenceAt ?? 'none'}`,
    ...proof.routes.map(
      (route) =>
        `${route.scope === 'dynamic' ? 'Dynamic target' : `Route ${route.routeId ?? '—'}`} · ${route.destinationLabel} · ${route.status}`,
    ),
  ]
}
