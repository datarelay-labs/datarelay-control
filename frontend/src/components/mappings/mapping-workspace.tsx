import { AlertCircle, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AdvancedTransformWorkspace } from '../transform/advanced-transform-workspace'
import { useMappingPreview } from '../../hooks/useMappingPreview'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import { fieldMappingsFromRows } from '../../utils/mappingValidation'
import { resolveSourceTypePresentation } from '../../utils/sourceTypePresentation'
import {
  fetchMappingSourceSample,
  type MappingSourceSampleResult,
} from '../../utils/mappingSourceSample'
import {
  mergeValidationWarnings,
  suggestOutputField,
  validateMappingRowsLocal,
} from '../../utils/mappingValidation'
import { toEventRootRelativePath } from '../streams/wizard/wizard-json-extract'
import { MappingJsonTree, PanelChrome } from '../streams/mapping-json-tree'
import { UnionSchemaTreeDetailLayout } from '../streams/union-schema-tree-detail-layout'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import {
  applyInlineSamplesFromMapped,
  MappingBuilderTable,
} from './mapping-builder-table'
import { FinalEventPreviewPanel } from './final-event-preview-panel'

export type MappingWorkspaceProps = {
  streamId: number | null
  streamTitle: string
  connectorLabel: string
  sourceType: string | null
  initialRows: MappingRowModel[]
  enrichment: Record<string, unknown>
  eventArrayPath: string
  eventRootPath: string
  onRowsChange?: (rows: MappingRowModel[]) => void
  onEventArrayPathChange?: (path: string) => void
  transformRules?: AdvancedTransformRuleDraft[]
  onTransformRulesChange?: (rules: AdvancedTransformRuleDraft[]) => void
  headerSlot?: ReactNode
  /** Wizard / offline path: use in-memory sample instead of fetchMappingSourceSample(streamId). */
  externalSample?: MappingSourceSampleResult | null
  /** Hide Basic/Advanced/Expert tabs (parent owns mode switching). */
  hideModeTabs?: boolean
  /** Lock workspace to a single mode when hideModeTabs is set. */
  forceModeTab?: MappingModeTab
  /** Block mapping edits while leaving mode tabs and preview navigation usable. */
  readOnly?: boolean
}

type MappingModeTab = 'basic' | 'advanced' | 'expert'

