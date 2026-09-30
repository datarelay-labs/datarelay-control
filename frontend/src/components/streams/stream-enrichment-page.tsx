import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Eye,
  Lightbulb,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { streamEditWizardStepPath } from '../../config/nav-paths'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  type ComputedFieldRow,
  type StaticFieldRow,
  DEFAULT_COMPUTED_FIELDS,
  DEFAULT_STATIC_FIELDS,
} from './stream-enrichment-model'
import { StreamWorkflowSummaryStrip } from './stream-workflow-checklist'
import { computeStreamWorkflow } from '../../utils/streamWorkflow'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import { runFinalEventDraftPreview } from '../../api/gdcRuntimePreview'
import { AdvancedTransformWorkspace } from '../transform/advanced-transform-workspace'
import { EnrichmentRulesEditor } from './wizard/enrichment-rules-editor'
import {
  enrichmentDictFromRules,
  type WizardEnrichmentRule,
  wizardEnrichmentFromPersistedDict,
} from './wizard/enrichment-rules-model'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import {
  buildEnrichmentWithAdvancedFields,
  parseAdvancedFieldsFromEnrichment,
} from '../../utils/advancedTransformConfig'
import { loadMappingWorkspaceContext } from '../../utils/mappingSourceSample'
import { HelpTooltip } from '../ui/help-tooltip'
const WIZARD_STEPS = [
  { key: 'connector', title: 'Select Connector', subtitle: 'Choose a connector' },
  { key: 'endpoint', title: 'Configure Endpoint', subtitle: 'Define API endpoint' },
  { key: 'polling', title: 'Configure Polling', subtitle: 'Set schedule & pagination' },
  { key: 'test', title: 'Test Connection', subtitle: 'Verify & preview data' },
  { key: 'review', title: 'Review & Create', subtitle: 'Confirm and create' },
] as const

/** Mock image: final wizard step highlighted */
const ACTIVE_WIZARD_STEP = 4

function typeBadgeClass(type: string): string {
  const t = type.toLowerCase()
  if (t === 'datetime') return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
  if (t === 'integer') return 'border-violet-500/35 bg-violet-500/10 text-violet-800 dark:text-violet-200'
  return 'border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200'
}

function SummaryTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
    </div>
  )
}

function staticRowRuntimeValue(row: StaticFieldRow): unknown {
  const type = row.type.trim().toLowerCase()
  if (type === 'null') return null
  if (type === 'boolean' || type === 'bool') {
    if (row.value.trim().toLowerCase() === 'true') return true
    if (row.value.trim().toLowerCase() === 'false') return false
    return row.value
  }
  if (type === 'number' || type === 'integer' || type === 'float' || type === 'double') {
    const parsed = Number(row.value)
    return Number.isFinite(parsed) ? parsed : row.value
  }
  return row.value
}

function buildRuntimeEnrichmentPayload(
  staticRows: readonly StaticFieldRow[],
  computedRows: readonly ComputedFieldRow[],
  guidedRules: readonly WizardEnrichmentRule[],
  guidedPassthrough: Record<string, unknown>,
  emitGuidedAsTypeArray: boolean,
  advancedRules: readonly AdvancedTransformRuleDraft[],
  passthrough: Record<string, unknown>,
): Record<string, unknown> {
  const guided = enrichmentDictFromRules(guidedRules, {
    advancedPassthrough: guidedPassthrough,
    emitAdvancedAsTypeArray: emitGuidedAsTypeArray,
  })
  const enrichment: Record<string, unknown> = { ...passthrough, ...guided }
  for (const row of staticRows) {
    if (!row.fieldName.trim()) continue
    enrichment[row.fieldName.trim()] = staticRowRuntimeValue(row)
  }

  const computed: Record<string, { expression: string; type: string; description?: string }> = {}
  for (const row of computedRows) {
    if (!row.fieldName.trim()) continue
    computed[row.fieldName.trim()] = {
      expression: row.expression,
      type: row.type,
      description: row.description,
    }
  }
  if (Object.keys(computed).length > 0) enrichment.__computed = computed
  else delete enrichment.__computed

  return buildEnrichmentWithAdvancedFields(enrichment, advancedRules)
}

