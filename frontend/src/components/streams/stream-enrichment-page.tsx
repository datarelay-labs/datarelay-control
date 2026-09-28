import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  Eye,
  Lightbulb,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { NAV_PATH } from '../../config/nav-paths'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import {
  type ComputedFieldRow,
  type OverridePolicy,
  type StaticFieldRow,
  DEFAULT_COMPUTED_FIELDS,
  DEFAULT_STATIC_FIELDS,
  buildEnrichedPreviewRecord,
} from './stream-enrichment-model'
import { StreamWorkflowSummaryStrip } from './stream-workflow-checklist'
import { computeStreamWorkflow } from '../../utils/streamWorkflow'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import { AdvancedTransformWorkspace } from '../transform/advanced-transform-workspace'
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

export function StreamEnrichmentPage() {
  const { streamId = 'malop-api' } = useParams<{ streamId: string }>()
  const navigate = useNavigate()
  const previewRef = useRef<HTMLDivElement>(null)
  const backendStreamId = useMemo(() => (/^\d+$/.test(streamId) ? Number(streamId) : null), [streamId])

  const [rulesTab, setRulesTab] = useState<'static' | 'computed' | 'advanced' | 'expert'>('static')
  const [advancedRules, setAdvancedRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [sampleEvent, setSampleEvent] = useState<Record<string, unknown> | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [previewTab, setPreviewTab] = useState<'table' | 'json'>('table')
  const [staticSearch, setStaticSearch] = useState('')
  const [staticRows, setStaticRows] = useState<StaticFieldRow[]>(() => [...DEFAULT_STATIC_FIELDS])
  const [computedRows, setComputedRows] = useState<ComputedFieldRow[]>(() => [...DEFAULT_COMPUTED_FIELDS])
  const [previewTick, setPreviewTick] = useState(0)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
    JSON.stringify({ staticRows: DEFAULT_STATIC_FIELDS, computedRows: DEFAULT_COMPUTED_FIELDS, advancedRules: [] }),
  )

  useEffect(() => {
    let cancelled = false
    if (backendStreamId == null) return
    setConfigLoading(true)
    void loadMappingWorkspaceContext(backendStreamId)
      .then((ctx) => {
        if (cancelled || !ctx) return
        const en = (ctx.cfg.enrichment?.enrichment ?? {}) as Record<string, unknown>
        const loadedAdvanced = parseAdvancedFieldsFromEnrichment(en)
        setAdvancedRules(loadedAdvanced)

        const staticFromApi: StaticFieldRow[] = []
        for (const [key, value] of Object.entries(en)) {
          if (key.startsWith('__') || key === 'advanced_fields') continue
          if (value && typeof value === 'object' && ('type' in value || 'mode' in value)) continue
          staticFromApi.push({
            id: `sf-api-${key}`,
            fieldName: key,
            value: typeof value === 'string' ? value : JSON.stringify(value),
            type: 'string',
            description: '',
            overridePolicy: 'missing',
          })
        }
        if (staticFromApi.length > 0) setStaticRows(staticFromApi)

        const ev = ctx.sample.extractedEvents[0]
        setSampleEvent(ev && typeof ev === 'object' ? (ev as Record<string, unknown>) : null)
        setSavedSnapshot(
          JSON.stringify({
            staticRows: staticFromApi.length > 0 ? staticFromApi : DEFAULT_STATIC_FIELDS,
            computedRows: DEFAULT_COMPUTED_FIELDS,
            advancedRules: loadedAdvanced,
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
    const overrideAlways = staticRows.filter((r) => r.overridePolicy === 'always').length
    return {
      staticCount,
      computedCount,
      total: staticCount + computedCount,
      overrideAlways,
    }
  }, [staticRows, computedRows])

  const previewRecord = useMemo(() => {
    void previewTick
    return buildEnrichedPreviewRecord(staticRows, computedRows)
  }, [staticRows, computedRows, previewTick])

  const previewJson = useMemo(() => JSON.stringify(previewRecord, null, 2), [previewRecord])

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

  const hasUnsavedChanges = JSON.stringify({ staticRows, computedRows, advancedRules }) !== savedSnapshot

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
        hasEnrichment: staticRows.length + computedRows.length > 0,
      }),
    [streamId, staticRows.length, computedRows.length],
  )

  async function handleSaveEnrichment() {
    if (isSaving) return
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    if (backendStreamId == null) {
      setSavedSnapshot(JSON.stringify({ staticRows, computedRows, advancedRules }))
      setSaveSuccess('Saved locally for preview only. Save to the stream after it has been created.')
      setIsSaving(false)
      return
    }
    try {
      const enrichmentDict: Record<string, unknown> = {}
      for (const row of staticRows) {
        if (!row.fieldName.trim()) continue
        enrichmentDict[row.fieldName] = row.value
      }
      if (computedRows.length > 0) {
        const computed: Record<string, { expression: string; type: string; description?: string }> = {}
        for (const row of computedRows) {
          if (!row.fieldName.trim()) continue
          computed[row.fieldName] = {
            expression: row.expression,
            type: row.type,
            description: row.description,
          }
        }
        if (Object.keys(computed).length > 0) {
          enrichmentDict.__computed = computed
        }
      }
      const enrichmentPayload = buildEnrichmentWithAdvancedFields(enrichmentDict, advancedRules)
      const result = await saveStreamMappingUiConfigStrict(backendStreamId, {
        enrichment: {
          enabled: true,
          enrichment: enrichmentPayload,
          override_policy: 'KEEP_EXISTING',
        },
      })
      setSavedSnapshot(JSON.stringify({ staticRows, computedRows, advancedRules }))
      setSaveSuccess(`Saved · ${result.message}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to save transform rules.'
      setSaveError(`Unable to save changes: ${message}`)
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
            onClick={() => navigate(NAV_PATH.routes)}
            className="inline-flex h-9 items-center gap-1 rounded-md bg-violet-600 px-4 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
          >
            Save & Continue
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
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
                            Override Policy
                            <HelpTooltip
                              content="Apply if missing keeps mapped values; Override always replaces them."
                              ariaLabel="Override policy help"
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
                            <select
                              value={row.overridePolicy}
                              onChange={(e) => updateStatic(row.id, { overridePolicy: e.target.value as OverridePolicy })}
                              className="h-8 w-full max-w-[160px] rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-medium dark:border-gdc-border dark:bg-gdc-card"
                              aria-label={`Override policy for ${row.fieldName}`}
                            >
                              <option value="missing">Apply if missing</option>
                              <option value="always">Override always</option>
                            </select>
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
            ) : (
              <AdvancedTransformWorkspace
                stage="enrichment"
                sampleEvent={sampleEvent}
                rules={advancedRules}
                onRulesChange={setAdvancedRules}
                enrichmentStatic={Object.fromEntries(
                  staticRows.filter((r) => r.fieldName.trim()).map((r) => [r.fieldName, r.value]),
                )}
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
              <SummaryTile label="Total Fields" value={summary.total} />
              <SummaryTile label="Override (Always)" value={summary.overrideAlways} />
            </div>
          </section>

          <section ref={previewRef} className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Enrichment Preview</h3>
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
            <div className="mt-3 max-h-[min(260px,40vh)] overflow-auto rounded-lg border border-slate-200/80 bg-slate-50/80 dark:border-gdc-border dark:bg-gdc-card">
              {previewTab === 'table' ? (
                <table className="w-full border-collapse text-[11px]">
                  <tbody>
                    {Object.entries(previewRecord).map(([k, v]) => (
                      <tr key={k} className="border-b border-slate-100 last:border-0 dark:border-gdc-border">
                        <td className="px-2 py-1.5 font-mono font-semibold text-slate-700 dark:text-gdc-mutedStrong">{k}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-gdc-muted">{String(v)}</td>
                      </tr>
                    ))}
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
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh Preview
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
