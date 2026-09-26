import { describe, expect, it } from 'vitest'
import { evaluateExactRunDelivery, nextDeliveryProofPrior, type DeliveryEvidenceRow } from './deploy-delivery-proof'

function row(partial: DeliveryEvidenceRow): DeliveryEvidenceRow {
  return partial
}

function counts(success: number, failure = 0, blocked = 0) {
  return {
    successCount: success,
    failureCount: failure,
    blockedCount: blocked,
    reviewCount: 0,
    quarantineCount: 0,
    attemptCount: success + failure + blocked,
  }
}

describe('evaluateExactRunDelivery', () => {
  it('treats an exact-run success as proven', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-new',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 })],
      aggregates: counts(1),
    })
    expect(proof.status).toBe('proven')
    expect(proof.evidenceAt).toBe('2026-09-26T01:00:00Z')
    expect(proof.routes[0]).toMatchObject({ routeId: 7, destinationId: 11, status: 'proven' })
  })

  it('lets a later retry success override an earlier send failure', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-new',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_failed', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({ route_id: 7, destination_id: 11, stage: 'route_retry_success', created_at: '2026-09-26T01:01:00Z', sequence: 2 }),
      ],
      aggregates: counts(1),
    })
    expect(proof.status).toBe('proven')
    expect(proof.routes).toHaveLength(1)
  })

  it('stays failed when retry also fails', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-new',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_failed', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({ route_id: 7, destination_id: 11, stage: 'route_retry_failed', created_at: '2026-09-26T01:02:00Z', sequence: 2 }),
      ],
    })
    expect(proof.status).toBe('failed')
  })

  it('proves dynamic and failover success and keeps failover failure failed', () => {
    const dynamic = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-d',
      commandAccepted: true,
      evidence: [
        row({
          destination_id: 90,
          destination_label: 'dynamic target',
          dynamic_route_id: 3,
          stage: 'dynamic_route_send_success',
          created_at: '2026-09-26T01:00:00Z',
          scope: 'dynamic',
        }),
      ],
      aggregates: counts(0),
    })
    expect(dynamic.status).toBe('proven')
    expect(dynamic.routes[0]?.destinationLabel).toBe('dynamic target')
    const dynamicFailed = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-df',
      commandAccepted: true,
      evidence: [
        row({
          destination_id: 90,
          destination_label: 'dynamic target',
          dynamic_route_id: 3,
          stage: 'dynamic_route_send_failed',
          created_at: '2026-09-26T01:00:00Z',
          scope: 'dynamic',
        }),
      ],
    })
    expect(dynamicFailed.status).toBe('failed')

    const failover = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-f',
      commandAccepted: true,
      evidence: [
        row({
          route_id: 7,
          destination_id: 11,
          destination_label: 'destination 11',
          stage: 'route_send_failed',
          created_at: '2026-09-26T01:00:00Z',
          sequence: 1,
          scope: 'route',
        }),
        row({
          route_id: 7,
          destination_id: 22,
          destination_label: 'Secondary',
          stage: 'failover_route_send_success',
          created_at: '2026-09-26T01:01:00Z',
          sequence: 2,
          scope: 'failover',
        }),
      ],
      aggregates: counts(1),
    })
    expect(failover.status).toBe('proven')
    expect(failover.routes).toHaveLength(1)
    expect(failover.routes[0]).toMatchObject({ destinationId: 22, destinationLabel: 'Secondary', status: 'proven' })

    const failoverFailed = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-ff',
      commandAccepted: true,
      evidence: [
        row({
          route_id: 7,
          destination_id: null,
          destination_label: 'secondary destination unknown',
          stage: 'failover_route_send_failed',
          created_at: '2026-09-26T01:03:00Z',
          scope: 'failover',
        }),
      ],
    })
    expect(failoverFailed.status).toBe('failed')
    expect(failoverFailed.routes[0]?.destinationId).toBeNull()
  })

  it('stays unverified when this run has no delivery evidence or the trace failed to load', () => {
    expect(
      evaluateExactRunDelivery({ streamId: 42, runtimeRunId: 'run-new', commandAccepted: true, evidence: [] }).status,
    ).toBe('unverified')
    expect(
      evaluateExactRunDelivery({ streamId: 42, runtimeRunId: 'run-new', commandAccepted: true, evidence: null }).status,
    ).toBe('unverified')
    expect(
      evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: null,
        commandAccepted: true,
        evidence: [row({ route_id: 7, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z' })],
      }).status,
    ).toBe('unverified')
  })

  it('marks mixed routes as partial', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-new',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z' }),
        row({ route_id: 8, destination_id: 12, stage: 'route_retry_failed', created_at: '2026-09-26T01:03:00Z' }),
      ],
    })
    expect(proof.status).toBe('partial')
    expect(proof.routes.map((route) => route.status)).toEqual(['proven', 'failed'])
  })

  it('marks a later success after failure as recovered, but not after an unverified run or another stream', () => {
    const recovered = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-2',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T02:00:00Z' })],
      aggregates: counts(1),
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'failed' },
    })
    expect(recovered.status).toBe('recovered')

    const afterUnverified = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-2',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T02:00:00Z' })],
      aggregates: counts(1),
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'unverified' },
    })
    expect(afterUnverified.status).toBe('proven')

    const otherStream = evaluateExactRunDelivery({
      streamId: 99,
      runtimeRunId: 'run-2',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T02:00:00Z' })],
      aggregates: counts(1),
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'partial' },
    })
    expect(otherStream.status).toBe('proven')
  })

  it('does not prove a run when another route is rate-limited or hits an unknown failure policy', () => {
    const rateLimited = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-rl',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({ route_id: 8, destination_id: 12, stage: 'destination_rate_limited', created_at: '2026-09-26T01:01:00Z', sequence: 2 }),
      ],
    })
    expect(rateLimited.status).not.toBe('proven')
    expect(rateLimited.status).not.toBe('recovered')
    expect(rateLimited.status).toBe('partial')
    expect(rateLimited.routes.map((route) => route.status)).toEqual(['proven', 'failed'])

    const dynamicLimited = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-drl',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({
          dynamic_route_id: 4,
          destination_id: 12,
          stage: 'dynamic_route_send_rate_limited',
          created_at: '2026-09-26T01:01:00Z',
          scope: 'dynamic',
          sequence: 2,
        }),
      ],
    })
    expect(dynamicLimited.status).toBe('partial')
    expect(dynamicLimited.routes.find((route) => route.dynamicRouteId === 4)?.status).toBe('failed')

    const unknownPolicy = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-up',
      commandAccepted: true,
      evidence: [
        row({ route_id: 9, destination_id: 13, stage: 'route_unknown_failure_policy', created_at: '2026-09-26T01:00:00Z' }),
      ],
    })
    expect(unknownPolicy.status).toBe('failed')
    expect(unknownPolicy.routes[0]?.status).toBe('failed')
  })

  it('keeps an intentional disabled skip distinct from a failed or proven delivery', () => {
    const skipped = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-skip',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({ route_id: 8, destination_id: 12, stage: 'route_skip', created_at: '2026-09-26T01:01:00Z', sequence: 2 }),
      ],
      aggregates: counts(1),
    })
    expect(skipped.status).toBe('proven')
    expect(skipped.routes).toHaveLength(1)
    expect(skipped.routes[0]).toMatchObject({ routeId: 7, status: 'proven' })
  })

  it('keeps a failed or partial recovery basis across a later unverified run', () => {
    for (const basis of ['failed', 'partial'] as const) {
      const initial = { streamId: 42, runtimeRunId: 'run-a', status: basis }
      const unverified = evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: 'run-b',
        commandAccepted: true,
        evidence: [],
        prior: initial,
      })
      expect(unverified.status).toBe('unverified')
      const kept = nextDeliveryProofPrior(42, initial, unverified)
      expect(kept).toEqual(initial)

      const recovered = evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: 'run-c',
        commandAccepted: true,
        evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T03:00:00Z' })],
        aggregates: counts(1),
        prior: kept,
      })
      expect(recovered.status).toBe('recovered')

      const cleared = nextDeliveryProofPrior(42, kept, recovered)
      expect(cleared.status).toBe('proven')
      const later = evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: 'run-d',
        commandAccepted: true,
        evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T04:00:00Z' })],
        aggregates: counts(1),
        prior: cleared,
      })
      expect(later.status).toBe('proven')
    }
  })

  it('keeps two dynamic routes to the same destination distinct', () => {
    const mixed = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dyn',
      commandAccepted: true,
      evidence: [
        row({ dynamic_route_id: 1, destination_id: 9, stage: 'dynamic_route_send_failed', created_at: '2026-09-26T01:00:00Z', scope: 'dynamic', sequence: 1 }),
        row({ dynamic_route_id: 2, destination_id: 9, stage: 'dynamic_route_send_success', created_at: '2026-09-26T01:01:00Z', scope: 'dynamic', sequence: 2 }),
      ],
      aggregates: counts(0),
    })
    expect(mixed.status).toBe('partial')
    expect(mixed.routes).toHaveLength(2)

    const both = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dyn-ok',
      commandAccepted: true,
      evidence: [
        row({ dynamic_route_id: 1, destination_id: 9, stage: 'dynamic_route_send_success', created_at: '2026-09-26T01:00:00Z', scope: 'dynamic', sequence: 1 }),
        row({ dynamic_route_id: 2, destination_id: 9, stage: 'dynamic_route_send_success', created_at: '2026-09-26T01:01:00Z', scope: 'dynamic', sequence: 2 }),
      ],
      aggregates: counts(0),
    })
    expect(both.status).toBe('proven')
    expect(both.routes.map((route) => route.dynamicRouteId)).toEqual([1, 2])
  })

  it('does not prove dynamic delivery when route identity is missing', () => {
    const single = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dyn-anon',
      commandAccepted: true,
      evidence: [
        row({ destination_id: 9, stage: 'dynamic_route_send_success', created_at: '2026-09-26T01:00:00Z', scope: 'dynamic' }),
      ],
      aggregates: counts(0),
    })
    expect(single.status).toBe('unverified')

    const conflicting = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dyn-anon-mix',
      commandAccepted: true,
      evidence: [
        row({ destination_id: 9, stage: 'dynamic_route_send_failed', created_at: '2026-09-26T01:00:00Z', scope: 'dynamic', sequence: 1 }),
        row({ destination_id: 8, stage: 'dynamic_route_send_success', created_at: '2026-09-26T01:01:00Z', scope: 'dynamic', sequence: 2 }),
      ],
      aggregates: counts(0),
    })
    expect(conflicting.status).not.toBe('proven')
    expect(conflicting.status).not.toBe('recovered')
  })

  it('does not prove when aggregate success and base-route terminals disagree in either direction', () => {
    const evidence = [
      row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
      row({ route_id: 8, destination_id: 12, stage: 'route_send_success', created_at: '2026-09-26T01:01:00Z', sequence: 2 }),
    ]
    expect(
      evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: 'run-mismatch',
        commandAccepted: true,
        evidence,
        aggregates: counts(1),
      }).status,
    ).toBe('unverified')
    expect(
      evaluateExactRunDelivery({
        streamId: 42,
        runtimeRunId: 'run-match',
        commandAccepted: true,
        evidence,
        aggregates: counts(2),
      }).status,
    ).toBe('proven')
  })

  it('does not treat failover failure followed by retry success as proven', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-ambiguous',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_failed', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({ route_id: 7, stage: 'failover_route_send_failed', created_at: '2026-09-26T01:01:00Z', sequence: 2, scope: 'failover' }),
        row({ route_id: 7, destination_id: 11, stage: 'route_retry_success', created_at: '2026-09-26T01:02:00Z', sequence: 3 }),
      ],
      aggregates: counts(0, 1),
    })
    expect(proof.status).toBe('failed')
  })

  it('treats a dynamic destination_disabled skip as undelivered', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-skip',
      commandAccepted: true,
      evidence: [
        row({
          route_id: 7,
          destination_id: 11,
          stage: 'route_send_success',
          created_at: '2026-09-26T01:00:00Z',
          sequence: 1,
        }),
        row({
          dynamic_route_id: 4,
          destination_id: 12,
          stage: 'dynamic_route_send_skip',
          skip_reason: 'destination_disabled',
          created_at: '2026-09-26T01:00:01Z',
          sequence: 2,
        }),
      ],
      aggregates: counts(1),
    })
    expect(proof.status).toBe('partial')
    expect(proof.routes.find((route) => route.dynamicRouteId === 4)?.status).toBe('failed')
  })

  it('accepts duplicate_base_destination only when exact-run delivery to that destination is proven', () => {
    const skip = row({
      dynamic_route_id: 4,
      destination_id: 11,
      stage: 'dynamic_route_send_skip',
      skip_reason: 'duplicate_base_destination',
      created_at: '2026-09-26T01:00:01Z',
      sequence: 2,
    })
    const proven = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dup',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        skip,
      ],
      aggregates: counts(1),
    })
    expect(proven.status).toBe('proven')

    const missing = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-dup',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 12, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        skip,
      ],
      aggregates: counts(1),
    })
    expect(missing.status).toBe('unverified')
  })

  it('fails closed when a dynamic skip reason is unknown', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-unknown-skip',
      commandAccepted: true,
      evidence: [
        row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 }),
        row({
          dynamic_route_id: 4,
          destination_id: 12,
          stage: 'dynamic_route_send_skip',
          skip_reason: 'mystery',
          created_at: '2026-09-26T01:00:01Z',
          sequence: 2,
        }),
      ],
      aggregates: counts(1),
    })
    expect(proof.status).toBe('unverified')
  })
})
