import { describe, expect, it } from 'vitest'
import type { OperationalIssue, StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'
import {
  buildStreamDiagnosis,
  deriveSourceObserved,
  isCheckpointBehindDelivery,
  type BuildStreamDiagnosisInput,
} from './stream-runtime-diagnosis'

function input(overrides: Partial<BuildStreamDiagnosisInput> = {}): BuildStreamDiagnosisInput {
  return {
    streamId: '42',
    displayStatus: 'RUNNING',
    hasRuntimeEvidence: true,
    governance: {
      schemaDrift: { open_count: 0 },
      sensitive: { open_count: 0 },
      protection: { protection_enabled: true },
      policy: null,
      dynamicRouting: null,
      failover: null,
      replay: null,
      quarantine: { quarantined_count: 0 },
    } as StreamGovernanceSnapshot,
    issues: [],
    showCheckpointObservability: true,
    checkpointLabel: '2026-01-01T00:00:00Z',
    deliveryPctKnown: true,
    deliveryPct: 99.2,
    // Source and checkpoint are Clear only with evidence; the calm baseline supplies it explicitly.
    sourceObserved: true,
    checkpointBehindDelivery: false,
    recentErrorMessage: null,
    canMutateWorkspace: true,
    canRuntimeControl: true,
    canBackfill: true,
    logsHref: '/logs?stream_id=42',
    ...overrides,
  }
}

describe('buildStreamDiagnosis', () => {
  it('keeps a calm summary when evidence shows no failure', () => {
    const diagnosis = buildStreamDiagnosis(input())
    expect(diagnosis.whatHappened).toMatch(/No source, mapping, schema drift/i)
    expect(diagnosis.causes.map((cause) => cause.label)).toEqual([
      'Source',
      'Mapping',
      'Schema Drift',
      'Protection',
      'Destination',
      'Checkpoint',
    ])
    expect(diagnosis.causes.find((cause) => cause.key === 'destination')?.tone).toBe('clear')
    expect(diagnosis.nextSteps).toEqual([])
  })

  it('surfaces destination and schema drift causes without calling the source healthy by default when evidence is missing', () => {
    const issues: OperationalIssue[] = [
      { key: 'destination', label: 'Destination failure', tone: 'critical', detail: 'HTTP 429 from destination' },
      { key: 'schema-drift', label: 'Schema drift detected', tone: 'warning', detail: '2 open drift findings' },
    ]
    const diagnosis = buildStreamDiagnosis(
      input({
        displayStatus: 'ERROR',
        hasRuntimeEvidence: false,
        governance: null,
        issues,
        checkpointLabel: null,
        deliveryPctKnown: false,
      }),
    )
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.tone).toBe('unknown')
    expect(diagnosis.causes.find((cause) => cause.key === 'schema-drift')?.tone).toBe('unknown')
    expect(diagnosis.causes.find((cause) => cause.key === 'destination')?.tone).toBe('unknown')
  })

  it('renders warning and critical causes from current issues and governance', () => {
    const issues: OperationalIssue[] = [
      { key: 'destination', label: 'Destination failure', tone: 'critical', detail: 'HTTP 429 from destination' },
      { key: 'schema-drift', label: 'Schema drift detected', tone: 'warning', detail: '1 field added' },
      { key: 'quarantine', label: 'Events quarantined', tone: 'critical', detail: '3 events in quarantine' },
    ]
    const diagnosis = buildStreamDiagnosis(
      input({
        displayStatus: 'ERROR',
        issues,
        governance: {
          schemaDrift: { open_count: 1, by_category: { field_added: 1, field_removed: 0, field_type_changed: 0 } },
          sensitive: { open_count: 0 },
          protection: { protection_enabled: true },
          policy: null,
          dynamicRouting: null,
          failover: null,
          replay: null,
          quarantine: { quarantined_count: 3 },
        } as StreamGovernanceSnapshot,
      }),
    )
    expect(diagnosis.whatHappened).toMatch(/HTTP 429/)
    expect(diagnosis.whatHappened).toMatch(/quarantine/)
    expect(diagnosis.causes.find((cause) => cause.key === 'destination')).toMatchObject({ tone: 'critical' })
    expect(diagnosis.causes.find((cause) => cause.key === 'schema-drift')).toMatchObject({ tone: 'attention' })
    expect(diagnosis.causes.find((cause) => cause.key === 'protection')).toMatchObject({ tone: 'critical' })
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.tone).toBe('clear')
    expect(diagnosis.nextSteps.map((step) => step.label)).toEqual(
      expect.arrayContaining(['Review recent events', 'Open delivery logs', 'Run Backfill', 'Review schema drift', 'Review protection findings']),
    )
  })

  it('lets an exact current Run Now source failure override a healthy window without discarding checkpoint history', () => {
    const diagnosis = buildStreamDiagnosis(
      input({
        displayStatus: 'ERROR',
        currentRunFailureMessage: '502: [SOURCE_HTTP_ERROR] HTTP 404 from /known-missing-path',
        checkpointLabel: 'cursor-42',
        deliveryPctKnown: true,
        deliveryPct: 100,
      }),
    )

    expect(diagnosis.causes.find((cause) => cause.key === 'source')).toMatchObject({
      tone: 'critical',
      detail: expect.stringContaining('[SOURCE_HTTP_ERROR] HTTP 404'),
    })
    expect(diagnosis.causes.find((cause) => cause.key === 'checkpoint')).toMatchObject({
      tone: 'clear',
      detail: 'Latest checkpoint is cursor-42.',
    })
    expect(diagnosis.whatHappened).toContain('Latest Run Now failed at the source')
    expect(diagnosis.nextSteps.map((step) => step.label)).toEqual(
      expect.arrayContaining(['Edit stream', 'Run Now']),
    )
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.detail).not.toContain(
      'No source failure is indicated',
    )
  })

  it('collapses a multi-line checkpoint summary into one sentence', () => {
    const diagnosis = buildStreamDiagnosis(
      input({ checkpointLabel: 'last event: evt-00140 @ 2026-10-29T12:02:20Z\ncursor: 2026-10-29T12:02:20Z' }),
    )
    expect(diagnosis.causes.find((cause) => cause.key === 'checkpoint')?.detail).toBe(
      'Latest checkpoint is last event: evt-00140 @ 2026-10-29T12:02:20Z · cursor: 2026-10-29T12:02:20Z.',
    )
  })

  it('marks checkpoint not applicable for push ingest', () => {
    const diagnosis = buildStreamDiagnosis(
      input({ showCheckpointObservability: false, checkpointLabel: null }),
    )
    expect(diagnosis.causes.find((cause) => cause.key === 'checkpoint')).toMatchObject({
      tone: 'not_applicable',
      detail: 'Push ingest does not use a checkpoint.',
    })
  })

  it('offers start when the stream is stopped and runtime control is allowed (STOPPED is neutral, not attention)', () => {
    const diagnosis = buildStreamDiagnosis(input({ displayStatus: 'STOPPED', checkpointLabel: 'cursor-1' }))
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.tone).toBe('inactive')
    expect(diagnosis.causes.some((cause) => cause.tone === 'attention')).toBe(false)
    expect(diagnosis.whatHappened).toMatch(/stopped or paused/i)
    expect(diagnosis.nextSteps[0]).toMatchObject({ kind: 'start', label: 'Start stream' })
  })

  it('keys the Start-stream step on displayStatus STOPPED, not on the source tone', () => {
    const running = buildStreamDiagnosis(input({ displayStatus: 'RUNNING' }))
    expect(running.nextSteps.some((step) => step.kind === 'start')).toBe(false)
    const stopped = buildStreamDiagnosis(input({ displayStatus: 'STOPPED', canRuntimeControl: true }))
    expect(stopped.nextSteps.filter((step) => step.kind === 'start')).toHaveLength(1)
  })

  it('does not call an IDLE source Clear without an observed run, fetch or events (Not observed yet)', () => {
    const diagnosis = buildStreamDiagnosis(input({ displayStatus: 'IDLE', sourceObserved: false }))
    expect(diagnosis.causes.find((cause) => cause.key === 'source')).toMatchObject({
      tone: 'unknown',
      statusLabel: 'Not observed yet',
    })
    expect(diagnosis.whatHappened).not.toMatch(/No source, mapping/i)
  })

  it('treats a RUNNING source without observation as unknown and with observation as clear', () => {
    expect(
      buildStreamDiagnosis(input({ displayStatus: 'RUNNING', sourceObserved: undefined })).causes.find(
        (cause) => cause.key === 'source',
      )?.tone,
    ).toBe('unknown')
    expect(
      buildStreamDiagnosis(input({ displayStatus: 'IDLE', sourceObserved: true })).causes.find(
        (cause) => cause.key === 'source',
      )?.tone,
    ).toBe('clear')
  })

  it('keeps a confirmed source ERROR critical even when nothing was observed (Unknown never masks Critical)', () => {
    const diagnosis = buildStreamDiagnosis(input({ displayStatus: 'ERROR', sourceObserved: false }))
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.tone).toBe('critical')
  })

  it('reports Mapping as Not evaluated yet without delivery attempts or processed events', () => {
    const diagnosis = buildStreamDiagnosis(input({ deliveryPctKnown: false, events1h: 0 }))
    expect(diagnosis.causes.find((cause) => cause.key === 'mapping')).toMatchObject({
      tone: 'unknown',
      statusLabel: 'Not evaluated yet',
    })
  })

  it('reports Mapping as Clear once events were processed or delivery was attempted', () => {
    expect(
      buildStreamDiagnosis(input({ deliveryPctKnown: false, events1h: 12 })).causes.find((c) => c.key === 'mapping')?.tone,
    ).toBe('clear')
    expect(
      buildStreamDiagnosis(input({ deliveryPctKnown: true, events1h: 0 })).causes.find((c) => c.key === 'mapping')?.tone,
    ).toBe('clear')
  })

  it('words an unmeasured destination as No deliveries observed', () => {
    const cause = buildStreamDiagnosis(input({ deliveryPctKnown: false })).causes.find((c) => c.key === 'destination')
    expect(cause).toMatchObject({ tone: 'unknown', statusLabel: 'No deliveries observed' })
    expect(cause?.detail).toMatch(/No deliveries observed/)
  })

  it('reports a missing checkpoint as Not observed yet and a lagging one as attention', () => {
    const none = buildStreamDiagnosis(input({ checkpointLabel: null })).causes.find((c) => c.key === 'checkpoint')
    expect(none).toMatchObject({ tone: 'unknown', statusLabel: 'Not observed yet' })
    const behind = buildStreamDiagnosis(input({ checkpointLabel: 'cursor-1', checkpointBehindDelivery: true }))
    expect(behind.causes.find((c) => c.key === 'checkpoint')?.tone).toBe('attention')
    expect(behind.whatHappened).toMatch(/behind successful delivery/)
    const ok = buildStreamDiagnosis(input({ checkpointLabel: 'cursor-1', checkpointBehindDelivery: false }))
    expect(ok.causes.find((c) => c.key === 'checkpoint')?.tone).toBe('clear')
  })

  it('derives sourceObserved only from events, processed events, a completed run or a non-failed recent run', () => {
    expect(deriveSourceObserved({})).toBe(false)
    expect(deriveSourceObserved({ eventsLastHour: 0, recentRunStatuses: ['FAILED'] })).toBe(false)
    expect(deriveSourceObserved({ eventsLastHour: 3 })).toBe(true)
    expect(deriveSourceObserved({ recentRunStatuses: ['FAILED', 'NO_EVENTS'] })).toBe(true)
    expect(deriveSourceObserved({ runCompleteCount: 1 })).toBe(true)
    expect(deriveSourceObserved({ processedEvents: 5 })).toBe(true)
  })

  it('mirrors should_flag_checkpoint_stale: delivering, lag >= 1h, checkpoint older than the last success', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const base = {
      delivering: true,
      lastSuccessAt: '2026-10-31T11:59:00Z',
      checkpointUpdatedAts: ['2026-10-31T09:00:00Z'],
      nowMs: now,
    }
    expect(isCheckpointBehindDelivery(base)).toBe(true)
    expect(isCheckpointBehindDelivery({ ...base, delivering: false })).toBe(false)
    expect(isCheckpointBehindDelivery({ ...base, checkpointUpdatedAts: ['2026-10-31T11:30:00Z'] })).toBe(false)
    expect(isCheckpointBehindDelivery({ ...base, checkpointUpdatedAts: [] })).toBe(false)
    expect(isCheckpointBehindDelivery({ ...base, lastSuccessAt: null })).toBe(false)
    expect(isCheckpointBehindDelivery({ ...base, checkpointUpdatedAts: ['2026-10-31T11:59:30Z'] })).toBe(false)
  })

  it('hides mutation steps when the session cannot change the workspace', () => {
    const diagnosis = buildStreamDiagnosis(
      input({
        displayStatus: 'STOPPED',
        canMutateWorkspace: false,
        canRuntimeControl: false,
        canBackfill: false,
      }),
    )
    expect(diagnosis.nextSteps).toEqual([])
  })
})