export function StreamEnrichmentPage() {
  const { streamId = 'malop-api' } = useParams<{ streamId: string }>()
  const navigate = useNavigate()
  const previewRef = useRef<HTMLDivElement>(null)
  const backendStreamId = useMemo(() => (/^\d+$/.test(streamId) ? Number(streamId) : null), [streamId])

  const [rulesTab, setRulesTab] = useState<'static' | 'computed' | 'guided' | 'advanced' | 'expert'>('static')
  const [guidedRules, setGuidedRules] = useState<WizardEnrichmentRule[]>([])
  const [guidedPassthrough, setGuidedPassthrough] = useState<Record<string, unknown>>({})
  const [emitGuidedAsTypeArray, setEmitGuidedAsTypeArray] = useState(false)
  const [advancedRules, setAdvancedRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [enrichmentPassthrough, setEnrichmentPassthrough] = useState<Record<string, unknown>>({})
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true)
  const [enrichmentOverridePolicy, setEnrichmentOverridePolicy] = useState<
    'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  >('KEEP_EXISTING')
  const [runtimeMappingContext, setRuntimeMappingContext] = useState<{
    payload: unknown
    eventArrayPath: string
    eventRootPath: string
    fieldMappings: Record<string, unknown>
  } | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [previewTab, setPreviewTab] = useState<'table' | 'json'>('table')
  const [staticSearch, setStaticSearch] = useState('')
  const [staticRows, setStaticRows] = useState<StaticFieldRow[]>(() => [...DEFAULT_STATIC_FIELDS])
  const [computedRows, setComputedRows] = useState<ComputedFieldRow[]>(() => [...DEFAULT_COMPUTED_FIELDS])
  const [previewTick, setPreviewTick] = useState(0)
  const [runtimePreviewRecord, setRuntimePreviewRecord] = useState<Record<string, unknown> | null>(null)
  const [runtimeMappedEvents, setRuntimeMappedEvents] = useState<Array<Record<string, unknown>>>([])
  const [runtimePreviewLoading, setRuntimePreviewLoading] = useState(false)
  const [runtimePreviewError, setRuntimePreviewError] = useState<string | null>(null)
  const runtimePreviewRequestRef = useRef(0)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
    JSON.stringify({
      staticRows: DEFAULT_STATIC_FIELDS,
      computedRows: DEFAULT_COMPUTED_FIELDS,
      guidedRules: [],
      advancedRules: [],
      enrichmentEnabled: true,
      enrichmentOverridePolicy: 'KEEP_EXISTING',
    }),
  )

  useEffect(() => {
    let cancelled = false
    if (backendStreamId == null) {
      setRuntimeMappingContext(null)
      setRuntimeMappedEvents([])
      setRuntimePreviewRecord(null)
      setRuntimePreviewError(null)
      setConfigLoading(false)
      return
    }
    setConfigLoading(true)
    void loadMappingWorkspaceContext(backendStreamId)
      .then((ctx) => {
        if (cancelled || !ctx) return
        const en = (ctx.cfg.enrichment?.enrichment ?? {}) as Record<string, unknown>
        const loadedAdvanced = parseAdvancedFieldsFromEnrichment(en)
        const guidedParsed = wizardEnrichmentFromPersistedDict(
          en.__rules && typeof en.__rules === 'object' && !Array.isArray(en.__rules)
            ? { __rules: en.__rules }
            : {},
        )
        setGuidedRules(guidedParsed.rules)
        setGuidedPassthrough(guidedParsed.advancedPassthrough)
        setEmitGuidedAsTypeArray(guidedParsed.emitAdvancedAsTypeArray)
        const loadedEnabled = ctx.cfg.enrichment?.enabled !== false
        const loadedPolicyRaw = ctx.cfg.enrichment?.override_policy
        const loadedPolicy =
          loadedPolicyRaw === 'OVERRIDE' ||
          loadedPolicyRaw === 'ERROR_ON_CONFLICT' ||
          loadedPolicyRaw === 'KEEP_EXISTING'
            ? loadedPolicyRaw
            : 'KEEP_EXISTING'
        setAdvancedRules(loadedAdvanced)
        setEnrichmentEnabled(loadedEnabled)
        setEnrichmentOverridePolicy(loadedPolicy)
        setRuntimeMappingContext({
          payload: ctx.sample.rawPayload,
          eventArrayPath: String(ctx.cfg.mapping?.event_array_path ?? ctx.sample.eventArrayPath ?? ''),
          eventRootPath: String(ctx.cfg.mapping?.event_root_path ?? ctx.sample.eventRootPath ?? ''),
          fieldMappings: (ctx.cfg.mapping?.field_mappings ?? {}) as Record<string, unknown>,
        })

        const staticFromApi: StaticFieldRow[] = []
        const computedFromApi: ComputedFieldRow[] = []
        const passthroughFromApi: Record<string, unknown> = {}

        const rawComputed = en.__computed
        if (rawComputed && typeof rawComputed === 'object' && !Array.isArray(rawComputed)) {
          for (const [key, rawValue] of Object.entries(rawComputed as Record<string, unknown>)) {
            if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue
            const item = rawValue as Record<string, unknown>
            if (typeof item.expression !== 'string') continue
            computedFromApi.push({
              id: `cf-api-${key}`,
              fieldName: key,
              expression: item.expression,
              type: typeof item.type === 'string' ? item.type : 'string',
              description: typeof item.description === 'string' ? item.description : '',
            })
          }
        }

        for (const [key, value] of Object.entries(en)) {
          if (key === '__computed' || key === 'advanced_fields' || key === '__rules') continue
          if (key.startsWith('__')) {
            passthroughFromApi[key] = value
            continue
          }
          if (value !== null && typeof value === 'object') {
            passthroughFromApi[key] = value
            continue
          }
          staticFromApi.push({
            id: `sf-api-${key}`,
            fieldName: key,
            value: value == null ? 'null' : String(value),
            type:
              value === null
                ? 'null'
                : typeof value === 'number'
                  ? 'number'
                  : typeof value === 'boolean'
                    ? 'boolean'
                    : 'string',
            description: '',
            overridePolicy: 'missing',
          })
        }
        setStaticRows(staticFromApi)
        setComputedRows(computedFromApi)
        setEnrichmentPassthrough(passthroughFromApi)

        setSavedSnapshot(
          JSON.stringify({
            staticRows: staticFromApi,
            computedRows: computedFromApi,
            guidedRules: guidedParsed.rules,
            advancedRules: loadedAdvanced,
            enrichmentEnabled: loadedEnabled,
            enrichmentOverridePolicy: loadedPolicy,
          }),
        )
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [backendStreamId])

  const filteredStatic = useMemo(() => {
    const q = staticSearch.trim().toLowerCase()
    if (!q) return staticRows
    return staticRows.filter(
      (r) =>
        r.fieldName.toLowerCase().includes(q) ||
        r.value.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q),
    )
  }, [staticRows, staticSearch])

  const summary = useMemo(() => {
    const staticCount = staticRows.length
    const computedCount = computedRows.length
    const guidedCount = guidedRules.filter((rule) => rule.enabled && rule.fieldName.trim()).length
    const advancedCount = advancedRules.filter((rule) => rule.outputField.trim()).length
    return {
      staticCount,
      computedCount,
      guidedCount,
      advancedCount,
      total: staticCount + computedCount + guidedCount + advancedCount,
    }
  }, [staticRows, computedRows, guidedRules, advancedRules])

  const runtimeEnrichmentPayload = useMemo(
    () =>
      buildRuntimeEnrichmentPayload(
        staticRows,
        computedRows,
        guidedRules,
        guidedPassthrough,
        emitGuidedAsTypeArray,
        advancedRules,
        enrichmentPassthrough,
      ),
    [
      staticRows,
      computedRows,
      guidedRules,
      guidedPassthrough,
      emitGuidedAsTypeArray,
      advancedRules,
      enrichmentPassthrough,
    ],
  )

  useEffect(() => {
    const requestId = ++runtimePreviewRequestRef.current
    let cancelled = false
    if (!runtimeMappingContext) {
      setRuntimePreviewRecord(null)
      setRuntimeMappedEvents([])
      setRuntimePreviewError(null)
      setRuntimePreviewLoading(false)
      return () => {
        cancelled = true
      }
    }

    const timer = window.setTimeout(() => {
      setRuntimePreviewLoading(true)
      setRuntimePreviewError(null)
      void runFinalEventDraftPreview({
        payload: runtimeMappingContext.payload,
        event_array_path: runtimeMappingContext.eventArrayPath || null,
        event_root_path: runtimeMappingContext.eventRootPath || null,
        field_mappings: runtimeMappingContext.fieldMappings,
        enrichment: enrichmentEnabled ? runtimeEnrichmentPayload : {},
        override_policy: enrichmentOverridePolicy,
        max_events: 20,
      })
        .then((response) => {
          if (cancelled || requestId !== runtimePreviewRequestRef.current) return
          setRuntimeMappedEvents(
            response.mapped_events.filter(
              (event): event is Record<string, unknown> =>
                event != null && typeof event === 'object' && !Array.isArray(event),
            ),
          )
          setRuntimePreviewRecord(response.final_events[0] ?? null)
          const fieldErrors = (response.enrichment_transform_results ?? []).filter((item) => !item.success)
          setRuntimePreviewError(
            fieldErrors.length > 0
              ? fieldErrors
                  .map((item) => `${item.output_field || item.rule_id || 'field'}: ${item.error_message || item.error_code || 'transform failed'}`)
                  .join(' · ')
              : null,
          )
        })
        .catch((error) => {
          if (cancelled || requestId !== runtimePreviewRequestRef.current) return
          setRuntimePreviewRecord(null)
          setRuntimeMappedEvents([])
          setRuntimePreviewError(error instanceof Error ? error.message : 'Runtime Mapping → Enrichment preview failed')
        })
        .finally(() => {
          if (cancelled || requestId !== runtimePreviewRequestRef.current) return
          setRuntimePreviewLoading(false)
        })
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    runtimeMappingContext,
    runtimeEnrichmentPayload,
    enrichmentEnabled,
    enrichmentOverridePolicy,
    previewTick,
  ])

  const previewRecord = runtimePreviewRecord ?? {}
  const previewJson = useMemo(() => JSON.stringify(previewRecord, null, 2), [previewRecord])
  const runtimeMappedSample = runtimeMappedEvents[0] ?? undefined
  const runtimeMappedKeysLower = useMemo(
    () => new Set(Object.keys(runtimeMappedSample ?? {}).map((key) => key.toLowerCase())),
    [runtimeMappedSample],
  )

  const scrollToPreview = useCallback(() => {
    previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const updateStatic = useCallback((id: string, patch: Partial<StaticFieldRow>) => {
    setStaticRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const removeStatic = useCallback((id: string) => {
    setStaticRows((rows) => rows.filter((r) => r.id !== id))
  }, [])

  const addStaticRow = useCallback(() => {
    const n = staticRows.length + 1
    setStaticRows((rows) => [
      ...rows,
      {
        id: `sf-${crypto.randomUUID()}`,
        fieldName: `custom_field_${n}`,
        value: '',
        type: 'string',
        description: '',
        overridePolicy: 'missing',
      },
    ])
  }, [staticRows.length])

  const updateComputed = useCallback((id: string, patch: Partial<ComputedFieldRow>) => {
    setComputedRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const removeComputed = useCallback((id: string) => {
    setComputedRows((rows) => rows.filter((r) => r.id !== id))
  }, [])

  const addComputedRow = useCallback(() => {
    setComputedRows((rows) => [
      ...rows,
      {
        id: `cf-${crypto.randomUUID()}`,
        fieldName: 'new_field',
        expression: 'identity($)',
        type: 'string',
        description: '',
      },
    ])
  }, [])

  const hasUnsavedChanges =
    JSON.stringify({
      staticRows,
      computedRows,
      guidedRules,
      advancedRules,
      enrichmentEnabled,
      enrichmentOverridePolicy,
    }) !== savedSnapshot

  const workflowSnapshot = useMemo(
    () =>
      computeStreamWorkflow({
        streamId,
        status: 'STOPPED',
        events1h: 0,
        deliveryPct: 0,
        routesTotal: 0,
        routesOk: 0,
        hasConnector: true,
        hasApiTest: true,
        hasMapping: true,
        hasEnrichment:
          enrichmentEnabled &&
          (staticRows.length +
              computedRows.length +
              guidedRules.filter((rule) => rule.enabled && rule.fieldName.trim()).length +
              advancedRules.filter((rule) => rule.outputField.trim()).length >
            0 ||
            Object.keys(guidedPassthrough).length > 0 ||
            Object.keys(enrichmentPassthrough).length > 0),
      }),
    [
      streamId,
      staticRows.length,
      computedRows.length,
      guidedRules,
      guidedPassthrough,
      advancedRules,
      enrichmentPassthrough,
      enrichmentEnabled,
    ],
  )

  async function handleSaveEnrichment(): Promise<boolean> {
    if (isSaving) return false
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    if (backendStreamId == null) {
      setSavedSnapshot(
        JSON.stringify({
          staticRows,
          computedRows,
          guidedRules,
          advancedRules,
          enrichmentEnabled,
          enrichmentOverridePolicy,
        }),
      )
      setSaveSuccess('Saved locally for preview only. Save to the stream after it has been created.')
      setIsSaving(false)
      return true
    }
    try {
      const result = await saveStreamMappingUiConfigStrict(backendStreamId, {
        enrichment: {
          enabled: enrichmentEnabled,
          enrichment: runtimeEnrichmentPayload,
          override_policy: enrichmentOverridePolicy,
        },
      })
      setSavedSnapshot(
        JSON.stringify({
          staticRows,
          computedRows,
          guidedRules,
          advancedRules,
          enrichmentEnabled,
          enrichmentOverridePolicy,
        }),
      )
      setSaveSuccess(`Saved · ${result.message}`)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save transform rules.'
      setSaveError(`Unable to save changes: ${message}`)
      return false
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 pb-28" data-stream-id={streamId}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Transform rules</h2>
          <p className="max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">
            Add or calculate fields that should appear in the final event delivered by this stream.
          </p>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
            {backendStreamId != null ? 'Changes are saved to this stream.' : 'Preview-only mode until this stream has a numeric ID.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <span
            className="inline-flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[11px] font-semibold text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
            aria-live="polite"
          >
            {isSaving ? 'Saving…' : saveError ? 'Save failed' : saveSuccess ? 'Saved' : hasUnsavedChanges ? 'Unsaved changes' : 'Saved'}
          </span>
          <button
            type="button"
            onClick={() => void handleSaveEnrichment()}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={scrollToPreview}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-violet-500/40 bg-white px-3 text-[12px] font-semibold text-violet-700 shadow-sm hover:bg-violet-500/[0.06] dark:border-violet-500/35 dark:bg-gdc-card dark:text-violet-300"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden />
            Preview Enriched Event
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={() => {
              void handleSaveEnrichment().then((saved) => {
                if (!saved) return
                navigate(
                  backendStreamId != null
                    ? streamEditWizardStepPath(String(backendStreamId), 'route_processing')
                    : '/streams',
                )
              })
            }}
            className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-4 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-60"
          >
            Save & Continue
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <section
        className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 dark:border-gdc-border dark:bg-gdc-section"
        data-testid="enrichment-runtime-controls"
      >
        <label className="inline-flex items-center gap-2 text-[12px] font-semibold text-slate-800 dark:text-slate-100">
          <input
            type="checkbox"
            checked={enrichmentEnabled}
            onChange={(event) => setEnrichmentEnabled(event.target.checked)}
            className="accent-violet-600"
          />
          Enrichment enabled
        </label>
        <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-gdc-muted">
          <span className="font-semibold text-slate-700 dark:text-slate-200">Existing-field policy</span>
          <select
            value={enrichmentOverridePolicy}
            onChange={(event) =>
              setEnrichmentOverridePolicy(
                event.target.value as 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT',
              )
            }
            className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            <option value="KEEP_EXISTING">Keep existing</option>
            <option value="OVERRIDE">Override existing</option>
            <option value="ERROR_ON_CONFLICT">Error on conflict</option>
          </select>
        </label>
        <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
          {enrichmentEnabled
            ? 'Preview and delivery use this exact policy.'
            : 'Rules remain editable, but runtime delivery skips Enrichment while disabled.'}
        </span>
      </section>

      {saveError ? <p className="text-[12px] font-medium text-red-700 dark:text-red-300">{saveError}</p> : null}
      {saveSuccess ? <p className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">{saveSuccess}</p> : null}

      <StreamWorkflowSummaryStrip
        snapshot={workflowSnapshot}
        activeStep="enrichment"
        highlightCompleted={['connector', 'apiTest', 'mapping']}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <section className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
          <div className="border-b border-slate-200/80 px-4 pt-3 dark:border-gdc-border">
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setRulesTab('static')}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-semibold',
                  rulesTab === 'static'
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                Add values
              </button>
              <button
                type="button"
                onClick={() => setRulesTab('computed')}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-semibold',
                  rulesTab === 'computed'
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                Calculate values
              </button>
              <button
                type="button"
                onClick={() => setRulesTab('guided')}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-semibold',
                  rulesTab === 'guided'
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                Guided rules
              </button>
              <button
                type="button"
                onClick={() => setRulesTab('advanced')}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-semibold',
                  rulesTab === 'advanced'
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                Advanced · JSONata
              </button>
              <button
                type="button"
                onClick={() => setRulesTab('expert')}
                className={cn(
                  '-mb-px border-b-2 pb-2 text-[13px] font-semibold',
                  rulesTab === 'expert'
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                Expert · Regex
              </button>
            </div>
          </div>

          <div className="p-4">
            {configLoading ? (
              <p className="py-8 text-center text-[12px] text-slate-500">Loading enrichment config…</p>
            ) : rulesTab === 'static' ? (
              <div className="space-y-3">
                <p className="text-[12px] text-slate-600 dark:text-gdc-muted">Add fixed values to every final event, such as environment or tenant metadata.</p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input
                      value={staticSearch}
                      onChange={(e) => setStaticSearch(e.target.value)}
                      placeholder="Search fields by name or value…"
                      className="h-9 w-full rounded-md border border-slate-200/90 bg-white py-1 pl-8 pr-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card"
                      aria-label="Search static fields"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={addStaticRow}
                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add value
                  </button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200/80 dark:border-gdc-border">
                  <table className={opTable}>
                    <thead>
                      <tr className={opThRow}>
                        <th className={cn(opTh, 'min-w-[120px]')}>Field Name</th>
                        <th className={cn(opTh, 'min-w-[100px]')}>Value</th>
                        <th className={cn(opTh, 'w-[88px]')}>Type</th>
                        <th className={cn(opTh, 'min-w-[140px]')}>Description</th>
                        <th className={cn(opTh, 'min-w-[140px]')}>
                          <span className="inline-flex items-center gap-1">
                            Conflict behavior
                            <HelpTooltip
                              content="All enrichment fields use the global Existing-field policy shown above."
                              ariaLabel="Enrichment conflict behavior help"
                            />
                          </span>
                        </th>
                        <th className={cn(opTh, 'w-[88px]')}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredStatic.map((row) => (
                        <tr key={row.id} className={opTr}>
                          <td className={opTd}>
                            <input
                              value={row.fieldName}
                              onChange={(e) => updateStatic(row.id, { fieldName: e.target.value })}
                              className="h-8 w-full min-w-[100px] rounded border border-transparent bg-transparent px-1 font-mono text-[12px] font-semibold text-slate-900 hover:border-slate-200 focus:border-violet-400 focus:outline-none dark:text-slate-100 dark:focus:border-violet-500"
                              aria-label={`Field name ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <input
                              value={row.value}
                              onChange={(e) => updateStatic(row.id, { value: e.target.value })}
                              className="h-8 w-full rounded border border-transparent bg-transparent px-1 text-[12px] text-slate-800 hover:border-slate-200 focus:border-violet-400 focus:outline-none dark:text-slate-200"
                              aria-label={`Value for ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <span className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase', typeBadgeClass(row.type))}>
                              {row.type}
                            </span>
                          </td>
                          <td className={opTd}>
                            <input
                              value={row.description}
                              onChange={(e) => updateStatic(row.id, { description: e.target.value })}
                              className="h-8 w-full rounded border border-transparent bg-transparent px-1 text-[11px] text-slate-600 focus:border-violet-400 focus:outline-none dark:text-gdc-muted"
                              aria-label={`Description for ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <span className="text-[10px] font-medium text-slate-600 dark:text-gdc-muted">
                              {enrichmentOverridePolicy === 'OVERRIDE'
                                ? 'Override existing'
                                : enrichmentOverridePolicy === 'ERROR_ON_CONFLICT'
                                  ? 'Error on conflict'
                                  : 'Keep existing'}
                            </span>
                          </td>
                          <td className={opTd}>
                            <div className="flex items-center gap-0.5">
                              <button
                                type="button"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-gdc-rowHover"
                                aria-label={`Edit ${row.fieldName}`}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeStatic(row.id)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400"
                                aria-label={`Delete ${row.fieldName}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : rulesTab === 'computed' ? (
              <div className="space-y-3">
                <p className="text-[12px] text-slate-600 dark:text-gdc-muted">Calculate values from existing event fields using expressions.</p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={addComputedRow}
                    className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add calculated field
                  </button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200/80 dark:border-gdc-border">
                  <table className={opTable}>
                    <thead>
                      <tr className={opThRow}>
                        <th className={cn(opTh, 'min-w-[120px]')}>Field Name</th>
                        <th className={cn(opTh, 'min-w-[220px]')}>Expression</th>
                        <th className={cn(opTh, 'w-[96px]')}>Type</th>
                        <th className={cn(opTh, 'min-w-[140px]')}>Description</th>
                        <th className={cn(opTh, 'w-[72px]')}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {computedRows.map((row) => (
                        <tr key={row.id} className={opTr}>
                          <td className={opTd}>
                            <input
                              value={row.fieldName}
                              onChange={(e) => updateComputed(row.id, { fieldName: e.target.value })}
                              className="h-8 w-full rounded border border-transparent bg-transparent px-1 font-mono text-[12px] font-semibold focus:border-violet-400 focus:outline-none"
                              aria-label={`Computed field ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <input
                              value={row.expression}
                              onChange={(e) => updateComputed(row.id, { expression: e.target.value })}
                              className="h-8 w-full min-w-[200px] rounded border border-transparent bg-transparent px-1 font-mono text-[11px] text-slate-700 focus:border-violet-400 focus:outline-none dark:text-gdc-mutedStrong"
                              aria-label={`Expression for ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <span className={cn('inline-flex rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase', typeBadgeClass(row.type))}>
                              {row.type}
                            </span>
                          </td>
                          <td className={opTd}>
                            <input
                              value={row.description}
                              onChange={(e) => updateComputed(row.id, { description: e.target.value })}
                              className="h-8 w-full rounded border border-transparent bg-transparent px-1 text-[11px] focus:border-violet-400 focus:outline-none"
                              aria-label={`Description for ${row.fieldName}`}
                            />
                          </td>
                          <td className={opTd}>
                            <div className="flex items-center gap-0.5">
                              <button
                                type="button"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
                                aria-label={`Edit ${row.fieldName}`}
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeComputed(row.id)}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-700"
                                aria-label={`Delete ${row.fieldName}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : rulesTab === 'guided' ? (
              <EnrichmentRulesEditor
                rules={guidedRules}
                onChange={setGuidedRules}
                mappedKeysLower={runtimeMappedKeysLower}
                mappedSampleEvent={runtimeMappedSample}
                excludeRuleTypes={['lookup']}
                sectionTitle="Guided Enrichment rules"
                addMenuLabel="Add rule"
                data-testid="stream-enrichment-guided-editor"
              />
            ) : (
              <AdvancedTransformWorkspace
                stage="enrichment"
                sampleEvent={runtimeMappedEvents[0] ?? null}
                sampleEvents={runtimeMappedEvents}
                rules={advancedRules}
                onRulesChange={setAdvancedRules}
                enrichmentStatic={buildRuntimeEnrichmentPayload(
                  staticRows,
                  computedRows,
                  guidedRules,
                  guidedPassthrough,
                  emitGuidedAsTypeArray,
                  [],
                  enrichmentPassthrough,
                )}
                overridePolicy={enrichmentOverridePolicy}
                filterUiMode={rulesTab === 'expert' ? 'expert' : 'advanced'}
              />
            )}
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-24 xl:self-start">
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Enrichment Summary</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <SummaryTile label="Static Fields" value={summary.staticCount} />
              <SummaryTile label="Computed Fields" value={summary.computedCount} />
              <SummaryTile label="Guided Rules" value={summary.guidedCount} />
              <SummaryTile label="Advanced Rules" value={summary.advancedCount} />
              <SummaryTile label="Total Fields" value={summary.total} />
            </div>
          </section>

          <section ref={previewRef} className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Enrichment Preview</h3>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                  runtimePreviewLoading
                    ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                    : runtimePreviewError
                      ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                      : runtimePreviewRecord
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted',
                )}
              >
                {runtimePreviewLoading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                {runtimePreviewLoading
                  ? 'Runtime preview'
                  : runtimePreviewError
                    ? 'Preview failed'
                    : runtimePreviewRecord
                      ? 'Runtime verified'
                      : 'Sample required'}
              </span>
            </div>
            <div className="mt-2 flex gap-2 border-b border-slate-200/80 pb-2 dark:border-gdc-border">
              <button
                type="button"
                onClick={() => setPreviewTab('table')}
                className={cn(
                  'text-[12px] font-semibold',
                  previewTab === 'table' ? 'text-violet-700 dark:text-violet-300' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                Table View
              </button>
              <button
                type="button"
                onClick={() => setPreviewTab('json')}
                className={cn(
                  'text-[12px] font-semibold',
                  previewTab === 'json' ? 'text-violet-700 dark:text-violet-300' : 'text-slate-500 hover:text-slate-700',
                )}
              >
                JSON View
              </button>
            </div>
            {runtimePreviewError ? (
              <p className="mt-3 rounded-md border border-red-200/80 bg-red-500/[0.06] px-2.5 py-2 text-[11px] text-red-800 dark:border-red-500/30 dark:text-red-200">
                {runtimePreviewError}
              </p>
            ) : null}
            <div className="mt-3 max-h-[min(260px,40vh)] overflow-auto rounded-lg border border-slate-200/80 bg-slate-50/80 dark:border-gdc-border dark:bg-gdc-card">
              {runtimePreviewLoading ? (
                <div className="flex min-h-28 items-center justify-center gap-2 text-[11px] text-slate-500 dark:text-gdc-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Running enrichment runtime…
                </div>
              ) : runtimeMappedEvents.length === 0 ? (
                <p className="px-3 py-8 text-center text-[11px] text-slate-500 dark:text-gdc-muted">
                  No mapped sample event is available. Load or refresh the Stream source sample first.
                </p>
              ) : previewTab === 'table' ? (
                <table className="w-full border-collapse text-[11px]">
                  <tbody>
                    {Object.entries(previewRecord).map(([k, v]) => (
                      <tr key={k} className="border-b border-slate-100 last:border-0 dark:border-gdc-border">
                        <td className="px-2 py-1.5 font-mono font-semibold text-slate-700 dark:text-gdc-mutedStrong">{k}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-gdc-muted">{String(v)}</td>
                      </tr>
                    ))}
                    {Object.keys(previewRecord).length === 0 ? (
                      <tr>
                        <td className="px-3 py-8 text-center text-slate-500 dark:text-gdc-muted" colSpan={2}>
                          Runtime returned an empty event.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : (
                <pre className="p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-gdc-mutedStrong">{previewJson}</pre>
              )}
            </div>
            <button
              type="button"
              onClick={() => setPreviewTick((t) => t + 1)}
              className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-200/90 bg-white text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', runtimePreviewLoading && 'animate-spin')} aria-hidden />
              Refresh Runtime Preview
            </button>
          </section>

          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Next Steps</h3>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-[12px] text-slate-600 dark:text-gdc-muted">
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Configure Mapping</span> — align source payload to schema.
              </li>
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Configure Routes</span> — fan out to destinations.
              </li>
              <li>
                <span className="font-medium text-slate-800 dark:text-slate-200">Review & Create Stream</span> — validate runtime settings.
              </li>
            </ol>
          </section>

          <section className="rounded-xl border border-violet-200/80 bg-violet-500/[0.06] p-4 dark:border-violet-500/25 dark:bg-violet-500/10">
            <div className="flex gap-2">
              <Lightbulb className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
              <div>
                <p className="text-[12px] font-medium text-slate-800 dark:text-slate-200">Need help?</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                  Learn more about enrichment in our documentation.
                </p>
                <a
                  href="https://example.com/docs/enrichment"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                >
                  View Docs
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200/90 bg-white/95 px-3 py-2.5 backdrop-blur-md dark:border-gdc-border dark:bg-gdc-section">
        <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-2 lg:justify-between">
          <ol className="flex flex-wrap items-center justify-center gap-2">
            {WIZARD_STEPS.map((step, index) => {
              const done = index < ACTIVE_WIZARD_STEP
              const active = index === ACTIVE_WIZARD_STEP
              return (
                <li key={step.key} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full border text-[10px] font-bold',
                      done
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : active
                          ? 'border-violet-500/50 bg-violet-500/15 text-violet-700 dark:text-violet-300'
                          : 'border-slate-300 bg-white text-slate-500 dark:border-gdc-border dark:bg-gdc-card',
                    )}
                  >
                    {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : active ? <Circle className="h-3 w-3 fill-violet-600 text-violet-600" /> : index + 1}
                  </span>
                  <span
                    className={cn(
                      'hidden text-[10px] font-semibold sm:inline',
                      active ? 'text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-gdc-muted',
                    )}
                  >
                    {step.title}
                  </span>
                  {index < WIZARD_STEPS.length - 1 ? <ChevronRight className="hidden h-3 w-3 text-slate-300 lg:inline" aria-hidden /> : null}
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    </div>
  )
}
