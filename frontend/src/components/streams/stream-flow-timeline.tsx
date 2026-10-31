import { AlertTriangle, ArrowRight, Check, Circle, Minus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { streamEditWizardStepPath } from '../../config/nav-paths'
import type { StreamWorkflowSnapshot } from '../../utils/streamWorkflow'
import type { StreamRuntimeStatus } from '../../api/streamRows'
import {
  governanceFlowHints,
  type StreamGovernanceSnapshot,
} from '../../lib/stream-governance-snapshot'

export type FlowTimelineStageStatus = 'ok' | 'warn' | 'error' | 'skipped' | 'pending'

export type FlowTimelineSubStatus = {
  key: string
  label: string
  status: FlowTimelineStageStatus
  detail?: string
}

export type FlowTimelineStage = {
  key: string
  label: string
  shortLabel: string
  status: FlowTimelineStageStatus
  href?: string
  detail?: string
  subStatuses?: FlowTimelineSubStatus[]
}

/** Neutral governance label when wizard defaults are unchanged and nothing needs attention. */
export const GOVERNANCE_NO_CHANGE_DETAIL = 'No Change'

function governanceNoChangeStage(): Pick<FlowTimelineStage, 'status' | 'detail'> {
  return { status: 'ok', detail: GOVERNANCE_NO_CHANGE_DETAIL }
}

function safeNonNeg(n: unknown): number {
  const x = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(x) || x < 0) return 0
  return Math.floor(x)
}

function workflowStepStatus(
  status: 'complete' | 'pending' | 'attention' | undefined,
): FlowTimelineStageStatus {
  if (status === 'attention') return 'warn'
  if (status === 'complete') return 'ok'
  return 'pending'
}

function aggregateStageStatus(statuses: FlowTimelineStageStatus[]): FlowTimelineStageStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('warn')) return 'warn'
  if (statuses.every((s) => s === 'ok' || s === 'skipped')) return 'ok'
  if (statuses.every((s) => s === 'skipped')) return 'skipped'
  return 'pending'
}

function stageIcon(status: FlowTimelineStageStatus) {
  switch (status) {
    case 'ok':
      return <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
    case 'warn':
      return <AlertTriangle className="h-3 w-3" aria-hidden />
    case 'error':
      return <span className="text-[10px] font-bold leading-none" aria-hidden>✕</span>
    case 'skipped':
      return <Minus className="h-3 w-3" aria-hidden />
    default:
      return <Circle className="h-2.5 w-2.5" aria-hidden />
  }
}

function stageBubbleClass(status: FlowTimelineStageStatus) {
  switch (status) {
    case 'ok':
      return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'warn':
      return 'border-status-warning-border bg-status-warning-subtle text-status-warning'
    case 'error':
      return 'border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300'
    case 'skipped':
      return 'border-slate-300 bg-slate-100 text-slate-400 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-muted'
    default:
      return 'border-slate-300 bg-white text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted'
  }
}

function buildGovernanceSubStatuses(params: {
  displayStatus: StreamRuntimeStatus
  governance?: StreamGovernanceSnapshot | null
}): FlowTimelineSubStatus[] {
  const { displayStatus, governance } = params
  const govHints = governanceFlowHints(governance)

  let schemaStage = governanceNoChangeStage()
  if (govHints.schemaDriftOpen > 0) {
    schemaStage = { status: 'warn', detail: `${govHints.schemaDriftOpen} open` }
  } else if (governance?.schemaDrift?.drift_detection_enabled === false) {
    schemaStage = { status: 'skipped', detail: 'Disabled' }
  } else if (displayStatus === 'ERROR') {
    schemaStage = { status: 'warn', detail: GOVERNANCE_NO_CHANGE_DETAIL }
  }

  let sensitiveStage = governanceNoChangeStage()
  if (govHints.sensitiveOpen > 0) {
    sensitiveStage = { status: 'warn', detail: `${govHints.sensitiveOpen} open` }
  } else if (governance?.sensitive?.detection_enabled === false) {
    sensitiveStage = { status: 'skipped', detail: 'Disabled' }
  }

  let protectionStage = governanceNoChangeStage()
  const quarantinedCount = governance?.quarantine?.quarantined_count ?? 0
  const protectedEvents = governance?.protection?.total_protected_events ?? 0
  if (quarantinedCount > 0) {
    protectionStage = {
      status: 'error',
      detail: `${quarantinedCount} quarantined`,
    }
  } else if (protectedEvents > 0) {
    protectionStage = { status: 'ok', detail: `${protectedEvents} protected` }
  } else if (govHints.protectionActive) {
    protectionStage = { status: 'ok', detail: 'Active' }
  } else if (governance?.protection?.protection_enabled === false) {
    protectionStage = { status: 'skipped', detail: 'Off' }
  }

  let policyStage = governanceNoChangeStage()
  if ((governance?.policy?.audit_events ?? 0) > 0 && govHints.policyMatched === 0) {
    policyStage = {
      status: 'warn',
      detail: `${governance?.policy?.audit_events ?? 0} audit`,
    }
  } else if (displayStatus === 'ERROR') {
    policyStage = { status: 'warn', detail: GOVERNANCE_NO_CHANGE_DETAIL }
  } else if (govHints.policyMatched > 0) {
    policyStage = { status: 'ok', detail: `${govHints.policyMatched} matched` }
  }

  return [
    {
      key: 'schema_drift',
      label: 'Schema Drift',
      status: schemaStage.status,
      detail: schemaStage.detail,
    },
    {
      key: 'sensitive',
      label: 'Sensitive',
      status: sensitiveStage.status,
      detail: sensitiveStage.detail,
    },
    {
      key: 'protection',
      label: 'Protection',
      status: protectionStage.status,
      detail: protectionStage.detail,
    },
    {
      key: 'policy',
      label: 'Policy',
      status: policyStage.status,
      detail: policyStage.detail,
    },
  ]
}

