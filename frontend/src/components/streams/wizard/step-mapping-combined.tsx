import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runMappingDraftPreview, runTransformPreview } from '../../../api/gdcRuntimePreview'
import { cn } from '../../../lib/utils'
import { mapWithConcurrency } from './bounded-async-map'
import { EnrichmentAddFieldMenu } from './enrichment-add-field-menu'
import { EnrichmentRulesEditor } from './enrichment-rules-editor'
import { TransformRuleDebugger } from './transform-rule-debugger'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import { WizardBasicMappingPanel } from './wizard-basic-mapping-panel'
import { WizardFullEventTransformWorkspace } from './wizard-full-event-transform-workspace'
import { buildFieldMappingsFromFullEventRegexConfigJson } from './wizard-full-event-regex-config'
import { buildWizardJsonataPreviewFieldMappings } from './wizard-full-event-preview'
import { wizardExtractEvents } from './wizard-json-extract'
import { buildMappedBaseFromState } from './wizard-review-preview'
import type { WizardDataProtectionState, WizardMappingRow, WizardState } from './wizard-state'
import { WizardTransformDataProtectionCard } from './wizard-transform-data-protection-card'
import { buildWizardTransformSample, wizardTransformSampleReady } from './wizard-transform-sample'

export type StepMappingCombinedProps = {
  state: WizardState
  onChangeMapping: (rows: WizardMappingRow[]) => void
  onChangeMappingMode: (mode: WizardState['mappingMode']) => void
  onChangeFullEventJsonata: (expression: string) => void
  onChangeFullEventRegexConfigJson: (json: string) => void
  onChangeEnrichment: (rules: WizardEnrichmentRule[]) => void
  onChangeUnmappedFieldsPolicy?: (policy: WizardState['unmappedFieldsPolicy']) => void
  onChangeDataProtection: (patch: Partial<WizardDataProtectionState>) => void
  dataProtectionDrawerOpen?: boolean
  onDataProtectionDrawerOpenChange?: (open: boolean) => void
  showOutputAside?: boolean
}

type MappingModeTab = 'basic' | 'advanced' | 'expert'

/**
 * v3 Transform step body — restored from 206f0f7 Mapping step (Basic · JSONPath / Advanced · JSONata / Expert · Regex).
 */
