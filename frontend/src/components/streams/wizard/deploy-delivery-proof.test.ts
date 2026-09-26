import { describe, expect, it } from 'vitest'
import { evaluateExactRunDelivery, type DeliveryEvidenceRow } from './deploy-delivery-proof'

function row(partial: DeliveryEvidenceRow): DeliveryEvidenceRow {
  return partial
}

describe('evaluateExactRunDelivery', () => {
  it('treats an exact-run success as proven', () => {
    const proof = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-new',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T01:00:00Z', sequence: 1 })],
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
          stage: 'dynamic_route_send_success',
          created_at: '2026-09-26T01:00:00Z',
          scope: 'dynamic',
        }),
      ],
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
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'failed' },
    })
    expect(recovered.status).toBe('recovered')

    const afterUnverified = evaluateExactRunDelivery({
      streamId: 42,
      runtimeRunId: 'run-2',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T02:00:00Z' })],
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'unverified' },
    })
    expect(afterUnverified.status).toBe('proven')

    const otherStream = evaluateExactRunDelivery({
      streamId: 99,
      runtimeRunId: 'run-2',
      commandAccepted: true,
      evidence: [row({ route_id: 7, destination_id: 11, stage: 'route_send_success', created_at: '2026-09-26T02:00:00Z' })],
      prior: { streamId: 42, runtimeRunId: 'run-1', status: 'partial' },
    })
    expect(otherStream.status).toBe('proven')
  })
})
