import type { StreamRuntimeStatus } from '../../api/streamRows'
import { logsPath, streamEditPath, streamMappingPath, streamRuntimePath } from '../../config/nav-paths'
import type { OperationalIssue, StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'

export type DiagnosisTone = 'clear' | 'attention' | 'critical' | 'unknown' | 'not_applicable'

export type DiagnosisCauseKey =
  | 'source'
  | 'mapping'
  | 'schema-drift'
  | 'protection'
  | 'destination'
  | 'checkpoint'

export type DiagnosisCause = {
  key: DiagnosisCauseKey
  label: string
  tone: DiagnosisTone
  detail: string
}

export type DiagnosisNextStep =
  | { id: string; label: string; kind: 'link'; href: string }
  | { id: string; label: string; kind: 'start' | 'run-once' | 'backfill' }

export type StreamDiagnosis = {
  whatHappened: string
  causes: DiagnosisCause[]
  nextSteps: DiagnosisNextStep[]
}

export type BuildStreamDiagnosisInput = {
  streamId: string
  displayStatus: StreamRuntimeStatus
  hasRuntimeEvidence: boolean
  governance: StreamGovernanceSnapshot | null
  issues: readonly OperationalIssue[]
  showCheckpointObservability: boolean
  checkpointLabel: string | null
  deliveryPctKnown: boolean
  deliveryPct: number
  recentErrorMessage: string | null
  canMutateWorkspace: boolean
  canRuntimeControl: boolean
  canBackfill: boolean
  logsHref?: string | null
}

const CAUSE_LABEL: Record<DiagnosisCauseKey, string> = {
  source: 'Source',
  mapping: 'Mapping',
  'schema-drift': 'Schema Drift',
  protection: 'Protection',
  destination: 'Destination',
  checkpoint: 'Checkpoint',
}

function cause(key: DiagnosisCauseKey, tone: DiagnosisTone, detail: string): DiagnosisCause {
  return { key, label: CAUSE_LABEL[key], tone, detail }
}

function issueByKey(issues: readonly OperationalIssue[], key: string): OperationalIssue | undefined {
  return issues.find((issue) => issue.key === key)
}

function runtimeTab(streamId: string, tab: string): string {
  return `${streamRuntimePath(streamId)}?tab=${tab}`
}

function buildSourceCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  if (!input.hasRuntimeEvidence) {
    return cause('source', 'unknown', 'Runtime status has not loaded, so the source cannot be confirmed.')
  }
  if (input.displayStatus === 'STOPPED') {
    return cause('source', 'attention', 'Stream is stopped. Scheduled collection is not running.')
  }
  if (input.displayStatus === 'UNKNOWN') {
    return cause('source', 'unknown', 'Source status is not confirmed by the current runtime snapshot.')
  }
  const destinationIssue = input.issues.some((issue) =>
    issue.key === 'destination' || issue.key === 'destination-degraded' || issue.key === 'low-success',
  )
  if (input.displayStatus === 'ERROR' && !destinationIssue) {
    return cause('source', 'critical', 'Runtime status is ERROR and no destination failure explains it.')
  }
  if (input.displayStatus === 'DEGRADED' && !destinationIssue) {
    return cause('source', 'attention', 'Runtime status is degraded and no destination failure explains it.')
  }
  if (input.displayStatus === 'RUNNING' || input.displayStatus === 'IDLE') {
    return cause('source', 'clear', 'No source failure is indicated by the current runtime status.')
  }
  if (destinationIssue) {
    return cause('source', 'clear', 'Current evidence points to delivery rather than the source.')
  }
  return cause('source', 'unknown', `Source status is ${input.displayStatus}.`)
}

function buildMappingCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  if (!input.hasRuntimeEvidence) {
    return cause('mapping', 'unknown', 'Mapping evidence has not loaded.')
  }
  return cause('mapping', 'clear', 'No mapping failure is present in the current runtime evidence.')
}

function buildSchemaCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  const drift = input.governance?.schemaDrift
  if (!input.governance || drift == null) {
    return cause('schema-drift', 'unknown', 'Schema drift summary is not available.')
  }
  const open = drift.open_count ?? 0
  if (open > 0) {
    const issue = issueByKey(input.issues, 'schema-drift')
    return cause('schema-drift', 'attention', issue?.detail ?? `${open} open schema drift finding${open === 1 ? '' : 's'}.`)
  }
  return cause('schema-drift', 'clear', 'No open schema drift findings.')
}

function buildProtectionCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  const gov = input.governance
  if (!gov || (gov.protection == null && gov.sensitive == null && gov.quarantine == null)) {
    return cause('protection', 'unknown', 'Protection summary is not available.')
  }
  const quarantined = gov.quarantine?.quarantined_count ?? 0
  if (quarantined > 0) {
    const issue = issueByKey(input.issues, 'quarantine')
    return cause('protection', 'critical', issue?.detail ?? `${quarantined} event${quarantined === 1 ? '' : 's'} in quarantine.`)
  }
  const sensitive = gov.sensitive?.open_count ?? 0
  if (sensitive > 0) {
    const issue = issueByKey(input.issues, 'sensitive')
    return cause('protection', 'attention', issue?.detail ?? `${sensitive} open sensitive finding${sensitive === 1 ? '' : 's'}.`)
  }
  return cause('protection', 'clear', 'No quarantine or open sensitive findings in the current summary.')
}

function buildDestinationCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  if (!input.hasRuntimeEvidence) {
    return cause('destination', 'unknown', 'Destination outcome has not loaded.')
  }
  const destination = issueByKey(input.issues, 'destination')
  const degraded = issueByKey(input.issues, 'destination-degraded')
  const lowSuccess = issueByKey(input.issues, 'low-success')
  if (destination) {
    return cause('destination', 'critical', destination.detail ?? input.recentErrorMessage ?? 'A delivery path reported a failure.')
  }
  if (degraded || lowSuccess) {
    const issue = degraded ?? lowSuccess
    return cause('destination', 'attention', issue?.detail ?? 'Delivery is below the healthy threshold.')
  }
  if (input.deliveryPctKnown) {
    return cause('destination', 'clear', `Delivery success is ${input.deliveryPct.toFixed(1)}% with no destination failure.`)
  }
  return cause('destination', 'unknown', 'Destination success is not available for this window.')
}

function buildCheckpointCause(input: BuildStreamDiagnosisInput): DiagnosisCause {
  if (!input.showCheckpointObservability) {
    return cause('checkpoint', 'not_applicable', 'Push ingest does not use a checkpoint.')
  }
  if (!input.hasRuntimeEvidence) {
    return cause('checkpoint', 'unknown', 'Checkpoint evidence has not loaded.')
  }
  if (input.checkpointLabel) {
    return cause('checkpoint', 'clear', `Latest checkpoint is ${input.checkpointLabel}.`)
  }
  return cause('checkpoint', 'unknown', 'No checkpoint value is reported.')
}

function buildWhatHappened(causes: readonly DiagnosisCause[]): string {
  const urgent = causes
    .filter((item) => item.tone === 'critical' || item.tone === 'attention')
    .slice()
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'critical' ? -1 : 1))
  if (urgent.length > 0) {
    return urgent
      .slice(0, 2)
      .map((item) => item.detail.replace(/\.$/, ''))
      .join('. ') + '.'
  }
  const unknown = causes.filter((item) => item.tone === 'unknown')
  if (unknown.length > 0) {
    return 'No confirmed failure is present, but some diagnostic areas are still unknown.'
  }
  return 'No source, mapping, schema drift, protection, destination, or checkpoint issue is indicated.'
}

function buildNextSteps(input: BuildStreamDiagnosisInput, causes: readonly DiagnosisCause[]): DiagnosisNextStep[] {
  const byKey = new Map(causes.map((item) => [item.key, item]))
  const steps: DiagnosisNextStep[] = []
  const source = byKey.get('source')
  const destination = byKey.get('destination')
  const schema = byKey.get('schema-drift')
  const protection = byKey.get('protection')
  const checkpoint = byKey.get('checkpoint')

  if (source?.tone === 'attention' && input.displayStatus === 'STOPPED' && input.canRuntimeControl) {
    steps.push({ id: 'start', label: 'Start stream', kind: 'start' })
  }
  if (destination && (destination.tone === 'critical' || destination.tone === 'attention')) {
    steps.push({ id: 'events', label: 'Review recent events', kind: 'link', href: runtimeTab(input.streamId, 'events') })
    steps.push({
      id: 'logs',
      label: 'Open delivery logs',
      kind: 'link',
      href: input.logsHref ?? logsPath(input.streamId),
    })
    if (input.canBackfill) steps.push({ id: 'backfill', label: 'Run Backfill', kind: 'backfill' })
  }
  if (schema?.tone === 'attention') {
    steps.push({ id: 'schema', label: 'Review schema drift', kind: 'link', href: runtimeTab(input.streamId, 'schema') })
  }
  if (protection && (protection.tone === 'critical' || protection.tone === 'attention')) {
    steps.push({
      id: 'violations',
      label: 'Review protection findings',
      kind: 'link',
      href: runtimeTab(input.streamId, 'violations'),
    })
  }
  if (checkpoint?.tone === 'unknown' && input.showCheckpointObservability) {
    steps.push({ id: 'audit', label: 'Open checkpoint history', kind: 'link', href: runtimeTab(input.streamId, 'audit') })
  }
  if (steps.length > 0 && input.canMutateWorkspace) {
    steps.push({ id: 'edit-mapping', label: 'Edit mapping', kind: 'link', href: streamMappingPath(input.streamId) })
    steps.push({ id: 'edit-stream', label: 'Edit stream', kind: 'link', href: streamEditPath(input.streamId) })
  }
  if (source?.tone === 'critical' && input.canRuntimeControl) {
    steps.unshift({ id: 'run-once', label: 'Run Now', kind: 'run-once' })
  }
  return steps
}

export function buildStreamDiagnosis(input: BuildStreamDiagnosisInput): StreamDiagnosis {
  const causes = [
    buildSourceCause(input),
    buildMappingCause(input),
    buildSchemaCause(input),
    buildProtectionCause(input),
    buildDestinationCause(input),
    buildCheckpointCause(input),
  ]
  return {
    whatHappened: buildWhatHappened(causes),
    causes,
    nextSteps: buildNextSteps(input, causes),
  }
}
