import { Loader2, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import {
  getUnionSchemaSampleStatus,
  resolveUnionSchemaSampleCount,
} from '../../../utils/unionSchemaSamplePolicy'
import {
  summarizeUnionSchemaStatus,
  type UnionSchemaStatusSummary,
} from '../../../utils/wizardUnionSchema'
import type { WizardState } from './wizard-state'
import { wizardEventRootConfirmed, wizardRecordPathConfirmed } from './wizard-step-gates'
import { UnionSchemaSamplePolicyBanner } from './union-schema-sample-policy-banner'

type UnionSchemaStatusCardProps = {
  state: Pick<WizardState, 'stream' | 'apiTest'>
  extractedEventCount: number
  className?: string
}

function pendingMessage(state: Pick<WizardState, 'stream' | 'apiTest'>): string {
  const recordReady = wizardRecordPathConfirmed(state)
  const eventRootReady = wizardEventRootConfirmed(state)
  if (!recordReady && !eventRootReady) {
    return 'Union Schema not generated yet. Select Record Path and Event Root.'
  }
  if (!recordReady) return 'Union Schema not generated yet. Select Record Path.'
  if (!eventRootReady) return 'Union Schema not generated yet. Select Event Root.'
  return 'Generating Union Schema…'
}

export function UnionSchemaStatusCard({ state, extractedEventCount, className }: UnionSchemaStatusCardProps) {
  const summary = summarizeUnionSchemaStatus(state.apiTest.unionSchema)
  const samplePolicy = getUnionSchemaSampleStatus(
    resolveUnionSchemaSampleCount({
      unionSchema: state.apiTest.unionSchema,
      eventCount: summary.eventCount || extractedEventCount,
      extractedEvents: state.apiTest.extractedEvents,
    }),
  )

  if (summary.state !== 'ready') {
    // Terminal state: the sample is loaded, both selections are confirmed, and they extract nothing.
    // Without this the card claimed "Generating Union Schema…" forever (F-008).
    const samplePayload = state.apiTest.parsedJson ?? state.apiTest.rawResponse
    if (
      samplePayload != null &&
      state.apiTest.status === 'success' &&
      wizardRecordPathConfirmed(state) &&
      wizardEventRootConfirmed(state) &&
      extractedEventCount === 0
    ) {
      return (
        <div
          role="status"
          data-testid="union-schema-status-empty"
          className={cn(
            'rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
            className,
          )}
        >
          <p className="font-semibold">No records extracted — Union Schema cannot be generated.</p>
          <p className="mt-0.5 leading-snug">
            The current Record Path{state.stream.eventRootPath ? ` and Event Root (${state.stream.eventRootPath})` : ''} select
            no records from this sample. Use Reset Event root to return to the entire record, or choose a different Event
            Root or Record Path.
          </p>
        </div>
      )
    }

    const generating =
      wizardRecordPathConfirmed(state) &&
      wizardEventRootConfirmed(state) &&
      extractedEventCount > 0 &&
      state.apiTest.status === 'success'

    return (
      <div
        role="status"
        data-testid="union-schema-status-pending"
        className={cn(
          'rounded-md border border-slate-200/90 bg-white px-2.5 py-2 text-[11px] text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
          className,
        )}
      >
        <div className="flex items-start gap-2">
          {generating ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-violet-600" aria-hidden />
          ) : (
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
          )}
          <p className="leading-snug">{pendingMessage(state)}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      role="status"
      data-testid="union-schema-status-ready"
      className={cn(
        'rounded-md border border-emerald-200/80 bg-emerald-500/[0.06] px-2.5 py-2 text-[11px] text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100',
        className,
      )}
    >
      <p className="font-semibold">
        {summary.eventCount} event{summary.eventCount === 1 ? '' : 's'} analyzed
      </p>
      <p className="mt-0.5 leading-snug">
        {summary.fieldCount} field{summary.fieldCount === 1 ? '' : 's'} discovered
      </p>
      <p className="mt-1 text-[10px] opacity-90">
        Rare fields: {summary.rareFieldCount} · Sensitive fields: {summary.sensitiveFieldCount}
      </p>
      <UnionSchemaSamplePolicyBanner policy={samplePolicy} className="mt-2" />
    </div>
  )
}

export function unionSchemaStatusForTest(
  unionSchema: WizardState['apiTest']['unionSchema'],
): UnionSchemaStatusSummary {
  return summarizeUnionSchemaStatus(unionSchema)
}