function newRowId(): string {
  return `row-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
}

export function MappingWorkspace({
  streamId,
  streamTitle,
  connectorLabel,
  sourceType,
  initialRows,
  enrichment,
  eventArrayPath: initialEventArrayPath,
  eventRootPath: initialEventRootPath,
  onRowsChange,
  onEventArrayPathChange,
  transformRules = [],
  onTransformRulesChange,
  headerSlot,
  externalSample = null,
  hideModeTabs = false,
  forceModeTab,
  readOnly = false,
}: MappingWorkspaceProps) {
  const [modeTab, setModeTab] = useState<MappingModeTab>(forceModeTab ?? 'basic')
  const [rows, setRows] = useState<MappingRowModel[]>(() => [...initialRows])
  const [sample, setSample] = useState<MappingSourceSampleResult | null>(null)
  const [sampleLoading, setSampleLoading] = useState(false)
  const [treeSearch, setTreeSearch] = useState('')
  const [mappingSearch, setMappingSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dupNotice, setDupNotice] = useState<string | null>(null)
  const [eventArrayPath, setEventArrayPath] = useState(initialEventArrayPath)
  const [eventRootPath] = useState(initialEventRootPath)
  const [sampleEventIndex, setSampleEventIndex] = useState(0)
  const [selectedUnionPath, setSelectedUnionPath] = useState<string | null>(null)

  const presentation = useMemo(() => resolveSourceTypePresentation(sourceType), [sourceType])

  useEffect(() => {
    setRows([...initialRows])
  }, [initialRows])

  useEffect(() => {
    setEventArrayPath(initialEventArrayPath)
  }, [initialEventArrayPath])

  useEffect(() => {
    if (forceModeTab) setModeTab(forceModeTab)
  }, [forceModeTab])

  const activeModeTab = forceModeTab ?? modeTab

  const loadSample = useCallback(async () => {
    if (externalSample != null) {
      setSample(externalSample)
      setSampleEventIndex(0)
      return
    }
    if (streamId == null) return
    setSampleLoading(true)
    try {
      const res = await fetchMappingSourceSample(streamId)
      setSample(res)
      setSampleEventIndex(0)
    } finally {
      setSampleLoading(false)
    }
  }, [externalSample, streamId])

  useEffect(() => {
    void loadSample()
  }, [loadSample])

  useEffect(() => {
    if (externalSample != null) {
      setSample(externalSample)
      setSampleEventIndex(0)
    }
  }, [externalSample])

  const updateRows = useCallback(
    (next: MappingRowModel[]) => {
      if (readOnly) return
      setRows(next)
      onRowsChange?.(next)
    },
    [onRowsChange, readOnly],
  )

  const sampleEvent = sample?.extractedEvents?.[sampleEventIndex] ?? sample?.extractedEvents?.[0] ?? null
  const treeValue = sampleEvent ?? sample?.treeDocument ?? {}

  const preview = useMappingPreview({
    rawPayload: sample?.rawPayload ?? null,
    eventArrayPath,
    eventRootPath,
    rows,
    enrichment,
    enabled: Boolean(sample?.ok && sample.rawPayload != null),
  })

  const { warnings: localWarnings, rowIssues: baseRowIssues } = useMemo(() => validateMappingRowsLocal(rows), [rows])

  const rowIssues = useMemo(() => {
    const issues = new Map(baseRowIssues)
    const missing = preview.mapped?.missing_fields ?? []
    for (const row of rows) {
      const out = row.outputField.trim()
      const hit = missing.some((m) => m.output_field === out && m.event_index === sampleEventIndex)
      const prev = issues.get(row.id)
      if (prev) issues.set(row.id, { ...prev, emptyExtraction: hit })
    }
    return issues
  }, [baseRowIssues, preview.mapped?.missing_fields, rows, sampleEventIndex])

  const inlineSamples = useMemo(
    () => applyInlineSamplesFromMapped(rows, preview.mapped?.mapped_events?.[sampleEventIndex]),
    [rows, preview.mapped?.mapped_events, sampleEventIndex],
  )

  const mergedWarnings = useMemo(
    () => mergeValidationWarnings(localWarnings, preview.validationWarnings),
    [localWarnings, preview.validationWarnings],
  )

  const filteredRows = useMemo(() => {
    const q = mappingSearch.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        r.sourceJsonPath.toLowerCase().includes(q) ||
        r.outputField.toLowerCase().includes(q),
    )
  }, [rows, mappingSearch])

  const handlePickPath = useCallback(
    (jsonPath: string) => {
      const rel = toEventRootRelativePath(jsonPath, eventRootPath || '$')
      let duplicate = false
      updateRows(
        rows.some((r) => r.sourceJsonPath === rel)
          ? ((duplicate = true), rows)
          : [
              ...rows,
              {
                id: newRowId(),
                sourceJsonPath: rel,
                outputField: suggestOutputField(rel),
                type: 'string',
                origin: 'manual',
              },
            ],
      )
      if (duplicate) {
        setDupNotice(`Already mapped: ${rel}`)
        window.setTimeout(() => setDupNotice(null), 2800)
      }
    },
    [eventRootPath, rows, updateRows],
  )

  const handleReorder = useCallback(
    (from: number, to: number) => {
      if (from < 0 || to < 0 || from >= rows.length || to >= rows.length) return
      const next = [...rows]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      updateRows(next)
    },
    [rows, updateRows],
  )

  const simpleFieldMappings = useMemo(() => fieldMappingsFromRows(rows), [rows])

  const sourcePanelTitle = useMemo(() => {
    const t = presentation.displayName
    if (sample?.sourceType === 'DATABASE_QUERY') return `Source rows (${t})`
    if (sample?.sourceType === 'WEBHOOK_RECEIVER') return `Webhook payload (${t})`
    if (sample?.sourceType === 'S3_OBJECT_POLLING') return `Object sample (${t})`
    if (sample?.sourceType === 'REMOTE_FILE_POLLING') return `Parsed file rows (${t})`
    return `Source payload (${t})`
  }, [presentation.displayName, sample?.sourceType])

  const modeTabClass = (tab: MappingModeTab) =>
    activeModeTab === tab
      ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
      : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted'

  return (
    <div className="space-y-3">
      {headerSlot}

      {!hideModeTabs ? (
        <div className="flex flex-wrap gap-1 border-b border-slate-200/80 dark:border-gdc-border" role="tablist" aria-label="Mapping mode">
          <button type="button" role="tab" aria-selected={activeModeTab === 'basic'} className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('basic')}`} onClick={() => setModeTab('basic')}>
            Basic · JSONPath
          </button>
          <button type="button" role="tab" aria-selected={activeModeTab === 'advanced'} className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('advanced')}`} onClick={() => setModeTab('advanced')}>
            Advanced · JSONata
          </button>
          <button type="button" role="tab" aria-selected={activeModeTab === 'expert'} className={`-mb-px border-b-2 px-3 pb-2 text-[12px] font-semibold ${modeTabClass('expert')}`} onClick={() => setModeTab('expert')}>
            Expert · Regex extract
          </button>
        </div>
      ) : null}

      {activeModeTab !== 'basic' && onTransformRulesChange ? (
        <AdvancedTransformWorkspace
          stage="mapping"
          sampleEvent={sampleEvent}
          rules={transformRules}
          onRulesChange={onTransformRulesChange}
          readOnly={readOnly}
          simpleFieldMappings={simpleFieldMappings}
          filterUiMode={activeModeTab === 'expert' ? 'expert' : 'advanced'}
        />
      ) : null}

      {activeModeTab === 'basic' ? (
      <>
      {dupNotice ? (
        <p className="rounded-md border border-amber-200/80 bg-amber-500/[0.07] px-2.5 py-1.5 text-[12px] text-amber-950 dark:border-amber-500/30 dark:text-amber-100/90" role="status">
          {dupNotice}
        </p>
      ) : null}
      {sample?.message && !sample.ok ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-200/80 bg-amber-500/[0.07] px-2.5 py-1.5 text-[12px] text-amber-950 dark:border-amber-500/30 dark:text-amber-100/90" role="status">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {sample.message} Run {presentation.workflow.apiTestShortLabel} from stream settings if you need a fresh sample.
          </span>
        </p>
      ) : null}

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 xl:col-span-4">
          <PanelChrome
            title={sourcePanelTitle}
            right={
              <button
                type="button"
                onClick={() => void loadSample()}
                disabled={(streamId == null && externalSample == null) || sampleLoading}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
              >
                {sampleLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh sample
              </button>
            }
          >
            <div className="flex flex-col gap-2 p-2">
              <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
                {connectorLabel} · {streamTitle} · Click a field to add a mapping row. JSONPaths match the runtime parser.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[10px]">
                  <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Event array path</span>
                  <input
                    value={eventArrayPath}
                    disabled={readOnly}
                    onChange={(e) => {
                      if (readOnly) return
                      const v = e.target.value
                      setEventArrayPath(v)
                      onEventArrayPathChange?.(v)
                    }}
                    placeholder="$.data.items"
                    className="mt-0.5 h-7 w-full rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[10px] dark:border-gdc-border dark:bg-gdc-card"
                  />
                </label>
                <div className="text-[10px] text-slate-500">
                  <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Extracted events</span>
                  <p className="mt-1 tabular-nums font-semibold text-slate-800 dark:text-slate-100">{sample?.extractedEvents.length ?? 0}</p>
                </div>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  value={treeSearch}
                  onChange={(e) => setTreeSearch(e.target.value)}
                  placeholder="Search fields…"
                  className="h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/80 py-1 pl-8 pr-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
                />
              </div>
              <div className="relative flex max-h-[min(52vh,520px)] min-h-[200px] flex-col overflow-hidden rounded-md border border-slate-200/60 bg-slate-50/50 p-2 dark:border-gdc-border dark:bg-gdc-section">
                {sampleLoading ? (
                  <div className="flex min-h-[160px] items-center justify-center gap-2 text-[12px] text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading sample…
                  </div>
                ) : sample?.unionSchema ? (
                  <UnionSchemaTreeDetailLayout
                    className="min-h-0 flex-1"
                    schema={sample.unionSchema}
                    search={treeSearch}
                    onPickPath={readOnly ? () => undefined : handlePickPath}
                    selectedPath={selectedUnionPath}
                    onSelectPath={setSelectedUnionPath}
                  />
                ) : Object.keys(treeValue).length === 0 ? (
                  <p className="py-6 text-center text-[11px] text-slate-500">No sample loaded.</p>
                ) : (
                  <MappingJsonTree
                    value={treeValue}
                    baseLabel="event"
                    basePath="$"
                    search={treeSearch}
                    onPickPath={readOnly ? () => undefined : handlePickPath}
                    onUseEventArrayPath={
                      readOnly
                        ? undefined
                        : (p) => {
                            setEventArrayPath(p)
                            onEventArrayPathChange?.(p)
                          }
                    }
                    expandStrategy="smart"
                  />
                )}
              </div>
              <div className="flex flex-wrap gap-x-3 text-[11px] text-slate-600 dark:text-gdc-muted">
                <span>
                  Payload: <span className="font-semibold text-slate-900 dark:text-slate-100">{sample?.recordsLabel ?? '—'}</span>
                </span>
                <span>Refreshed: {sample?.fetchedAt ?? '—'}</span>
              </div>
            </div>
          </PanelChrome>
        </div>

        <div className="col-span-12 xl:col-span-4">
          <PanelChrome title={`Field mapping (${rows.length})`} className="max-h-[min(72vh,780px)]">
            <MappingBuilderTable
              rows={rows}
              filteredRows={filteredRows}
              rowIssues={rowIssues}
              inlineSamples={inlineSamples}
              editingId={editingId}
              onEditId={setEditingId}
              onUpdateRow={(id, patch) => updateRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))}
              onDeleteRow={(id) => {
                updateRows(rows.filter((r) => r.id !== id))
                if (editingId === id) setEditingId(null)
              }}
              onReorder={handleReorder}
              onAddBlank={() => {
                if (readOnly) return
                const id = newRowId()
                updateRows([...rows, { id, sourceJsonPath: '', outputField: '', type: 'string', origin: 'manual' }])
                setEditingId(id)
              }}
              search={mappingSearch}
              onSearchChange={setMappingSearch}
              readOnly={readOnly}
            />
          </PanelChrome>
        </div>

        <div className="col-span-12 xl:col-span-4">
          <FinalEventPreviewPanel
            preview={preview}
            rawSampleEvent={sampleEvent}
            eventCount={sample?.extractedEvents.length ?? preview.mapped?.preview_event_count ?? 1}
            sampleEventIndex={sampleEventIndex}
            onSampleIndexChange={setSampleEventIndex}
            onRefresh={preview.refresh}
            localWarnings={mergedWarnings}
          />
        </div>
      </div>
      </>
      ) : null}
    </div>
  )
}

/** Export rows from workspace for save handlers. */
export function useMappingWorkspaceRows(initial: MappingRowModel[]) {
  return useState<MappingRowModel[]>(initial)
}