export function buildFlowTimelineStages(params: {
  streamId: string
  displayStatus: StreamRuntimeStatus
  workflow: StreamWorkflowSnapshot
  deliveryPct: number | null
  deliveredLastHour?: number | null
  failedLastHour?: number | null
  routesErr: number | null
  usesPushIngest: boolean
  governance?: StreamGovernanceSnapshot | null
}): FlowTimelineStage[] {
  const {
    streamId,
    displayStatus,
    workflow,
    deliveryPct,
    deliveredLastHour = 0,
    failedLastHour = 0,
    routesErr,
    governance,
  } = params

  const connectorStep = workflow.steps.find((s) => s.key === 'connector')
  const apiTestStep = workflow.steps.find((s) => s.key === 'apiTest')
  const mappingStep = workflow.steps.find((s) => s.key === 'mapping')
  const enrichmentStep = workflow.steps.find((s) => s.key === 'enrichment')
  const destinationStep = workflow.steps.find((s) => s.key === 'destination')
  const routeStep = workflow.steps.find((s) => s.key === 'route')
  const savedStep = workflow.steps.find((s) => s.key === 'saved')

  // IDLE / UNKNOWN is "no verdict": the Connect stage is not confirmed OK without evidence.
  const connectNotObserved = displayStatus === 'IDLE' || displayStatus === 'UNKNOWN'
  const connectStatus = aggregateStageStatus([
    displayStatus === 'ERROR' ? 'error' : displayStatus === 'DEGRADED' ? 'warn' : connectNotObserved ? 'pending' : 'ok',
    workflowStepStatus(connectorStep?.status),
    workflowStepStatus(apiTestStep?.status),
  ])

  const sampleStatus = workflowStepStatus(apiTestStep?.status)

  const destinationsStatus = workflowStepStatus(destinationStep?.status)

  const governanceSubStatuses = buildGovernanceSubStatuses({ displayStatus, governance })
  const routeProcessingStatus = aggregateStageStatus([
    workflowStepStatus(mappingStep?.status),
    workflowStepStatus(enrichmentStep?.status),
    ...governanceSubStatuses.map((item) => item.status),
  ])

  const hasDeliveryOutcomes = safeNonNeg(deliveredLastHour) + safeNonNeg(failedLastHour) > 0
  let deployStatus: FlowTimelineStageStatus = 'pending'
  if (routeStep?.status === 'complete' && savedStep?.status === 'complete') {
    if ((routesErr ?? 0) > 0 || displayStatus === 'ERROR') deployStatus = 'error'
    else if (deliveryPct != null && deliveryPct < 85) deployStatus = 'warn'
    else if (displayStatus === 'DEGRADED') deployStatus = 'warn'
    else if (connectNotObserved || (deliveryPct == null && !hasDeliveryOutcomes)) deployStatus = 'pending'
    else deployStatus = 'ok'
  } else if (routeStep?.status === 'attention' || savedStep?.status === 'attention') {
    deployStatus = 'warn'
  }

  const deployDetail =
    hasDeliveryOutcomes && deliveryPct != null ? `${deliveryPct.toFixed(1)}% delivered` : undefined

  return [
    {
      key: 'connect',
      label: 'Connect',
      shortLabel: 'Connect',
      status: connectStatus,
      href: streamEditWizardStepPath(streamId, 'connect'),
      detail: displayStatus === 'STOPPED' ? 'Stopped' : undefined,
    },
    {
      key: 'sample',
      label: 'Sample & Record Selection',
      shortLabel: 'Sample',
      status: sampleStatus,
      href: streamEditWizardStepPath(streamId, 'sample'),
    },
    {
      key: 'destinations',
      label: 'Destinations',
      shortLabel: 'Destinations',
      status: destinationsStatus,
      href: streamEditWizardStepPath(streamId, 'destinations'),
    },
    {
      key: 'route_processing',
      label: 'Route Processing',
      shortLabel: 'Route Processing',
      status: routeProcessingStatus,
      href: streamEditWizardStepPath(streamId, 'route_processing'),
      subStatuses: governanceSubStatuses,
    },
    {
      key: 'deploy',
      label: 'Deploy',
      shortLabel: 'Deploy',
      status: deployStatus,
      href: streamEditWizardStepPath(streamId, 'deploy'),
      detail: deployDetail,
    },
  ]
}