export function StepMappingCombined({
  state,
  onChangeMapping,
  onChangeMappingMode,
  onChangeFullEventJsonata,
  onChangeFullEventRegexConfigJson,
  onChangeEnrichment,
  onChangeUnmappedFieldsPolicy,
  onChangeDataProtection,
  dataProtectionDrawerOpen,
  onDataProtectionDrawerOpenChange,
  showOutputAside = true,
}: StepMappingCombinedProps) {
  const [modeTab, setModeTab] = useState<MappingModeTab>(() => {
    if (state.mappingMode === 'full_event_jsonata') return 'advanced'
    if (state.mappingMode === 'full_event_regex') return 'expert'
    return 'basic'
  })

  const mappingModeRef = useRef(state.mappingMode)
  useEffect(() => {
    const prev = mappingModeRef.current
    mappingModeRef.current = state.mappingMode
    if (prev === state.mappingMode) return
    if (state.mappingMode === 'full_event_jsonata') setModeTab('advanced')
    else if (state.mappingMode === 'full_event_regex') setModeTab('expert')
    else setModeTab('basic')
  }, [state.mappingMode])

  const sampleEvent = useMemo(() => {
    const events = state.apiTest.extractedEvents
    if (events && events.length > 0) {
      const first = events[0]
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return first as Record<string, unknown>
      }
    }

    // Edit-mode hydration can have parsed JSON but stale/empty extractedEvents.
    // Recompute from the latest configured event paths before giving up.
    const raw = state.apiTest.parsedJson ?? state.apiTest.rawResponse
    if (raw != null) {
      const eventArrayPath = state.stream.useWholeResponseAsEvent ? '' : state.stream.eventArrayPath.trim()
      const eventRootPath = state.stream.eventRootPath.trim()
      const extracted = wizardExtractEvents(raw, eventArrayPath, eventRootPath)
      const firstObject = extracted.find(
        (item): item is Record<string, unknown> =>
          item != null && typeof item === 'object' && !Array.isArray(item),
      )
      if (firstObject) return firstObject
    }

    const analyzed = state.apiTest.analysis?.sampleEvent
    if (analyzed && typeof analyzed === 'object' && !Array.isArray(analyzed)) {
      return analyzed
    }
    return null
  }, [
    state.apiTest.extractedEvents,
    state.apiTest.parsedJson,
    state.apiTest.rawResponse,
    state.apiTest.analysis,
    state.stream.useWholeResponseAsEvent,
    state.stream.eventArrayPath,
    state.stream.eventRootPath,
  ])

  const mappedBase = useMemo(
    () => buildMappedBaseFromState(sampleEvent, state.mapping, state.unmappedFieldsPolicy),
    [sampleEvent, state.mapping, state.unmappedFieldsPolicy],
  )

  const loadDebuggerMappedEvents = useCallback(async () => {
    const sample = buildWizardTransformSample(state)
    if (!sample) return []

    if (state.mappingMode === 'full_event_jsonata') {
      const expression = state.fullEventJsonataExpression.trim()
      if (!expression) throw new Error('Enter and validate a JSONata expression before previewing Guided rules.')
      return mapWithConcurrency(sample.extractedEvents.slice(0, 20), 4, async (event) => {
        const preview = await runTransformPreview({
          stage: 'mapping',
          sample_event: event,
          field_mappings: buildWizardJsonataPreviewFieldMappings(expression),
        })
        if (preview.save_blocked || preview.errors.length > 0) {
          throw new Error(preview.errors[0]?.message ?? 'JSONata mapping preview failed.')
        }
        return preview.transformed_result
      })
    }

    if (state.mappingMode === 'full_event_regex') {
      const built = buildFieldMappingsFromFullEventRegexConfigJson(state.fullEventRegexConfigJson)
      if (built.ok === false) throw new Error(built.error)
      return mapWithConcurrency(sample.extractedEvents.slice(0, 20), 4, async (event) => {
        const preview = await runTransformPreview({
          stage: 'mapping',
          sample_event: event,
          field_mappings: built.fieldMappings,
        })
        if (preview.save_blocked || preview.errors.length > 0) {
          throw new Error(preview.errors[0]?.message ?? 'Regex mapping preview failed.')
        }
        return preview.transformed_result
      })
    }

    const fieldMappings: Record<string, string> = {}
    for (const row of state.mapping) {
      const outputField = row.outputField.trim()
      const sourceJsonPath = row.sourceJsonPath.trim()
      if (outputField && sourceJsonPath) fieldMappings[outputField] = sourceJsonPath
    }
    if (state.unmappedFieldsPolicy === 'drop_unmapped') {
      fieldMappings.unmapped_fields_policy = 'drop_unmapped'
    }

    const preview = await runMappingDraftPreview({
      payload: sample.rawPayload,
      event_array_path: sample.eventArrayPath || null,
      event_root_path: sample.eventRootPath || null,
      field_mappings: fieldMappings,
      max_events: 20,
    })
    return preview.mapped_events
  }, [state])

  const mappedKeysLower = useMemo(() => {
    const keys = new Set<string>()
    for (const key of Object.keys(mappedBase)) keys.add(key.toLowerCase())
    return keys
  }, [mappedBase])

  const modeTabClass = (tab: MappingModeTab) =>
    modeTab === tab
      ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted'

  const transformSampleReady = wizardTransformSampleReady(state)
  const mappedFieldCount = state.mapping.filter((row) => row.sourceJsonPath.trim() && row.outputField.trim()).length
  const activeTransformRuleCount = state.enrichment.filter((rule) => rule.enabled && rule.fieldName.trim()).length

  return (
    <div data-testid="wizard-step-transform">
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
        {!transformSampleReady ? (
          <div
            className="mb-3 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
            role="status"
            data-testid="wizard-transform-sample-warning"
          >
            Latest sample is not loaded. You can keep editing mapping with saved paths, but preview/source event updates
            need a new API Test.
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-3" aria-label="Transform workflow summary">
          <TransformSummaryCell
            step="1"
            label="Source"
            value={transformSampleReady ? `${state.apiTest.eventCount || state.apiTest.extractedEvents.length || 1} sample event${(state.apiTest.eventCount || state.apiTest.extractedEvents.length || 1) === 1 ? '' : 's'}` : 'Sample required'}
            ready={transformSampleReady}
          />
          <TransformSummaryCell
            step="2"
            label="Rules"
            value={`${mappedFieldCount} mapped · ${activeTransformRuleCount} added field${activeTransformRuleCount === 1 ? '' : 's'}`}
            ready={mappedFieldCount > 0 || activeTransformRuleCount > 0}
          />
          <TransformSummaryCell
            step="3"
            label="Final event"
            value="Verify before delivery"
            ready={transformSampleReady && (mappedFieldCount > 0 || activeTransformRuleCount > 0)}
          />
        </div>

        <p className="mt-3 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
          Choose source fields, add transform rules, then verify the exact event that will be delivered.
        </p>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-2 border-b border-slate-200 dark:border-gdc-border">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Transform mode">
            <button
              type="button"
              role="tab"
              aria-selected={modeTab === 'basic'}
              className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('basic')}`}
              onClick={() => {
                setModeTab('basic')
                onChangeMappingMode('basic_jsonpath')
              }}
            >
              Basic · JSONPath
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={modeTab === 'advanced'}
              className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('advanced')}`}
              onClick={() => {
                setModeTab('advanced')
                onChangeMappingMode('full_event_jsonata')
              }}
            >
              Advanced · JSONata
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={modeTab === 'expert'}
              className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('expert')}`}
              onClick={() => {
                setModeTab('expert')
                onChangeMappingMode('full_event_regex')
              }}
            >
              Expert · Regex
            </button>
          </div>
          <EnrichmentAddFieldMenu
            rules={state.enrichment}
            onRulesChange={onChangeEnrichment}
            className="-mb-px pb-2"
          />
        </div>

        {modeTab === 'basic' ? (
          <WizardBasicMappingPanel
            state={state}
            onChangeMapping={onChangeMapping}
            onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
            showOutputAside={showOutputAside}
          />
        ) : (
          <div className="mt-4">
            <WizardFullEventTransformWorkspace
              sampleEvent={sampleEvent}
              unionSchema={state.apiTest.unionSchema}
              enrichment={state.enrichment}
              eventCount={state.apiTest.eventCount}
              jsonataExpression={state.fullEventJsonataExpression}
              onJsonataExpressionChange={onChangeFullEventJsonata}
              fullEventRegexConfigJson={state.fullEventRegexConfigJson}
              onFullEventRegexConfigJsonChange={onChangeFullEventRegexConfigJson}
              filterUiMode={modeTab === 'expert' ? 'expert' : 'advanced'}
            />
          </div>
        )}

        <div className="mt-4 space-y-3">
          <EnrichmentRulesEditor
            rules={state.enrichment}
            onChange={onChangeEnrichment}
            mappedKeysLower={mappedKeysLower}
            mappedSampleEvent={mappedBase}
            hideAddMenu
            data-testid="wizard-transform-enrichment-editor"
          />
          <TransformRuleDebugger
            loadMappedEvents={loadDebuggerMappedEvents}
            sampleAvailable={transformSampleReady}
            rules={state.enrichment}
            overridePolicy={state.enrichmentOverridePolicy}
          />
        </div>
      </section>

      <div className="mt-4">
        <WizardTransformDataProtectionCard
          state={state}
          onChange={onChangeDataProtection}
          drawerOpen={dataProtectionDrawerOpen}
          onDrawerOpenChange={onDataProtectionDrawerOpenChange}
        />
      </div>
    </div>
  )
}

function TransformSummaryCell({
  step,
  label,
  value,
  ready,
}: {
  step: string
  label: string
  value: string
  ready: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-gdc-border dark:bg-gdc-section">
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold',
          ready
            ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300'
            : 'border-slate-200 bg-white text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted',
        )}
      >
        {step}
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold text-slate-900 dark:text-gdc-foreground">{label}</span>
        <span className="block truncate text-[10px] text-slate-500 dark:text-gdc-muted">{value}</span>
      </span>
    </div>
  )
}
