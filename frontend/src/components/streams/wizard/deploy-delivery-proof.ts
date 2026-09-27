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
/** Non-send terminals that must keep the run from being proven. */
export const DELIVERY_BLOCKED_STAGES = new Set([
  'destination_rate_limited',
  'route_unknown_failure_policy',
  'dynamic_route_send_rate_limited',
  'dynamic_route_rate_limited',
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
  dynamicRouteId?: number | null
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
  dynamic_route_id?: number | null
  destination_id?: number | null
  destination_label?: string | null
  stage?: string | null
  skip_reason?: string | null
  created_at?: string | null
  sequence?: number | null
  scope?: DeliveryEvidenceScope | null
}

export type PriorDeliveryProof = {
  streamId: number
  runtimeRunId: string | null
  status: DeliveryProofStatus
}

export type RunDeliveryAggregates = {
  successCount?: number | null
  failureCount?: number | null
  blockedCount?: number | null
  reviewCount?: number | null
  quarantineCount?: number | null
  attemptCount?: number | null
}

export function deliveryEvidenceScope(stage: string): DeliveryEvidenceScope | null {
  if (stage.startsWith('failover_route_send_')) return 'failover'
  if (stage.startsWith('dynamic_route_')) return 'dynamic'
  if (
    DELIVERY_SUCCESS_STAGES.has(stage) ||
    DELIVERY_FAILURE_STAGES.has(stage) ||
    DELIVERY_BLOCKED_STAGES.has(stage)
  ) {
    return 'route'
  }
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
    } else if (DELIVERY_FAILURE_STAGES.has(stage) || DELIVERY_BLOCKED_STAGES.has(stage)) {
      terminal = row
      status = 'failed'
    } else if (stage === 'dynamic_route_send_skip' && (row.skip_reason ?? '').trim() === 'destination_disabled') {
      terminal = row
      status = 'failed'
    }
  }
  if (terminal == null || status == null) return null
  const scope = terminal.scope ?? deliveryEvidenceScope((terminal.stage ?? '').trim()) ?? 'route'
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
    routeId: scope === 'dynamic' ? null : (terminal.route_id ?? null),
    dynamicRouteId: scope === 'dynamic' ? (terminal.dynamic_route_id ?? null) : null,
    destinationId: terminal.destination_id ?? null,
    destinationLabel,
    scope,
    status,
    evidenceAt: terminal.created_at ?? null,
  }
}

/**
 * Prove delivery from exact-run evidence.
 * The last terminal stage per route wins for ordinary retries.
 * Run-summary failure, blocked, review, and quarantine counts override a contradictory last log line.
 * A prior unverified run does not make the next success "recovered".
 */
