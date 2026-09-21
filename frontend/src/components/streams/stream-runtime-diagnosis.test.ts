import { describe, expect, it } from 'vitest'
import type { OperationalIssue, StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'
import { buildStreamDiagnosis, type BuildStreamDiagnosisInput } from './stream-runtime-diagnosis'

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

  it('marks checkpoint not applicable for push ingest', () => {
    const diagnosis = buildStreamDiagnosis(
      input({ showCheckpointObservability: false, checkpointLabel: null }),
    )
    expect(diagnosis.causes.find((cause) => cause.key === 'checkpoint')).toMatchObject({
      tone: 'not_applicable',
      detail: 'Push ingest does not use a checkpoint.',
    })
  })

  it('offers start when the stream is stopped and runtime control is allowed', () => {
    const diagnosis = buildStreamDiagnosis(input({ displayStatus: 'STOPPED', checkpointLabel: 'cursor-1' }))
    expect(diagnosis.causes.find((cause) => cause.key === 'source')?.tone).toBe('attention')
    expect(diagnosis.nextSteps[0]).toMatchObject({ kind: 'start', label: 'Start stream' })
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
