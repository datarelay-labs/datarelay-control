import { Check, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { StatusBadge } from '../shell/status-badge'
import {
  emptyStreamMappingPageState,
  type EnrichmentRowModel,
  type MappingRowModel,
} from './stream-mapping-model'
import { StreamWorkflowSummaryStrip } from './stream-workflow-checklist'
import { computeStreamWorkflow } from '../../utils/streamWorkflow'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import {
  buildFieldMappingsWithTransformRules,
  extractPreservedFieldMappingMetadata,
  parseTransformRulesFromFieldMappings,
} from '../../utils/advancedTransformConfig'
import { rowsFromFieldMappings } from '../../utils/mappingFieldMappings'
import { loadMappingWorkspaceContext } from '../../utils/mappingSourceSample'
import { fieldMappingsFromRows } from '../../utils/mappingValidation'
import { MappingWorkspace } from '../mappings/mapping-workspace'
import { PanelChrome } from './mapping-json-tree'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

function enrichmentRecordToRows(rec: Record<string, unknown>): EnrichmentRowModel[] {
  return Object.entries(rec)
    .filter(([field, value]) => {
      if (field === '__computed' || field === 'advanced_fields' || field === '__rules') return false
      if (field.startsWith('__')) return false
      return value === null || typeof value !== 'object'
    })
    .map(([field, value]) => {
      const s = typeof value === 'string' ? value : JSON.stringify(value)
      const fn = s.includes('{{') && s.includes('}}')
      return { field, value: s, type: fn ? ('function' as const) : ('static' as const) }
    })
}

type StepKey = 'source' | 'mapping' | 'enrichment' | 'preview'

const STEP_ORDER: readonly StepKey[] = ['source', 'mapping', 'enrichment', 'preview']

function Stepper({
  active,
  mappedCount,
  enrichmentCount,
  sourceHint,
}: {
  active: StepKey
  mappedCount: number
  enrichmentCount: number
  sourceHint: string
}) {
  const idx = STEP_ORDER.indexOf(active)
  const labels: Record<StepKey, { title: string; hint: string }> = {
    source: { title: 'Source sample', hint: sourceHint },
    mapping: { title: 'Mapping', hint: `${mappedCount} fields mapped` },
    enrichment: { title: 'Enrichment', hint: `${enrichmentCount} fields` },
    preview: { title: 'Preview', hint: 'Backend pipeline preview' },
  }

  return (
    <nav aria-label="Mapping workflow" className="flex flex-wrap gap-2 rounded-lg border border-slate-200/70 bg-white/90 px-2 py-2 dark:border-gdc-border dark:bg-gdc-card">
      {STEP_ORDER.map((key, i) => {
        const done = i < idx
        const current = i === idx
        const pending = i > idx
        return (
          <div
            key={key}
            className={cn(
              'flex min-w-[140px] flex-1 items-start gap-2 rounded-md px-2 py-1.5',
              current && 'bg-violet-500/[0.07] ring-1 ring-violet-200/70 dark:bg-violet-500/[0.09] dark:ring-violet-500/25',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                done && 'bg-emerald-500 text-white',
                current && !done && 'bg-violet-600 text-white',
                pending && 'border border-slate-200 bg-slate-50 text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted',
              )}
              aria-hidden
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <div className="min-w-0">
              <p className={cn('text-[11px] font-semibold', current ? 'text-violet-900 dark:text-violet-100' : 'text-slate-800 dark:text-slate-100')}>
                {labels[key].title}
              </p>
              <p className="truncate text-[10px] text-slate-500 dark:text-gdc-muted">{labels[key].hint}</p>
            </div>
          </div>
        )
      })}
    </nav>
  )
}

export function StreamMappingPage() {
  const { streamId = '' } = useParams<{ streamId: string }>()
  const backendStreamId = useMemo(() => (/^\d+$/.test(streamId) ? Number(streamId) : null), [streamId])
  const emptyShell = useMemo(() => emptyStreamMappingPageState(streamId), [streamId])

  const [rows, setRows] = useState<MappingRowModel[]>([])
  const [transformRules, setTransformRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [preservedFieldMappings, setPreservedFieldMappings] = useState<Record<string, unknown>>({})
  const [rawEnrichment, setRawEnrichment] = useState<Record<string, unknown>>({})
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(true)
  const [enrichmentOverridePolicy, setEnrichmentOverridePolicy] = useState<
    'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  >('KEEP_EXISTING')
  const [enrichment, setEnrichment] = useState<EnrichmentRowModel[]>([])
  const [streamTitle, setStreamTitle] = useState(emptyShell.streamName)
  const [connectorLabel, setConnectorLabel] = useState(emptyShell.connectorName)
  const [streamStatusUi, setStreamStatusUi] = useState(String(emptyShell.status))
  const [mappingSourceType, setMappingSourceType] = useState<string | null>(null)
  const [eventArrayPath, setEventArrayPath] = useState('')
  const [eventRootPath, setEventRootPath] = useState('')
  const [rawPayloadMode, setRawPayloadMode] = useState<string | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState('[]')
  const activeStep: StepKey = 'mapping'

  const baselineRowsRef = useRef<MappingRowModel[] | null>(null)
  const baselineTransformRef = useRef<AdvancedTransformRuleDraft[]>([])
  const baselineEventArrayPathRef = useRef('')
  const baselineEventRootPathRef = useRef('')

  useEffect(() => {
    let cancelled = false
    if (backendStreamId == null) {
      setRows([])
      setTransformRules([])
      setPreservedFieldMappings({})
      setRawEnrichment({})
      setRawPayloadMode(null)
      setEnrichmentEnabled(true)
      setEnrichmentOverridePolicy('KEEP_EXISTING')
      setEnrichment([...emptyShell.enrichment])
      setStreamTitle(emptyShell.streamName)
      setConnectorLabel('—')
      return
    }
    setConfigLoading(true)
    void loadMappingWorkspaceContext(backendStreamId)
      .then((ctx) => {
        if (cancelled || !ctx) return
        const { stream, cfg, connectorName, sample } = ctx
        setStreamTitle(cfg.stream_name || stream.name || `Stream ${backendStreamId}`)
        setStreamStatusUi(String(cfg.stream_status || stream.status || 'RUNNING'))
        setMappingSourceType(cfg.source_type ?? stream.stream_type ?? null)
        setConnectorLabel(connectorName)
        setEventArrayPath(String(cfg.mapping?.event_array_path ?? sample.eventArrayPath ?? ''))
        setEventRootPath(String(cfg.mapping?.event_root_path ?? sample.eventRootPath ?? ''))
        setRawPayloadMode(cfg.mapping?.raw_payload_mode ?? null)
        const fm = (cfg.mapping?.field_mappings ?? {}) as Record<string, unknown>
        const mappingRows = Object.keys(fm).length > 0 ? rowsFromFieldMappings(fm) : []
        setRows(mappingRows)
        setTransformRules(parseTransformRulesFromFieldMappings(fm))
        setPreservedFieldMappings(extractPreservedFieldMappingMetadata(fm))
        const en = (cfg.enrichment?.enrichment ?? {}) as Record<string, unknown>
        setRawEnrichment(en)
        setEnrichmentEnabled(cfg.enrichment?.enabled !== false)
        const policy = cfg.enrichment?.override_policy
        setEnrichmentOverridePolicy(
          policy === 'OVERRIDE' || policy === 'ERROR_ON_CONFLICT' || policy === 'KEEP_EXISTING'
            ? policy
            : 'KEEP_EXISTING',
        )
        setEnrichment(
          cfg.enrichment?.exists && Object.keys(en).length > 0 ? enrichmentRecordToRows(en) : [],
        )
        const loadedRules = parseTransformRulesFromFieldMappings(fm)
        baselineRowsRef.current = mappingRows.map((r) => ({ ...r }))
        baselineTransformRef.current = loadedRules.map((r) => ({ ...r }))
        baselineEventArrayPathRef.current = String(cfg.mapping?.event_array_path ?? sample.eventArrayPath ?? '')
        baselineEventRootPathRef.current = String(cfg.mapping?.event_root_path ?? sample.eventRootPath ?? '')
        setSavedSnapshot(
          JSON.stringify({
            rows: mappingRows,
            transformRules: loadedRules,
            eventArrayPath: baselineEventArrayPathRef.current,
            eventRootPath: baselineEventRootPathRef.current,
          }),
        )
        setSaveError(null)
        setSaveSuccess(null)
      })
      .finally(() => {
        if (!cancelled) setConfigLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [streamId, backendStreamId, emptyShell.enrichment, emptyShell.streamName])

  const hasUnsavedChanges =
    JSON.stringify({ rows, transformRules, eventArrayPath, eventRootPath }) !== savedSnapshot

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
        hasMapping: rows.length > 0 || transformRules.some((rule) => rule.outputField.trim()) || Object.keys(preservedFieldMappings).length > 0,
        hasEnrichment: enrichmentEnabled && Object.keys(rawEnrichment).length > 0,
        sourceType: mappingSourceType,
      }),
    [
      streamId,
      rows.length,
      transformRules,
      preservedFieldMappings,
      rawEnrichment,
      enrichmentEnabled,
      mappingSourceType,
    ],
  )

  async function handleSaveMapping() {
    if (isSaving) return
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    const rowsWithMapping = rows.filter((r) => r.outputField.trim() !== '' && r.sourceJsonPath.trim() !== '')
    const rulesWithOutput = transformRules.filter((r) => r.outputField.trim())
    if (backendStreamId == null) {
      setSavedSnapshot(JSON.stringify({ rows, transformRules, eventArrayPath, eventRootPath }))
      baselineRowsRef.current = rows.map((r) => ({ ...r }))
      baselineTransformRef.current = transformRules.map((r) => ({ ...r }))
      baselineEventArrayPathRef.current = eventArrayPath
      baselineEventRootPathRef.current = eventRootPath
      setSaveSuccess('Saved locally (preview only) · numeric stream id required for API-backed save.')
      setIsSaving(false)
      return
    }
    if (
      rowsWithMapping.length === 0 &&
      rulesWithOutput.length === 0 &&
      Object.keys(preservedFieldMappings).length === 0
    ) {
      setSaveError('Add at least one Basic mapping row or Advanced Transform rule before saving.')
      setIsSaving(false)
      return
    }
    try {
      const simpleMappings = fieldMappingsFromRows(rowsWithMapping)
      const fieldMappings = {
        ...preservedFieldMappings,
        ...buildFieldMappingsWithTransformRules(simpleMappings, transformRules),
      }
      const result = await saveStreamMappingUiConfigStrict(backendStreamId, {
        mapping: {
          field_mappings: fieldMappings,
          event_array_path: eventArrayPath || null,
          event_root_path: eventRootPath || null,
          raw_payload_mode: rawPayloadMode,
        },
      })
      setSavedSnapshot(JSON.stringify({ rows, transformRules, eventArrayPath, eventRootPath }))
      baselineRowsRef.current = rows.map((r) => ({ ...r }))
      baselineTransformRef.current = transformRules.map((r) => ({ ...r }))
      baselineEventArrayPathRef.current = eventArrayPath
      baselineEventRootPathRef.current = eventRootPath
      setSaveSuccess(`API-backed · ${result.message}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Mapping save failed.'
      setSaveError(`API save failed: ${message}`)
    } finally {
      setIsSaving(false)
    }
  }

  const statusTone: 'success' | 'warning' | 'error' | 'neutral' | 'info' =
    streamStatusUi === 'ERROR' ? 'error' : streamStatusUi === 'STOPPED' || streamStatusUi === 'PAUSED' ? 'neutral' : streamStatusUi === 'DEGRADED' ? 'warning' : 'success'

  const resetMapping = useCallback(() => {
    const br = baselineRowsRef.current
    setRows(br ? [...br] : [])
    setTransformRules(baselineTransformRef.current.map((r) => ({ ...r })))
    setEventArrayPath(baselineEventArrayPathRef.current)
    setEventRootPath(baselineEventRootPathRef.current)
  }, [])

  if (configLoading && backendStreamId != null) {
    return (
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-[13px] text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        Loading mapping workspace…
      </div>
    )
  }

  return (
    <div className="w-full min-w-0 space-y-3">
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-3 dark:border-gdc-border lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Mapping</h2>
            <StatusBadge tone={statusTone} className="font-bold uppercase tracking-wide">
              {String(streamStatusUi || 'RUNNING').toUpperCase()}
            </StatusBadge>
          </div>
          <p className="text-[13px] text-slate-600 dark:text-gdc-muted">
            Preview-first field mapping with runtime-backed validation and final event preview.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="inline-flex h-8 items-center rounded-full border border-slate-200/90 bg-slate-50 px-2.5 text-[11px] font-semibold text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200">
            {isSaving ? 'Saving…' : saveError ? 'Save failed' : saveSuccess ? 'Saved' : hasUnsavedChanges ? 'Unsaved changes' : 'Saved'}
          </span>
          <button
            type="button"
            onClick={() => void handleSaveMapping()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
          >
            {isSaving ? 'Saving…' : 'Save Mapping'}
          </button>
        </div>
      </div>
      {saveError ? <p className="text-[12px] font-medium text-red-700 dark:text-red-300">{saveError}</p> : null}
      {saveSuccess ? <p className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">{saveSuccess}</p> : null}

      <StreamWorkflowSummaryStrip snapshot={workflowSnapshot} activeStep="mapping" highlightCompleted={['connector', 'apiTest']} />

      <Stepper
        active={activeStep}
        mappedCount={rows.length}
        enrichmentCount={enrichment.length}
        sourceHint={backendStreamId != null ? 'Live source sample' : 'No stream id'}
      />

      <MappingWorkspace
        streamId={backendStreamId}
        streamTitle={streamTitle}
        connectorLabel={connectorLabel}
        sourceType={mappingSourceType}
        initialRows={rows}
        enrichment={enrichmentEnabled ? rawEnrichment : {}}
        enrichmentOverridePolicy={enrichmentOverridePolicy}
        eventArrayPath={eventArrayPath}
        eventRootPath={eventRootPath}
        onRowsChange={setRows}
        onEventArrayPathChange={setEventArrayPath}
        transformRules={transformRules}
        onTransformRulesChange={setTransformRules}
        preservedFieldMappings={preservedFieldMappings}
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 lg:col-span-6">
          <PanelChrome title={`Enrichment (${enrichment.length})`}>
            <div className="overflow-x-auto p-2">
              <table className={opTable}>
                <thead>
                  <tr className={opThRow}>
                    <th className={opTh}>Field</th>
                    <th className={opTh}>Value</th>
                    <th className={opTh}>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichment.map((row) => (
                    <tr key={row.field} className={opTr}>
                      <td className={opTd}>{row.field}</td>
                      <td className={cn(opTd, 'max-w-[200px] truncate font-mono text-[11px]')}>{row.value}</td>
                      <td className={opTd}>{row.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-slate-500">Enrichment is separate from mapping. Edit enrichment on the stream enrichment step.</p>
            </div>
          </PanelChrome>
        </div>
        <div className="col-span-12 lg:col-span-6 flex items-end">
          <button
            type="button"
            onClick={resetMapping}
            className="inline-flex h-8 items-center rounded-md border border-slate-200/90 px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-200"
          >
            Reset mapping to last saved
          </button>
        </div>
      </div>
    </div>
  )
}
