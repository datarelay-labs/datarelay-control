import {
  ChevronDown,
  ChevronUp,
  Copy,
  Layers,
  Maximize2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wand2,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { resolveJsonPath } from '../mapping-jsonpath'
import { MappingJsonTree, PanelChrome, type MappingJsonTreeExpandStrategy } from '../mapping-json-tree'
import {
  COMMON_DEST_FIELDS,
  DestinationFieldChip,
  loadRecentDestinations,
  RECENT_DEST_LIMIT,
  saveRecentDestinations,
} from './destination-field-chip'
import { MetadataMappingMenu } from './metadata-mapping-menu'
import { UnionSchemaTreeDetailLayout } from '../union-schema-tree-detail-layout'
import { buildRepresentativeEventFromUnionSchema } from '../../../utils/unionSchema'
import {
  getUnionSchemaSampleStatus,
  resolveUnionSchemaSampleCount,
} from '../../../utils/unionSchemaSamplePolicy'
import { UnionSchemaSamplePolicyBanner } from './union-schema-sample-policy-banner'
import { flattenSampleFields } from './wizard-json-extract'
import { applyAutoSuggestTopLevel } from './wizard-mapping-merge'
import type { WizardMappingRow, WizardState, WizardUnmappedFieldsPolicy } from './wizard-state'
import { WizardMappingOutputAside } from './wizard-mapping-output-aside'

const SUGGESTED_FIELD_GROUPS: ReadonlyArray<{ title: string; names: readonly string[] }> = [
  {
    title: 'Common Fields',
    names: ['message', 'severity', 'title', 'description', 'event_type', 'category', 'type', 'name'],
  },
  {
    title: 'Identifiers',
    names: ['id', '_id', 'event_id', 'uuid', 'guid', 'anomaly_id', 'src_ip', 'dst_ip', 'host', 'hostname'],
  },
  {
    title: 'Timestamps',
    names: ['timestamp', '@timestamp', 'time', 'created_at', 'updated_at', 'event_time', 'ts'],
  },
]

function suggestOutputField(jsonPath: string): string {
  const segments = jsonPath.split(/[.[\]]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? 'field'
  return last.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || 'field'
}

function relativeToRootPath(jsonPath: string, rootPath: string): string {
  const rp = rootPath.trim()
  if (!rp || rp === '$') return jsonPath
  const rootPrefix = rp.startsWith('$') ? rp : `$.${rp}`
  if (jsonPath === rootPrefix) return '$'
  if (jsonPath.startsWith(`${rootPrefix}.`) || jsonPath.startsWith(`${rootPrefix}[`)) {
    const rest = jsonPath.slice(rootPrefix.length)
    const stripped = rest.replace(/^\[\d+\]/, '')
    return stripped ? `$${stripped}` : '$'
  }
  return jsonPath
}

function newRowId(): string {
  return `row-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
}

function formatEventArrayLabel(state: WizardState): string {
  if (state.stream.useWholeResponseAsEvent) return '(whole response)'
  const p = state.stream.eventArrayPath.trim()
  if (!p) return '$'
  return p.startsWith('$') ? p : `$.${p}`
}

function inferValueType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'object') return 'object'
  return t
}

function truncatePreview(v: unknown, max = 56): string {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  if (typeof v === 'string') {
    return v.length > max ? `${v.slice(0, max)}…` : v
  }
  try {
    const s = JSON.stringify(v)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return String(v)
  }
}

function findSuggestionPath(suggestionName: string, flatPaths: string[]): string | null {
  const want = suggestionName.replace(/^@/, '').toLowerCase()
  const snLower = suggestionName.toLowerCase()
  const exact = flatPaths.find((p) => {
    const seg = p.split(/[.[\]]/).filter(Boolean).pop()
    if (!seg) return false
    const sl = seg.toLowerCase().replace(/^@/, '')
    return sl === want || seg.toLowerCase() === snLower
  })
  return exact ?? null
}

export type WizardBasicMappingPanelProps = {
  state: WizardState
  onChangeMapping: (rows: WizardMappingRow[]) => void
  onChangeUnmappedFieldsPolicy?: (policy: WizardUnmappedFieldsPolicy) => void
  showOutputAside?: boolean
}

export function WizardBasicMappingPanel({
  state,
  onChangeMapping,
  onChangeUnmappedFieldsPolicy,
  showOutputAside = true,
}: WizardBasicMappingPanelProps) {
  const [sampleView, setSampleView] = useState<'tree' | 'json'>('tree')
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null)
  const [flashRowId, setFlashRowId] = useState<string | null>(null)
  const [treeExpandStrategy, setTreeExpandStrategy] = useState<MappingJsonTreeExpandStrategy>('smart')
  const [treeMountKey, setTreeMountKey] = useState(0)
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(false)
  const [mappingSearch, setMappingSearch] = useState('')
  const [recentCustomFields, setRecentCustomFields] = useState<string[]>(() => loadRecentDestinations())
  const [selectedUnionPath, setSelectedUnionPath] = useState<string | null>(null)

  const registerCustomField = useCallback((name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setRecentCustomFields((prev) => {
      const next = [trimmed, ...prev.filter((n) => n !== trimmed)].slice(0, RECENT_DEST_LIMIT)
      saveRecentDestinations(next)
      return next
    })
  }, [])

  const sampleEvent = state.apiTest.extractedEvents[0] ?? null
  const unionSchema = state.apiTest.unionSchema
  const samplePolicy = getUnionSchemaSampleStatus(
    resolveUnionSchemaSampleCount({
      unionSchema,
      eventCount: state.apiTest.eventCount,
      extractedEvents: state.apiTest.extractedEvents,
    }),
  )
  const rootPath = state.stream.eventRootPath.trim() || '$'
  const quickFields = useMemo(() => {
    if (unionSchema?.fields.length) {
      return unionSchema.fields.map((f) => f.field_path)
    }
    const fromAnalysis = state.apiTest.analysis?.flatPreviewFields
    if (fromAnalysis?.length) return fromAnalysis
    return flattenSampleFields(sampleEvent)
  }, [sampleEvent, state.apiTest.analysis?.flatPreviewFields, unionSchema])

  const flashHighlightPath = useMemo(() => {
    const row = state.mapping.find((r) => r.id === flashRowId)
    return row?.sourceJsonPath.trim() ?? null
  }, [flashRowId, state.mapping])

  const bumpFlash = useCallback((rowId: string) => {
    setFlashRowId(rowId)
    window.setTimeout(() => setFlashRowId(null), 2800)
  }, [])

  const handlePickPath = useCallback(
    (jsonPath: string) => {
      const relPath = relativeToRootPath(jsonPath, rootPath)
      let duplicate = false
      const next = [...state.mapping]
      if (next.some((m) => m.sourceJsonPath === relPath)) {
        duplicate = true
      } else {
        const id = newRowId()
        next.push({
          id,
          outputField: suggestOutputField(relPath),
          sourceJsonPath: relPath,
        })
        bumpFlash(id)
      }
      if (duplicate) {
        setDuplicateNotice(`Already mapped: ${relPath}`)
        window.setTimeout(() => setDuplicateNotice(null), 2500)
        return
      }
      setDuplicateNotice(null)
      onChangeMapping(next)
    },
    [rootPath, onChangeMapping, state.mapping, bumpFlash],
  )

  const autoSuggest = useCallback(() => {
    if (!sampleEvent || typeof sampleEvent !== 'object' || Array.isArray(sampleEvent)) return
    onChangeMapping(
      applyAutoSuggestTopLevel(state.mapping, sampleEvent as Record<string, unknown>, newRowId),
    )
  }, [onChangeMapping, sampleEvent, state.mapping])

  const resetMapping = useCallback(() => {
    if (state.mapping.length === 0) return
    if (!window.confirm('Clear all field mappings?')) return
    onChangeMapping([])
    setDuplicateNotice(null)
  }, [onChangeMapping, state.mapping.length])

  const clearAllRows = useCallback(() => {
    resetMapping()
  }, [resetMapping])

  const duplicateOutputKeys = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of state.mapping) {
      const k = row.outputField.trim().toLowerCase()
      if (!k) continue
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const dups = new Set<string>()
    for (const [k, n] of counts) {
      if (n > 1) dups.add(k)
    }
    return dups
  }, [state.mapping])

  const rowWarnings = useMemo(() => {
    const map = new Map<string, { dup: boolean; missing: boolean }>()
    if (!sampleEvent) return map
    for (const row of state.mapping) {
      const key = row.outputField.trim().toLowerCase()
      const dup = key ? duplicateOutputKeys.has(key) : false
      const path = row.sourceJsonPath.trim()
      let missing = false
      if (path) {
        const v = resolveJsonPath(sampleEvent, path)
        missing = v === undefined || v === null
      }
      map.set(row.id, { dup, missing })
    }
    return map
  }, [sampleEvent, state.mapping, duplicateOutputKeys])

  const mappedCount = useMemo(
    () => state.mapping.filter((r) => r.outputField.trim() && r.sourceJsonPath.trim()).length,
    [state.mapping],
  )

  const rawSampleJson = useMemo(() => {
    if (!sampleEvent) return ''
    try {
      return JSON.stringify(sampleEvent, null, 2)
    } catch {
      return ''
    }
  }, [sampleEvent])

  const handleSuggestedChip = useCallback(
    (name: string) => {
      const path = findSuggestionPath(name, quickFields)
      if (!path) return
      handlePickPath(path)
    },
    [quickFields, handlePickPath],
  )

  const duplicateRow = useCallback(
    (idx: number) => {
      const row = state.mapping[idx]
      if (!row) return
      const next = [...state.mapping]
      next.splice(idx + 1, 0, {
        id: newRowId(),
        outputField: `${row.outputField}_copy`,
        sourceJsonPath: row.sourceJsonPath,
      })
      onChangeMapping(next)
    },
    [onChangeMapping, state.mapping],
  )

  const expandAll = useCallback(() => {
    setTreeExpandStrategy('all')
    setTreeMountKey((k) => k + 1)
  }, [])

  const collapseAll = useCallback(() => {
    setTreeExpandStrategy('minimal')
    setTreeMountKey((k) => k + 1)
  }, [])

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={autoSuggest}
          disabled={!sampleEvent}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-300/70 bg-white px-3 text-[12px] font-semibold text-violet-700 shadow-sm hover:bg-violet-500/[0.08] disabled:opacity-60 dark:border-violet-500/40 dark:bg-gdc-card dark:text-violet-300 dark:hover:bg-violet-500/15"
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden />
          Auto-suggest top-level fields
        </button>
        <MetadataMappingMenu state={state} onChangeMapping={onChangeMapping} />
        <button
          type="button"
          onClick={resetMapping}
          disabled={state.mapping.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Reset mapping
        </button>
      </div>

      {!sampleEvent ? (
        <p className="mt-4 rounded-md border border-amber-200/80 bg-amber-500/[0.06] p-3 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          Run the Fetch Sample Data step first so we can show a sample event. You can also add empty rows and configure them
          manually below.
        </p>
      ) : null}

      <div
        className={cn(
          'mt-4 grid gap-3 xl:items-stretch',
          showOutputAside
            ? 'xl:grid-cols-[minmax(300px,1.15fr)_minmax(280px,1fr)_minmax(320px,1.05fr)]'
            : 'xl:grid-cols-[minmax(300px,1.15fr)_minmax(280px,1fr)]',
        )}
      >
        {/* Left: sample event */}
        <PanelChrome
          className="max-h-[min(72vh,760px)] min-h-[min(72vh,760px)]"
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
          title="Sample Event"
          right={
            <div className="flex items-center gap-1.5">
              {duplicateNotice ? (
                <span className="mr-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  {duplicateNotice}
                </span>
              ) : null}
              <div className="inline-flex rounded-md border border-slate-200/90 p-0.5 dark:border-gdc-border">
                <button
                  type="button"
                  onClick={() => setSampleView('tree')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    sampleView === 'tree'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                  )}
                >
                  Tree
                </button>
                <button
                  type="button"
                  onClick={() => setSampleView('json')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    sampleView === 'json'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                  )}
                >
                  JSON
                </button>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={expandAll}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200/90 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                  title="Expand all"
                  aria-label="Expand all"
                >
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={collapseAll}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200/90 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
                  title="Collapse all"
                  aria-label="Collapse all"
                >
                  <Layers className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 space-y-0.5 border-b border-slate-200/70 px-2.5 py-2 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
              <p>
                <span className="font-semibold text-slate-700 dark:text-slate-200">Event array: </span>
                <span className="font-mono text-violet-700 dark:text-violet-300">{formatEventArrayLabel(state)}</span>
              </p>
              <p>
                <span className="font-semibold text-slate-700 dark:text-slate-200">Records: </span>
                {state.apiTest.extractedEvents.length || state.apiTest.eventCount}
              </p>
              {unionSchema ? <UnionSchemaSamplePolicyBanner policy={samplePolicy} className="mt-2" /> : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
              {sampleView === 'tree' && unionSchema ? (
                <UnionSchemaTreeDetailLayout
                  key={`${treeMountKey}-${treeExpandStrategy}`}
                  className="min-h-0 flex-1"
                  schema={unionSchema}
                  search=""
                  onPickPath={handlePickPath}
                  expandStrategy={treeExpandStrategy}
                  activeHighlightPath={flashHighlightPath}
                  selectedPath={selectedUnionPath}
                  onSelectPath={setSelectedUnionPath}
                  generatedRules={state.enrichment}
                />
              ) : null}
              {sampleView === 'tree' && !unionSchema && sampleEvent ? (
                <MappingJsonTree
                  key={`${treeMountKey}-${treeExpandStrategy}`}
                  value={sampleEvent}
                  baseLabel="event"
                  basePath="$"
                  search=""
                  onPickPath={handlePickPath}
                  expandStrategy={treeExpandStrategy}
                  activeHighlightPath={flashHighlightPath}
                />
              ) : null}
              {sampleView === 'json' && (unionSchema || sampleEvent) ? (
                <pre className="min-h-full overflow-auto rounded-md border border-slate-200/80 bg-slate-950/90 p-2 text-[10px] leading-snug text-emerald-100 dark:border-gdc-border">
                  {unionSchema
                    ? JSON.stringify(buildRepresentativeEventFromUnionSchema(unionSchema), null, 2)
                    : rawSampleJson}
                </pre>
              ) : null}
              {!unionSchema && !sampleEvent ? (
                <p className="px-1 py-3 text-[11px] italic text-slate-500">No sample event available yet.</p>
              ) : null}
            </div>
          </div>
        </PanelChrome>

        {/* Center: mapping + suggestions */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3">
          <PanelChrome
            className="max-h-[min(52vh,560px)] min-h-0"
            title="Field Mapping"
            right={
              <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-bold text-violet-800 dark:text-violet-200">
                {mappedCount} mapped
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/70 px-2.5 py-2 dark:border-gdc-border">
              <div className="relative min-w-[160px] flex-1">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-gdc-muted"
                  aria-hidden
                />
                <input
                  type="search"
                  value={mappingSearch}
                  onChange={(e) => setMappingSearch(e.target.value)}
                  placeholder="Search fields…"
                  className="h-7 w-full rounded-md border border-slate-200/90 bg-white pl-7 pr-2 text-[11px] text-slate-800 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                  aria-label="Filter mapping rows"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  onChangeMapping([...state.mapping, { id: newRowId(), outputField: '', sourceJsonPath: '' }])
                }
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Add row
              </button>
              <button
                type="button"
                onClick={clearAllRows}
                disabled={state.mapping.length === 0}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-red-200/90 bg-white px-2 text-[11px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:bg-gdc-card dark:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Clear all
              </button>
            </div>
            <div className="min-h-0 overflow-auto">
              {state.mapping.length === 0 ? (
                <p className="p-3 text-[11px] italic text-slate-500">
                  No mappings yet. Click a JSON node on the left to add one, or use Auto-suggest.
                </p>
              ) : (
                (() => {
                  const filterQ = mappingSearch.trim().toLowerCase()
                  const visibleRows = filterQ
                    ? state.mapping.filter((r) => {
                        const hay = `${r.outputField} ${r.sourceJsonPath}`.toLowerCase()
                        return hay.includes(filterQ)
                      })
                    : state.mapping
                  if (visibleRows.length === 0) {
                    return (
                      <p className="p-3 text-[11px] italic text-slate-500 dark:text-gdc-muted">
                        No mappings match “{mappingSearch}”.
                      </p>
                    )
                  }
                  return (
                    <ul className="divide-y divide-slate-200/70 dark:divide-gdc-border">
                      {visibleRows.map((row) => {
                        const idx = state.mapping.findIndex((m) => m.id === row.id)
                        const path = row.sourceJsonPath.trim()
                        const resolved = sampleEvent && path ? resolveJsonPath(sampleEvent, path) : undefined
                        const typ = inferValueType(resolved)
                        const warn = rowWarnings.get(row.id)
                        const isNew = flashRowId === row.id
                        const sampleText = truncatePreview(resolved)
                        return (
                          <li
                            key={row.id}
                            className={cn(
                              'group/row flex items-start gap-2 px-3 py-2.5 transition-colors',
                              isNew && 'bg-violet-500/[0.12]',
                              warn?.dup && 'bg-amber-500/[0.06] dark:bg-amber-500/[0.08]',
                              !isNew && !warn?.dup && 'hover:bg-slate-50/80 dark:hover:bg-gdc-rowHover/60',
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <input
                                  value={row.sourceJsonPath}
                                  placeholder="$.id"
                                  onChange={(e) => {
                                    const next = [...state.mapping]
                                    next[idx] = { ...row, sourceJsonPath: e.target.value }
                                    onChangeMapping(next)
                                  }}
                                  className={cn(
                                    'h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 font-mono text-[11px] text-slate-800 outline-none hover:border-slate-200/90 hover:bg-white/60 focus:border-violet-400 focus:bg-white dark:text-slate-100 dark:hover:border-gdc-border dark:hover:bg-gdc-section/40 dark:focus:border-violet-500/60 dark:focus:bg-gdc-section',
                                  )}
                                  aria-label="Source JSONPath"
                                />
                                <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-px text-[9px] font-semibold capitalize text-violet-800 dark:text-violet-200">
                                  {typ}
                                </span>
                                {row.origin === 'stellar' ? (
                                  <span
                                    className="shrink-0 rounded border border-emerald-300/80 bg-emerald-500/10 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-800 dark:border-emerald-500/40 dark:text-emerald-200"
                                    title="Added from Stellar Cyber metadata mapping suggestions"
                                  >
                                    Stellar
                                  </span>
                                ) : row.origin === 'auto' ? (
                                  <span
                                    className="shrink-0 rounded border border-sky-300/80 bg-sky-500/10 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-sky-800 dark:border-sky-500/40 dark:text-sky-200"
                                    title="Added from Auto-suggest top-level fields"
                                  >
                                    Auto
                                  </span>
                                ) : null}
                                {isNew ? (
                                  <span className="shrink-0 rounded bg-violet-600 px-1 py-px text-[9px] font-bold uppercase text-white">
                                    New
                                  </span>
                                ) : null}
                              </div>
                              <p
                                className={cn(
                                  'mt-1 flex items-center gap-1.5 pl-1 font-mono text-[10px] text-slate-500 dark:text-gdc-mutedStrong',
                                  warn?.missing && 'text-amber-700 dark:text-amber-300',
                                )}
                                title={truncatePreview(resolved, 500)}
                              >
                                <span className="rounded bg-slate-200/60 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-slate-600 dark:bg-gdc-section dark:text-gdc-muted">
                                  Result
                                </span>
                                <code className="truncate">{sampleText}</code>
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-0.5">
                              <DestinationFieldChip
                                value={row.outputField}
                                warning={warn?.dup ? 'duplicate' : null}
                                onChange={(name) => {
                                  const next = [...state.mapping]
                                  next[idx] = { ...row, outputField: name }
                                  onChangeMapping(next)
                                }}
                                commonFields={COMMON_DEST_FIELDS}
                                recentCustom={recentCustomFields}
                                onRegisterCustom={registerCustomField}
                              />
                              <button
                                type="button"
                                onClick={() => duplicateRow(idx)}
                                className="invisible inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-slate-500 hover:bg-slate-100 hover:text-violet-700 group-hover/row:visible dark:hover:bg-gdc-rowHover dark:hover:text-violet-300"
                                aria-label="Duplicate row"
                                title="Duplicate row"
                              >
                                <Copy className="h-3.5 w-3.5" aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => onChangeMapping(state.mapping.filter((m) => m.id !== row.id))}
                                className="invisible inline-flex h-7 w-7 items-center justify-center rounded border border-transparent text-slate-500 hover:bg-red-50 hover:text-red-600 group-hover/row:visible dark:hover:bg-red-950/40 dark:hover:text-red-300"
                                aria-label="Remove mapping row"
                                title="Remove row"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                              </button>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )
                })()
              )}
            </div>
          </PanelChrome>

          <section className="rounded-lg border border-slate-200/80 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-card">
            <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Suggested Fields</h4>
            <div className="mt-2 space-y-3">
              {SUGGESTED_FIELD_GROUPS.map((group) => {
                const names = suggestionsExpanded ? group.names : group.names.slice(0, 6)
                return (
                  <div key={group.title}>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{group.title}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {names.map((name) => {
                        const exists = findSuggestionPath(name, quickFields) != null
                        return (
                          <button
                            key={`${group.title}-${name}`}
                            type="button"
                            disabled={!exists}
                            onClick={() => handleSuggestedChip(name)}
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
                              exists
                                ? 'border-slate-200/90 bg-white text-slate-700 hover:border-violet-400 hover:bg-violet-500/[0.06] dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200'
                                : 'cursor-not-allowed border-slate-100 bg-slate-100/80 text-slate-400 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted',
                            )}
                          >
                            {name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => setSuggestionsExpanded((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              {suggestionsExpanded ? (
                <>
                  Show fewer suggestions <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                </>
              ) : (
                <>
                  Show more suggestions <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </>
              )}
            </button>
          </section>
        </div>

        {showOutputAside ? (
          <WizardMappingOutputAside
            state={state}
            onChangeUnmappedFieldsPolicy={onChangeUnmappedFieldsPolicy}
          />
        ) : null}
      </div>
    </>
  )
}