export function evaluateExactRunDelivery(input: {
  streamId?: number | null
  runtimeRunId: string | null | undefined
  commandAccepted: boolean
  evidence: DeliveryEvidenceRow[] | null
  prior?: PriorDeliveryProof | null
  aggregates?: RunDeliveryAggregates | null
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
    const scope = row.scope ?? deliveryEvidenceScope(stage)
    if (scope == null) continue
    const key = scope === 'dynamic' ? `dynamic:${row.dynamic_route_id ?? 'unknown'}` : `route:${row.route_id ?? 'none'}`
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

  const ambiguousRoutes = failoverFailedThenRetrySucceeded(input.evidence)
  const settledRoutes = routes.map((route) =>
    route.routeId != null && ambiguousRoutes.has(route.routeId) && route.scope !== 'dynamic'
      ? { ...route, status: 'failed' as const }
      : route,
  )
  const provenCount = settledRoutes.filter((route) => route.status === 'proven').length
  const failedCount = settledRoutes.filter((route) => route.status === 'failed').length
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

  const aggregateVerdict = reconcileAggregates(status, settledRoutes, input.aggregates)
  status = aggregateVerdict.status
  reason = aggregateVerdict.reason
  const dynamicIdentityMissing = input.evidence.some((row) => {
    const stage = (row.stage ?? '').trim()
    const scope = row.scope ?? deliveryEvidenceScope(stage)
    return scope === 'dynamic' && row.dynamic_route_id == null
  })
  if (dynamicIdentityMissing && (status === 'proven' || status === 'recovered')) {
    status = 'unverified'
    reason = 'Dynamic delivery evidence is missing route identity, so delivery is not proven.'
  }
  const skipVerdict = dynamicSkipVerdict(status, reason, settledRoutes, input.evidence)
  status = skipVerdict.status
  reason = skipVerdict.reason

  return { ...base, status, evidenceAt, routes: settledRoutes, reason }
}

function dynamicSkipVerdict(
  status: DeliveryProofStatus,
  reason: string,
  routes: RouteDeliveryProof[],
  evidence: DeliveryEvidenceRow[] | null,
): { status: DeliveryProofStatus; reason: string } {
  for (const row of evidence ?? []) {
    if ((row.stage ?? '').trim() !== 'dynamic_route_send_skip') continue
    const skipReason = (row.skip_reason ?? '').trim()
    if (skipReason === 'destination_disabled') continue
    if (skipReason === 'duplicate_base_destination') {
      const delivered = routes.some(
        (route) =>
          route.status === 'proven' &&
          route.scope !== 'dynamic' &&
          route.destinationId != null &&
          route.destinationId === (row.destination_id ?? null),
      )
      if (!delivered) {
        return {
          status: 'unverified',
          reason:
            'Dynamic skip duplicate_base_destination is not backed by exact-run base or failover delivery to that destination.',
        }
      }
      continue
    }
    return {
      status: 'unverified',
      reason: 'Dynamic skip reason is missing or not recognized, so delivery is not proven.',
    }
  }
  return { status, reason }
}

function failoverFailedThenRetrySucceeded(evidence: DeliveryEvidenceRow[] | null): Set<number> {
  const byRoute = new Map<number, DeliveryEvidenceRow[]>()
  for (const row of evidence ?? []) {
    if (row.route_id == null) continue
    const bucket = byRoute.get(row.route_id) ?? []
    bucket.push(row)
    byRoute.set(row.route_id, bucket)
  }
  const ambiguous = new Set<number>()
  for (const [routeId, bucket] of byRoute) {
    const ordered = [...bucket].sort((a, b) => {
      const byTime = (a.created_at ?? '').localeCompare(b.created_at ?? '')
      if (byTime !== 0) return byTime
      return (a.sequence ?? 0) - (b.sequence ?? 0)
    })
    let sawFailoverFailure = false
    for (const row of ordered) {
      const stage = (row.stage ?? '').trim()
      if (stage === 'failover_route_send_failed') sawFailoverFailure = true
      if (sawFailoverFailure && stage === 'route_retry_success') ambiguous.add(routeId)
    }
  }
  return ambiguous
}

function numericAggregate(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function reconcileAggregates(
  status: DeliveryProofStatus,
  routes: RouteDeliveryProof[],
  aggregates: RunDeliveryAggregates | null | undefined,
): { status: DeliveryProofStatus; reason: string } {
  const reasonFor = (next: DeliveryProofStatus, reason: string) => ({ status: next, reason })
  if (status !== 'proven' && status !== 'recovered') {
    return reasonFor(
      status,
      status === 'failed'
        ? 'Exact-run delivery evidence shows delivery failure.'
        : status === 'partial'
          ? 'Exact-run delivery evidence shows success on some routes and failure on others.'
          : status === 'unverified'
            ? 'Run Once was accepted, but delivery is not proven.'
            : 'Exact-run delivery evidence shows successful delivery.',
    )
  }
  const successReason =
    status === 'recovered'
      ? 'A later run delivered successfully after the previous run failed or only partially delivered.'
      : 'Exact-run delivery evidence shows successful delivery.'
  const successCount = numericAggregate(aggregates?.successCount)
  const failureCount = numericAggregate(aggregates?.failureCount)
  const blockedCount = numericAggregate(aggregates?.blockedCount)
  const reviewCount = numericAggregate(aggregates?.reviewCount)
  const quarantineCount = numericAggregate(aggregates?.quarantineCount)
  const attemptCount = numericAggregate(aggregates?.attemptCount)
  if (
    successCount == null ||
    failureCount == null ||
    blockedCount == null ||
    reviewCount == null ||
    quarantineCount == null ||
    attemptCount == null
  ) {
    return reasonFor(
      'unverified',
      'Run summary disposition counts are missing, so delivery is not proven.',
    )
  }
  const dispositionSum = successCount + failureCount + blockedCount + reviewCount + quarantineCount
  if (attemptCount !== dispositionSum) {
    return reasonFor(
      'unverified',
      'Run summary disposition counts do not reconcile, so delivery is not proven.',
    )
  }
  const baseProven = routes.filter((route) => route.scope !== 'dynamic' && route.status === 'proven').length
  const baseFailed = routes.filter((route) => route.scope !== 'dynamic' && route.status === 'failed').length
  const failureDispositions = failureCount + blockedCount + reviewCount + quarantineCount
  if (baseProven + baseFailed === 0) {
    if (successCount + failureDispositions > 0) {
      return reasonFor(
        'unverified',
        'Run summary counts do not match exact-run route evidence, so per-route delivery is not proven.',
      )
    }
    return reasonFor(status, successReason)
  }
  if (successCount !== baseProven || failureDispositions !== baseFailed) {
    return reasonFor(
      'unverified',
      'Run summary counts do not match exact-run route evidence, so per-route delivery is not proven.',
    )
  }
  if (failureCount > 0 && successCount === 0) {
    return reasonFor('failed', 'Run summary reports delivery failure, so the last log line does not prove delivery.')
  }
  if (failureCount > 0 || blockedCount > 0 || reviewCount > 0 || quarantineCount > 0) {
    return reasonFor(
      'partial',
      blockedCount + reviewCount + quarantineCount > 0 && baseFailed === 0
        ? 'Run summary reports blocked, review, or quarantine outcomes, but this trace does not identify that route, so delivery is not fully proven.'
        : 'Run summary reports incomplete delivery, so this run is not fully proven.',
    )
  }
  return reasonFor(status, successReason)
}

/** An unverified attempt must not erase an unresolved failed or partial recovery basis. */
export function nextDeliveryProofPrior(
  streamId: number,
  prior: PriorDeliveryProof | null,
  proof: ExactRunDeliveryProof,
): PriorDeliveryProof {
  const unresolved =
    prior != null && prior.streamId === streamId && (prior.status === 'failed' || prior.status === 'partial')
  if (proof.status === 'unverified' && unresolved && prior) return prior
  if (proof.status === 'proven' || proof.status === 'recovered') {
    return { streamId, runtimeRunId: proof.runtimeRunId, status: 'proven' }
  }
  return { streamId, runtimeRunId: proof.runtimeRunId, status: proof.status }
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