export type StreamFlowTimelineProps = {
  stages: FlowTimelineStage[]
  lastRunLabel?: string | null
  className?: string
}

function stageStatusLabel(status: FlowTimelineStageStatus, detail?: string): string {
  if (detail === GOVERNANCE_NO_CHANGE_DETAIL) return GOVERNANCE_NO_CHANGE_DETAIL
  if (detail) return detail
  switch (status) {
    case 'ok':
      return 'Success'
    case 'warn':
      return 'Warning'
    case 'error':
      return 'Failed'
    case 'skipped':
      return 'Skipped'
    default:
      return 'Pending'
  }
}

function stageStatusClass(status: FlowTimelineStageStatus, detail?: string): string {
  if (detail === GOVERNANCE_NO_CHANGE_DETAIL) return 'text-slate-500 dark:text-gdc-muted'
  switch (status) {
    case 'ok':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'warn':
      return 'text-status-warning'
    case 'error':
      return 'text-red-600 dark:text-red-400'
    default:
      return 'text-slate-500 dark:text-gdc-muted'
  }
}

function subStatusDetailClass(status: FlowTimelineStageStatus, detail?: string): string {
  if (detail === GOVERNANCE_NO_CHANGE_DETAIL) return 'text-slate-500 dark:text-gdc-muted'
  return stageStatusClass(status, detail)
}

function RouteProcessingSubStatusList({ items }: { items: FlowTimelineSubStatus[] }) {
  return (
    <ul
      className="mt-1 w-full space-y-0.5 rounded-md border border-slate-200/70 bg-slate-50/80 px-2 py-1.5 dark:border-gdc-border dark:bg-gdc-elevated/60"
      data-testid="route-processing-substatus-list"
    >
      {items.map((item) => (
        <li key={item.key} className="flex items-baseline justify-between gap-2 text-[9px] leading-tight">
          <span className="font-medium text-slate-600 dark:text-slate-300">{item.label}</span>
          <span className={cn('shrink-0 font-medium', subStatusDetailClass(item.status, item.detail))}>
            {stageStatusLabel(item.status, item.detail)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function StreamFlowTimeline({ stages, lastRunLabel, className }: StreamFlowTimelineProps) {
  const warnStage = stages.find((s) => s.status === 'warn' || s.status === 'error')

  return (
    <section
      aria-label="Flow status"
      data-testid="stream-flow-timeline"
      className={cn(
        'rounded-xl border border-slate-200/80 bg-white px-4 py-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Flow Status</h3>
        {lastRunLabel ? (
          <p className="text-[10px] font-medium tabular-nums text-slate-500 dark:text-gdc-muted">Last run: {lastRunLabel}</p>
        ) : null}
      </div>

      <div className="mt-4 overflow-x-auto pb-1">
        <ol className="flex min-w-max items-start gap-0">
          {stages.map((stage, index) => {
            const statusLabel = stageStatusLabel(stage.status, stage.detail)
            const hasSubStatuses = (stage.subStatuses?.length ?? 0) > 0
            const content = (
              <div
                className={cn(
                  'flex flex-col items-center gap-1.5 px-1',
                  hasSubStatuses ? 'w-[9.5rem]' : 'w-[7.5rem]',
                )}
              >
                <span
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full border-2',
                    stageBubbleClass(stage.status),
                  )}
                  title={`${stage.label}: ${statusLabel}`}
                >
                  {stageIcon(stage.status)}
                </span>
                <span className="text-center text-[11px] font-semibold text-slate-800 dark:text-slate-100">{stage.shortLabel}</span>
                <span className={cn('text-center text-[10px] font-medium', stageStatusClass(stage.status, stage.detail))}>
                  {statusLabel}
                </span>
                {stage.subStatuses ? <RouteProcessingSubStatusList items={stage.subStatuses} /> : null}
              </div>
            )
            return (
              <li key={stage.key} className="flex items-start">
                {stage.href ? (
                  <Link to={stage.href} className="rounded-md transition-colors hover:bg-slate-50 dark:hover:bg-gdc-rowHover">
                    {content}
                  </Link>
                ) : (
                  content
                )}
                {index < stages.length - 1 ? (
                  <ArrowRight className="mx-1 mt-3 h-4 w-4 shrink-0 text-slate-400 dark:text-gdc-muted" aria-hidden />
                ) : null}
              </li>
            )
          })}
        </ol>
      </div>

      {warnStage ? (
        <p className="mt-3 text-[11px] text-status-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
          {warnStage.label}: {warnStage.status === 'error' ? 'error' : 'needs attention'}
          {warnStage.detail ? ` — ${warnStage.detail}` : ''}
        </p>
      ) : null}
    </section>
  )
}
