import { AlertTriangle, Check, Copy, Hash, ListTree, Search, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { runExtractionValidate, type ExtractionValidateResponse } from '../../../api/gdcRuntimePreview'
import { copyTextToClipboard } from '../../../utils/clipboard'
import {
  absolutePathInSampleRecord,
  approxJsonBytes,
  checkpointPathFromClick,
  eventRootPathFromClick,
  formatPreviewSamplePath,
} from '../../../utils/eventExtractionPaths'
import {
  FIELD_IMPORTANCE_HELP,
  SAMPLE_RECORD_FIELD_IMPORTANCE,
} from '../../../lib/field-importance'
import { FieldImportanceBadge } from './field-importance-badge'
import {
  deriveRecordSelectionPaths,
  eventArrayPathFromClick,
  normalizeCheckpointRelativePath,
  recordSelectionSummary,
  type RecordSelectionPaths,
} from '../../../utils/recordSelectionPaths'
import { CheckpointExtractionSuggestionsPanel } from '../checkpoint-extraction-suggestions-panel'
import {
  mergeSortIntoRequestBody,
  type CheckpointFieldType,
} from '../checkpoint-extraction-suggestions'
import { MappingJsonTree, PanelChrome } from '../mapping-json-tree'
import {
  IncrementalRequestTestButton,
  IncrementalRequestTestSection,
  useIncrementalRequestTest,
} from './incremental-request-test-section'
import {
  wizardCheckpointConfirmed,
  wizardCheckpointStale,
  wizardRecordPathConfirmed,
  wizardRecordPathStale,
  wizardSourceRequiresHttpRecordSelection,
} from './wizard-step-gates'
import { flattenSampleFields, wizardExtractEvents } from './wizard-json-extract'
import type { OperationalSampleId } from './wizard-operational-samples'
import {
  buildIncrementalRequestPlan,
  fieldNameFromCheckpointPath,
  inferIncrementalRequestPattern,
  incrementalPatternDisplayLabel,
  incrementalPatternFromSelect,
  incrementalPatternSelectValue,
  incrementalPreviewKindLabel,
  availableIncrementalPatterns,
  preferPrimitiveCheckpointPath,
  readCheckpointFromEventSourceRecord,
  readCheckpointFromExtractedEvent,
  resolveCheckpointPathForRecord,
  sampleValueTypeLabel,
  type IncrementalPatternSelectValue,
  type IncrementalRequestPattern,
} from './wizard-incremental-request'
import { RequestPreviewCopyButton, RequestPreviewDrawer } from './request-preview-drawer'
import { resolveJsonPath } from '../stream-api-test-json-utils'
import { UnionSchemaStatusCard } from './union-schema-status-card'
import type { WizardCheckpointFieldType, WizardConfigState, WizardState } from './wizard-state'

type RecordSelectionWorkspaceProps = {
  state: WizardState
  onSetEventArrayPath: (path: string) => void
  onSetEventRootPath: (path: string) => void
  onSetCheckpoint: (patch: Partial<Pick<WizardConfigState, 'checkpointFieldType' | 'checkpointSourcePath'>>) => void
  onStreamPatch?: (patch: Partial<WizardConfigState>) => void
  onLoadOperationalSample?: (id: OperationalSampleId) => void
  activeOperationalSampleId?: OperationalSampleId | null
}

type ExtractedViewMode = 'fields' | 'json'
type SourceViewMode = 'json' | 'tree'
type RecordSelectionMode = 'basic' | 'advanced'

const RECORD_SELECTION_COLUMN_HEIGHT = 'h-[min(72vh,780px)]'

function safeScrollIntoView(el: Element | null | undefined, options?: ScrollIntoViewOptions) {
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView(options)
}

export function scrollRecordSelectionWorkspaceToTop(behavior: ScrollBehavior = 'smooth') {
  window.requestAnimationFrame(() => {
    safeScrollIntoView(document.getElementById('wizard-json-preview-panel'), { behavior, block: 'start' })
    safeScrollIntoView(document.getElementById('record-selection-workspace-header'), { behavior, block: 'start' })
  })
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function fieldRowsFromObject(obj: Record<string, unknown> | null, max = 120): Array<{ key: string; path: string; value: unknown }> {
  if (!obj) return []
  const paths = flattenSampleFields(obj, max, 6)
  return paths.map((path) => {
    const key = path.replace(/^\$\.?/, '')
    let value: unknown = obj
    for (const part of key.split('.')) {
      if (value == null || typeof value !== 'object') break
      value = (value as Record<string, unknown>)[part]
    }
    return { key, path, value }
  })
}

export function RecordSelectionWorkspace({
  state,
  onSetEventArrayPath,
  onSetEventRootPath,
  onSetCheckpoint,
  onStreamPatch,
}: RecordSelectionWorkspaceProps) {
  const t = state.apiTest
  const [search, setSearch] = useState('')
  const [previewIndex, setPreviewIndex] = useState(0)
  const [extractedView, setExtractedView] = useState<ExtractedViewMode>('fields')
  const [sourceView, setSourceView] = useState<SourceViewMode>('tree')
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [validationBusy, setValidationBusy] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  /** True once user has clicked an "Event Root" pill — keeps the status chip activated even when the
   *  normalized path resolves to '' (entire record), which would otherwise look identical to the default. */
  const [eventRootInteracted, setEventRootInteracted] = useState(false)
  const headerRef = useRef<HTMLDivElement>(null)

  const scrollSelectionFeedbackIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      safeScrollIntoView(headerRef.current, { behavior: 'smooth', block: 'start' })
    })
  }, [])

  useEffect(() => {
    scrollRecordSelectionWorkspaceToTop('auto')
  }, [])

  const rawPayload = t.parsedJson ?? t.rawResponse

  const pathsFromProps = useMemo(
    () =>
      deriveRecordSelectionPaths(
        state.stream.eventArrayPath,
        state.stream.eventRootPath,
        state.stream.checkpointSourcePath,
        state.stream.useWholeResponseAsEvent,
        rawPayload,
      ),
    [
      rawPayload,
      state.stream.checkpointSourcePath,
      state.stream.eventArrayPath,
      state.stream.eventRootPath,
      state.stream.useWholeResponseAsEvent,
    ],
  )

  const [paths, setPaths] = useState<RecordSelectionPaths>(pathsFromProps)

  useEffect(() => {
    setPaths(pathsFromProps)
  }, [pathsFromProps])

  const extractedEvents = useMemo(
    () => wizardExtractEvents(rawPayload, paths.eventArrayPath, paths.eventRootPath),
    [rawPayload, paths.eventArrayPath, paths.eventRootPath],
  )

  /** Extracted event records (event root applied) — used for incremental Test checkpoint values. */
  const checkpointTestRecords = extractedEvents

  const previewIndexClamped = Math.min(Math.max(0, previewIndex), Math.max(0, extractedEvents.length - 1))
  const extractedPreview = extractedEvents[previewIndexClamped] ?? null

  const summary = useMemo(
    () => recordSelectionSummary(paths, extractedEvents.length, previewIndexClamped),
    [extractedEvents.length, paths, previewIndexClamped],
  )

  const fieldRows = useMemo(() => fieldRowsFromObject(extractedPreview), [extractedPreview])
  const approxBytes = approxJsonBytes(rawPayload)
  const extractedBytes = approxJsonBytes(extractedPreview)

  const notifyCopy = useCallback((label: string) => {
    setCopyNotice(label)
    window.setTimeout(() => setCopyNotice(null), 2000)
  }, [])

  const copyValue = useCallback(
    async (text: string, label: string) => {
      const ok = await copyTextToClipboard(text)
      notifyCopy(ok ? label : 'Copy failed — check browser permissions')
    },
    [notifyCopy],
  )

  const selectionMode: RecordSelectionMode = state.stream.recordSelectionMode === 'advanced' ? 'advanced' : 'basic'

  const clearCustomValidation = useCallback(() => {
    onStreamPatch?.({
      customExtractionValidatedForApiTestAt: null,
      customExtractionValidationOk: false,
    })
  }, [onStreamPatch])

  const setSelectionMode = useCallback(
    (mode: RecordSelectionMode) => {
      onStreamPatch?.({
        recordSelectionMode: mode,
        customExtractionValidatedForApiTestAt: mode === 'advanced' ? null : state.stream.customExtractionValidatedForApiTestAt,
        customExtractionValidationOk: mode === 'advanced' ? false : state.stream.customExtractionValidationOk,
      })
      if (mode !== 'advanced') {
        setValidationMessage(null)
      }
    },
    [onStreamPatch, state.stream.customExtractionValidatedForApiTestAt, state.stream.customExtractionValidationOk],
  )

  const handleSelectEventArray = useCallback(
    (clickedPath: string) => {
      const normalized = eventArrayPathFromClick(clickedPath, rawPayload)
      const nextPaths: RecordSelectionPaths = { ...paths, eventArrayPath: normalized }
      setPaths(nextPaths)
      setPreviewIndex(0)
      onSetEventArrayPath(normalized)
      if (selectionMode === 'advanced') clearCustomValidation()
      // Event Source change resets the Event Root interaction (the new array element may differ).
      setEventRootInteracted(false)
      notifyCopy(`Event source → ${normalized || '$'}`)
      scrollSelectionFeedbackIntoView()
    },
    [clearCustomValidation, notifyCopy, onSetEventArrayPath, paths, rawPayload, scrollSelectionFeedbackIntoView, selectionMode],
  )

  const handleSelectEventRoot = useCallback(
    (clickedPath: string) => {
      const normalized = eventRootPathFromClick(clickedPath, paths.eventArrayPath || '$')
      const nextPaths: RecordSelectionPaths = { ...paths, eventRootPath: normalized }
      setPaths(nextPaths)
      setPreviewIndex(0)
      onSetEventRootPath(normalized)
      if (selectionMode === 'advanced') clearCustomValidation()
      setEventRootInteracted(true)
      notifyCopy(`Event root → ${normalized || '(entire record)'}`)
      scrollSelectionFeedbackIntoView()
    },
    [clearCustomValidation, notifyCopy, onSetEventRootPath, paths, scrollSelectionFeedbackIntoView, selectionMode],
  )

  const handleSelectCheckpoint = useCallback(
    (absolutePath: string, type?: WizardCheckpointFieldType) => {
      const absNorm = absolutePath.trim().startsWith('$') ? absolutePath.trim() : `$.${absolutePath.trim()}`
      const atPath = rawPayload != null ? resolveJsonPath(rawPayload, absNorm) : undefined
      const rel = preferPrimitiveCheckpointPath(
        checkpointPathFromClick(absolutePath, paths.eventArrayPath, previewIndexClamped),
        atPath,
      )
      const nextPaths: RecordSelectionPaths = { ...paths, checkpointSourcePath: rel }
      setPaths(nextPaths)
      onSetCheckpoint({
        checkpointSourcePath: rel,
        ...(type ? { checkpointFieldType: type } : {}),
      })
      if (selectionMode === 'advanced') clearCustomValidation()
      notifyCopy(`Sync position → ${rel || '(cleared)'}`)
      scrollSelectionFeedbackIntoView()
    },
    [
      clearCustomValidation,
      notifyCopy,
      onSetCheckpoint,
      paths,
      previewIndexClamped,
      rawPayload,
      scrollSelectionFeedbackIntoView,
      selectionMode,
    ],
  )

  const handleApplySuggestedEventArrayPath = useCallback(
    (path: string) => {
      const normalized = eventArrayPathFromClick(path, rawPayload)
      const nextPaths: RecordSelectionPaths = { ...paths, eventArrayPath: normalized }
      setPaths(nextPaths)
      setPreviewIndex(0)
      onSetEventArrayPath(normalized)
      if (selectionMode === 'advanced') clearCustomValidation()
      setEventRootInteracted(false)
      notifyCopy(`Event source → ${normalized || '$'}`)
      scrollSelectionFeedbackIntoView()
    },
    [clearCustomValidation, notifyCopy, onSetEventArrayPath, paths, rawPayload, scrollSelectionFeedbackIntoView, selectionMode],
  )

  const handleApplySuggestedCheckpointExtraction = useCallback(
    (patch: {
      checkpointType: CheckpointFieldType
      extractionPathRelative: string
      extractionPathAbsolute: string
    }) => {
      const rel = normalizeCheckpointRelativePath(patch.extractionPathRelative)
      const nextPaths: RecordSelectionPaths = { ...paths, checkpointSourcePath: rel }
      setPaths(nextPaths)
      onSetCheckpoint({
        checkpointSourcePath: rel,
        checkpointFieldType: patch.checkpointType,
      })
      if (selectionMode === 'advanced') clearCustomValidation()
      notifyCopy(`Sync position → ${rel || '(cleared)'}`)
      scrollSelectionFeedbackIntoView()
    },
    [clearCustomValidation, notifyCopy, onSetCheckpoint, paths, scrollSelectionFeedbackIntoView, selectionMode],
  )

  const handleApplySuggestedSortRecommendation = useCallback(
    (patch: {
      sortLabel: string
      tieBreakerLabel: string | null
      primaryFieldName: string
      tieBreakerFieldName: string | null
    }) => {
      let nextBody = mergeSortIntoRequestBody(state.stream.requestBody, patch.primaryFieldName)
      if (patch.tieBreakerFieldName) {
        nextBody = mergeSortIntoRequestBody(nextBody, patch.tieBreakerFieldName)
      }
      const streamPatch: Partial<WizardConfigState> = { requestBody: nextBody }
      if (patch.tieBreakerFieldName) {
        streamPatch.checkpointSecondaryPath = normalizeCheckpointRelativePath(patch.tieBreakerFieldName)
      }
      onStreamPatch?.(streamPatch)
      notifyCopy(
        patch.tieBreakerFieldName
          ? `Sort → ${patch.primaryFieldName} ASC, tie-breaker → ${patch.tieBreakerFieldName}`
          : `Sort → ${patch.primaryFieldName} ASC`,
      )
      scrollSelectionFeedbackIntoView()
    },
    [notifyCopy, onStreamPatch, scrollSelectionFeedbackIntoView, state.stream.requestBody],
  )

  const handleCustomExtractionValidate = useCallback(async () => {
    if (rawPayload == null) return
    setValidationBusy(true)
    setValidationMessage(null)
    try {
      const response: ExtractionValidateResponse = await runExtractionValidate({
        payload: rawPayload,
        event_array_path: state.stream.useWholeResponseAsEvent ? null : state.stream.eventArrayPath,
        event_root_path: state.stream.eventRootPath || null,
        checkpoint_path: state.stream.checkpointSourcePath || null,
        max_preview_events: 3,
      })

      if (response.normalized_event_array_path != null) onSetEventArrayPath(response.normalized_event_array_path)
      if (response.normalized_event_root_path != null || !state.stream.eventRootPath.trim()) {
        onSetEventRootPath(response.normalized_event_root_path ?? '')
      }
      if (response.normalized_checkpoint_path != null) {
        onSetCheckpoint({ checkpointSourcePath: response.normalized_checkpoint_path })
      }

      onStreamPatch?.({
        recordSelectionMode: 'advanced',
        customExtractionValidatedForApiTestAt: state.apiTest.finishedAt ?? null,
        customExtractionValidationOk: response.ok,
      })

      const errorCount = response.errors.length
      const warningCount = response.warnings.length
      if (response.ok) {
        setValidationMessage(
          `Validated: ${response.event_count} events extracted${warningCount > 0 ? `, ${warningCount} warning(s)` : ''}.`,
        )
      } else {
        setValidationMessage(
          `Validation failed: ${errorCount} error(s)${warningCount > 0 ? `, ${warningCount} warning(s)` : ''}.`,
        )
      }
    } catch (err) {
      onStreamPatch?.({
        recordSelectionMode: 'advanced',
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      })
      setValidationMessage(`Validation request failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setValidationBusy(false)
    }
  }, [
    onSetCheckpoint,
    onSetEventArrayPath,
    onSetEventRootPath,
    onStreamPatch,
    rawPayload,
    state.apiTest.finishedAt,
    state.stream.checkpointSourcePath,
    state.stream.eventArrayPath,
    state.stream.eventRootPath,
    state.stream.useWholeResponseAsEvent,
  ])

  const eventSourceHighlight =
    paths.eventArrayPath && paths.eventArrayPath !== '$' ? paths.eventArrayPath : paths.eventArrayPath === '$' ? '$' : null
  const eventRootHighlight = paths.eventRootPath
    ? absolutePathInSampleRecord(paths.eventArrayPath, paths.eventRootPath, previewIndexClamped)
    : null
  const checkpointHighlight = paths.checkpointSourcePath
    ? absolutePathInSampleRecord(paths.eventArrayPath, paths.checkpointSourcePath, previewIndexClamped)
    : null

  if (rawPayload == null || (t.status !== 'success' && t.status !== 'error' && t.status !== 'running')) {
    return (
      <section className="rounded-xl border border-dashed border-slate-300/90 bg-slate-50/40 p-6 text-center dark:border-gdc-border dark:bg-gdc-card">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Record Selection</h3>
        <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
          Run <span className="font-semibold">Fetch Sample Data</span> or load an operational test dataset on the API Test step.
        </p>
      </section>
    )
  }

  const sampleStale = wizardSourceRequiresHttpRecordSelection(state) && (t.status !== 'success' || !t.ok)
  const recordPathConfirmed = wizardRecordPathConfirmed(state)
  const checkpointConfirmed = wizardCheckpointConfirmed(state)
  const recordPathStale = wizardRecordPathStale(state) || sampleStale
  const checkpointStale = wizardCheckpointStale(state) || sampleStale

  return (
    <section id="wizard-json-preview-panel" className="space-y-3" tabIndex={-1}>
      {sampleStale ? (
        <div
          role="status"
          className="rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
          data-testid="record-selection-stale-banner"
        >
          <span className="font-semibold">Selections are stale.</span> Run a successful API Test, then reconfirm record path
          and sync position before continuing to Transform.
        </div>
      ) : null}

      {/* Hidden testId-only summary anchors retained for existing tests/integrations. */}
      <div className="sr-only" aria-hidden>
        <span data-testid="summary-event-source">{summary.eventSource}</span>
        <span data-testid="summary-event-root">{summary.eventRoot}</span>
        <span data-testid="summary-runtime">{summary.runtimeExtraction}</span>
        <span data-testid="summary-records">{summary.recordsDetected}</span>
        <span data-testid="summary-preview">{summary.previewSample}</span>
      </div>

      {/*
       * Unified workspace header: page title + description; SelectionStatusChips on the
       * right. Event array path is chosen from the JSON tree (Event source actions).
       */}
      <div
        ref={headerRef}
        id="record-selection-workspace-header"
        className="rounded-lg border border-slate-200/80 bg-slate-50/95 p-2.5 shadow-sm dark:border-gdc-border dark:bg-gdc-section/95"
      >
        {copyNotice ? (
          <p className="mb-2 rounded-md border border-emerald-200/80 bg-emerald-500/[0.06] px-2.5 py-1.5 text-[11px] text-emerald-800 dark:border-emerald-500/30 dark:text-emerald-200">
            {copyNotice}
          </p>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Record Selection</h3>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-gdc-muted">
              Select record path and checkpoint before proceeding to Transform. Event Root is optional.
            </p>
            <div className="mt-2 inline-flex rounded-md border border-slate-200/80 bg-white p-0.5 dark:border-gdc-border dark:bg-gdc-card">
              <button
                type="button"
                onClick={() => setSelectionMode('basic')}
                className={cn(
                  'rounded px-2 py-1 text-[10px] font-semibold',
                  selectionMode === 'basic'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                )}
              >
                Basic (Tree)
              </button>
              <button
                type="button"
                onClick={() => setSelectionMode('advanced')}
                className={cn(
                  'rounded px-2 py-1 text-[10px] font-semibold',
                  selectionMode === 'advanced'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                )}
              >
                Advanced (Custom)
              </button>
            </div>
          </div>
          <SelectionStatusChips
            eventArrayPath={paths.eventArrayPath}
            eventRootPath={paths.eventRootPath}
            eventRootInteracted={eventRootInteracted}
            recordsCount={extractedEvents.length}
            checkpointPath={state.stream.checkpointSourcePath}
            checkpointType={state.stream.checkpointFieldType}
            recordPathConfirmed={recordPathConfirmed}
            recordPathStale={recordPathStale}
            checkpointConfirmed={checkpointConfirmed}
            checkpointStale={checkpointStale}
          />
        </div>

        <UnionSchemaStatusCard state={state} extractedEventCount={extractedEvents.length} className="mt-2" />

        {t.status === 'success' && t.ok && t.parsedJson != null ? (
          <CheckpointExtractionSuggestionsPanel
            className="mt-2"
            parsedJson={t.parsedJson}
            applyHandlers={{
              onApplyEventArrayPath: handleApplySuggestedEventArrayPath,
              onApplyCheckpointExtraction: handleApplySuggestedCheckpointExtraction,
              onApplySortRecommendation: handleApplySuggestedSortRecommendation,
            }}
          />
        ) : null}

        {selectionMode === 'advanced' ? (
          <div className="mt-2 rounded-md border border-violet-200/70 bg-violet-50/70 p-2 dark:border-violet-500/30 dark:bg-violet-500/10">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">
                Custom extraction paths
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onSetEventArrayPath('$.data.resultIdToElementDataMap.*')
                    clearCustomValidation()
                  }}
                  className="rounded border border-violet-300/80 bg-white px-2 py-1 text-[10px] font-semibold text-violet-800 hover:bg-violet-50 dark:border-violet-400/40 dark:bg-gdc-card dark:text-violet-200"
                >
                  Object-map values preset
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSetEventRootPath('')
                    clearCustomValidation()
                  }}
                  className="rounded border border-slate-200/90 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
                >
                  Use root object
                </button>
                <button
                  type="button"
                  onClick={() => void handleCustomExtractionValidate()}
                  disabled={validationBusy}
                  className="rounded bg-violet-600 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {validationBusy ? 'Validating…' : 'Validate & Preview'}
                </button>
              </div>
            </div>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-gdc-mutedStrong">
                <span>Event array path</span>
                <input
                  value={state.stream.eventArrayPath}
                  onChange={(e) => {
                    onSetEventArrayPath(e.target.value)
                    clearCustomValidation()
                  }}
                  className="h-8 w-full rounded border border-slate-200/90 bg-white px-2 text-[11px] normal-case text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                  placeholder="$.items or $.data.resultIdToElementDataMap.*"
                />
              </label>
              <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-gdc-mutedStrong">
                <span>Event root path</span>
                <input
                  value={state.stream.eventRootPath}
                  onChange={(e) => {
                    onSetEventRootPath(e.target.value)
                    clearCustomValidation()
                  }}
                  className="h-8 w-full rounded border border-slate-200/90 bg-white px-2 text-[11px] normal-case text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                  placeholder="$ or $.event"
                />
              </label>
              <label className="space-y-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-gdc-mutedStrong">
                <span>Sync position path</span>
                <input
                  value={state.stream.checkpointSourcePath}
                  onChange={(e) => {
                    onSetCheckpoint({ checkpointSourcePath: e.target.value })
                    clearCustomValidation()
                  }}
                  className="h-8 w-full rounded border border-slate-200/90 bg-white px-2 text-[11px] normal-case text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                  placeholder="$.eventTime"
                />
              </label>
            </div>
            {validationMessage ? (
              <p className="mt-2 text-[11px] text-violet-900 dark:text-violet-100">{validationMessage}</p>
            ) : null}
          </div>
        ) : null}

        {(() => {
          const httpRecords = wizardSourceRequiresHttpRecordSelection(state)
          const eventSourceMissing =
            httpRecords && !state.stream.useWholeResponseAsEvent && paths.eventArrayPath.trim().length === 0
          const checkpointMissing = httpRecords && state.stream.checkpointSourcePath.trim().length === 0
          const needsReconfirm = httpRecords && (recordPathStale || checkpointStale)
          if (!httpRecords || (!eventSourceMissing && !checkpointMissing && !needsReconfirm)) return null
          const missing: string[] = []
          if (eventSourceMissing || (recordPathStale && !eventSourceMissing)) missing.push('Record Path')
          if (checkpointMissing || (checkpointStale && !checkpointMissing)) missing.push('Checkpoint')
          return (
            <div
              role="status"
              className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-300/70 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">Next is blocked.</span>{' '}
                {needsReconfirm && !eventSourceMissing && !checkpointMissing
                  ? 'Reconfirm Record Path and Checkpoint after the latest successful API Test.'
                  : `Confirm ${missing.join(' and ')} below — Transform cannot start without ${missing.length > 1 ? 'these fields' : 'this field'}.`}
              </span>
            </div>
          )
        })()}
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <div
          data-testid={sourceView === 'json' ? 'wizard-record-selection-formatted' : 'wizard-record-selection-json-tree'}
        >
        <PanelChrome
          title={sourceView === 'json' ? 'Formatted Response' : 'JSON Tree'}
          fillParent
          className={cn(RECORD_SELECTION_COLUMN_HEIGHT, '!max-h-none')}
          bodyClassName="gdc-thin-scroll min-h-0 flex-1 overflow-y-auto"
          right={
            <div className="flex items-center gap-2">
              {sourceView === 'tree' ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" aria-hidden />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Filter paths…"
                    className="h-7 w-40 rounded border border-slate-200/90 bg-white py-1 pl-7 pr-2 text-[11px] text-slate-800 placeholder:text-slate-400 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:placeholder:text-gdc-placeholder"
                  />
                </div>
              ) : (
                <span className="text-[10px] text-slate-500 dark:text-gdc-mutedStrong">{approxBytes.toLocaleString()} bytes</span>
              )}
              <button
                type="button"
                onClick={() => void copyValue(formatJson(rawPayload), 'Raw JSON copied')}
                className="inline-flex h-7 items-center gap-1 rounded border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                title="Copy raw JSON"
              >
                <Copy className="h-3 w-3" aria-hidden />
                Copy
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSourceView('json')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    sourceView === 'json'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                  )}
                >
                  Formatted
                </button>
                <button
                  type="button"
                  onClick={() => setSourceView('tree')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    sourceView === 'tree'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                  )}
                >
                  Tree
                </button>
              </div>
            </div>
          }
        >
          {sourceView === 'json' ? (
            <pre className="gdc-thin-scroll overflow-x-auto rounded-md bg-slate-950 p-3 text-[10px] leading-snug text-emerald-200">
              {formatJson(rawPayload)}
            </pre>
          ) : (
            <div className="p-2">
              {typeof rawPayload === 'object' && rawPayload !== null ? (
                <MappingJsonTree
                  value={rawPayload}
                  baseLabel="root"
                  basePath="$"
                  search={search}
                  highlightPathPrefix={eventSourceHighlight}
                  eventRootHighlightPath={eventRootHighlight}
                  checkpointHighlightPath={checkpointHighlight}
                  expandStrategy="smart"
                  onPickPath={(p) => handleSelectCheckpoint(p)}
                  onUseEventArrayPath={handleSelectEventArray}
                  onUseEventRootPath={handleSelectEventRoot}
                  onUseCheckpointPath={handleSelectCheckpoint}
                  showCopyPath={false}
                />
              ) : (
                <p className="text-[11px] text-slate-500">Tree view requires a JSON object or array.</p>
              )}
            </div>
          )}
        </PanelChrome>
        </div>

        <div className={cn('flex min-h-0 min-w-0 flex-col gap-3', RECORD_SELECTION_COLUMN_HEIGHT)}>
        <PanelChrome
          title="Extracted event preview"
          className="max-h-[min(36vh,320px)] min-h-[8rem] shrink-0 !max-h-[min(36vh,320px)]"
          bodyClassName="gdc-thin-scroll max-h-[min(28vh,260px)] overflow-y-auto"
          right={
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-slate-500 dark:text-gdc-mutedStrong">
                {paths.eventArrayPath || '$'}
                {paths.eventRootPath ? ` · root: ${paths.eventRootPath}` : ''}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setExtractedView('fields')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    extractedView === 'fields'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                  )}
                >
                  Fields
                </button>
                <button
                  type="button"
                  onClick={() => setExtractedView('json')}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-semibold',
                    extractedView === 'json'
                      ? 'bg-violet-600 text-white'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-gdc-rowHover',
                  )}
                >
                  JSON
                </button>
              </div>
            </div>
          }
        >
          {extractedPreview == null ? (
            <p className="p-3 text-[11px] text-amber-800 dark:text-amber-200">
              No extracted events — pick an event array path (or click <span className="font-semibold">Use as Event Array</span> on a tree row).
            </p>
          ) : (
            <div className="p-2">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <label className="text-[10px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">
                  Sample
                  <select
                    value={previewIndexClamped}
                    onChange={(e) => setPreviewIndex(Number(e.target.value))}
                    className="ml-1 h-7 rounded border border-slate-200/90 px-1 font-mono text-[10px] text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:[color-scheme:dark]"
                  >
                    {extractedEvents.map((_, i) => (
                      <option key={i} value={i}>
                        {formatPreviewSamplePath(paths.eventArrayPath || '$', i)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void copyValue(formatJson(extractedPreview), 'Extracted event JSON copied')}
                  className="inline-flex h-7 items-center gap-1 rounded border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                >
                  <Copy className="h-3 w-3" aria-hidden />
                  Copy
                </button>
              </div>
              {extractedView === 'json' ? (
                <>
                  <pre className="gdc-thin-scroll overflow-x-auto rounded-md border border-slate-200/80 bg-slate-950 p-3 text-[10px] text-emerald-200">
                    {formatJson(extractedPreview)}
                  </pre>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">
                    ~{extractedBytes.toLocaleString()} bytes · {fieldRows.length} fields
                  </p>
                </>
              ) : (
                <div className="rounded-md border border-slate-200/80 dark:border-gdc-border">
                  <table className="w-full text-left text-[10px]">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-gdc-section">
                      <tr>
                        <th className="px-2 py-1 font-semibold text-slate-600 dark:text-gdc-mutedStrong">Field</th>
                        <th className="px-2 py-1 font-semibold text-slate-600 dark:text-gdc-mutedStrong">Value</th>
                        <th className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {fieldRows.map((row) => (
                        <tr key={row.path} className="group border-t border-slate-100 dark:border-gdc-border">
                          <td className="px-2 py-1 font-mono text-violet-800 dark:text-violet-200">{row.key}</td>
                          <td className="max-w-[200px] truncate px-2 py-1 text-slate-700 dark:text-slate-200">
                            {truncate(String(row.value ?? '—'), 64)}
                          </td>
                          <td className="px-1 py-1 opacity-0 group-hover:opacity-100">
                            <div className="flex gap-0.5">
                              <button
                                type="button"
                                title="Copy path"
                                onClick={() => void copyValue(row.path, 'Path copied')}
                                className="rounded border border-slate-200/90 bg-white px-1 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                              >
                                <ListTree className="h-3 w-3" aria-hidden />
                              </button>
                              <button
                                type="button"
                                title="Copy value"
                                onClick={() => void copyValue(formatJson(row.value), 'Value copied')}
                                className="rounded border border-slate-200/90 bg-white px-1 text-slate-600 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                              >
                                <Hash className="h-3 w-3" aria-hidden />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </PanelChrome>

        <IncrementalRequestPanel
          state={state}
          checkpointTestRecords={checkpointTestRecords}
          previewRecord={extractedPreview}
          eventArrayPath={paths.eventArrayPath}
          eventRootPath={paths.eventRootPath}
          checkpointSourcePath={paths.checkpointSourcePath}
          checkpointFieldType={state.stream.checkpointFieldType}
          pattern={state.stream.incrementalRequestPattern}
          draft={state.stream.incrementalRequestDraft}
          onChange={(patch) => onStreamPatch?.(patch)}
          onClearCheckpoint={() => onSetCheckpoint({ checkpointSourcePath: '', checkpointFieldType: '' })}
          onCopy={(text) => void copyValue(text, 'Request template copied')}
        />
        </div>
      </div>

    </section>
  )
}

function SelectionStatusChips({
  eventArrayPath,
  eventRootPath,
  eventRootInteracted,
  recordsCount,
  checkpointPath,
  checkpointType,
  recordPathConfirmed,
  recordPathStale,
  checkpointConfirmed,
  checkpointStale,
}: {
  eventArrayPath: string
  eventRootPath: string
  eventRootInteracted: boolean
  recordsCount: number
  checkpointPath: string
  checkpointType: string
  recordPathConfirmed: boolean
  recordPathStale: boolean
  checkpointConfirmed: boolean
  checkpointStale: boolean
}) {
  const eventSourceSelected = Boolean(eventArrayPath)
  const eventRootActive = Boolean(eventRootPath) || eventRootInteracted
  const checkpointSelected = Boolean(checkpointPath)
  const recordPathTone = recordPathStale ? 'stale' : recordPathConfirmed ? 'ok' : eventSourceSelected ? 'stale' : 'idle'
  const checkpointTone = checkpointStale ? 'stale' : checkpointConfirmed ? 'ok' : checkpointSelected ? 'stale' : 'idle'
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
      <StatusChip
        label="Record Path"
        importance={SAMPLE_RECORD_FIELD_IMPORTANCE.recordPath}
        importanceHelp={FIELD_IMPORTANCE_HELP.recordPath}
        value={
          recordPathStale && eventSourceSelected
            ? `${eventArrayPath} · stale`
            : eventArrayPath || 'Not confirmed'
        }
        tone={recordPathTone}
      />
      <StatusChip
        label="Event Root"
        importance={SAMPLE_RECORD_FIELD_IMPORTANCE.eventRoot}
        importanceHelp={FIELD_IMPORTANCE_HELP.eventRoot}
        value={eventRootPath ? eventRootPath : eventRootInteracted ? '(entire record)' : 'Not selected'}
        tone={eventRootActive ? 'ok' : 'idle'}
      />
      <StatusChip
        label={recordsCount === 1 ? 'record' : 'records'}
        value={String(recordsCount)}
        tone="info"
        reverse
      />
      <StatusChip
        label="Checkpoint"
        importance={SAMPLE_RECORD_FIELD_IMPORTANCE.checkpoint}
        importanceHelp={FIELD_IMPORTANCE_HELP.checkpoint}
        value={
          checkpointStale && checkpointSelected
            ? `${checkpointPath}${checkpointType ? ` · ${checkpointType}` : ''} · stale`
            : checkpointSelected
              ? `${checkpointPath}${checkpointType ? ` · ${checkpointType}` : ''}`
              : 'Not confirmed'
        }
        tone={checkpointTone}
      />
    </div>
  )
}

function StatusChip({
  label,
  importance,
  importanceHelp,
  value,
  tone,
  reverse,
}: {
  label: string
  importance?: (typeof SAMPLE_RECORD_FIELD_IMPORTANCE)[keyof typeof SAMPLE_RECORD_FIELD_IMPORTANCE]
  importanceHelp?: string
  value: string
  tone: 'ok' | 'idle' | 'info' | 'stale'
  reverse?: boolean
}) {
  const toneClasses = {
    ok: 'border-emerald-500 bg-emerald-100 text-emerald-900 ring-1 ring-emerald-400/40 dark:border-emerald-400 dark:bg-emerald-500/25 dark:text-emerald-50 dark:ring-emerald-400/40',
    idle: 'border-slate-200/90 bg-slate-50 text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
    info: 'border-slate-200/90 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
    stale:
      'border-amber-400/80 bg-amber-50 text-amber-900 ring-1 ring-amber-300/50 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5', toneClasses)}>
      {tone === 'ok' ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-300" aria-hidden />
      ) : tone === 'stale' ? (
        <AlertTriangle className="h-3 w-3 text-amber-700 dark:text-amber-200" aria-hidden />
      ) : (
        <span
          className={cn(
            'inline-flex h-1.5 w-1.5 rounded-full',
            tone === 'info' ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-500',
          )}
          aria-hidden
        />
      )}
      {reverse ? (
        <>
          <span className="font-semibold">{value}</span>
          <span className="text-[10px] opacity-80">{label}</span>
        </>
      ) : (
        <>
          <span className="inline-flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide opacity-75">{label}</span>
            {importance ? <FieldImportanceBadge importance={importance} title={importanceHelp} /> : null}
          </span>
          <span className={cn('font-mono', tone === 'idle' ? '' : 'font-semibold')}>{value}</span>
        </>
      )}
    </span>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const PATTERN_OPTION_META: Record<
  IncrementalPatternSelectValue,
  { label: string; subtitle: string }
> = {
  none: { label: 'None', subtitle: 'Do not modify the HTTP request' },
  query_params: { label: 'Query Parameters', subtitle: 'Append checkpoint filters as URL query parameters (GET)' },
  json_body: { label: 'JSON Body', subtitle: 'Send checkpoint filters in a JSON request body (POST/PUT/PATCH)' },
  custom: {
    label: 'Custom Body',
    subtitle: 'Write your own template — JSON body for POST/PUT/PATCH, or key=value lines for GET query params',
  },
  elasticsearch: {
    label: 'Elasticsearch / Search Body',
    subtitle: 'Use a range query in a search request body',
  },
}

function lastTestStatusLabel(
  pattern: IncrementalRequestPattern,
  result: WizardConfigState['incrementalRequestTestResult'],
  signature: string,
  testSignature: string | null,
): string {
  if (pattern === 'none') return '—'
  if (!result || result.signature !== signature) {
    if (testSignature === signature) return 'Passed (previous run)'
    return 'Not tested'
  }
  if (result.status === 'success') {
    return result.httpStatus != null ? `Success · ${result.httpStatus}` : 'Success'
  }
  return result.httpStatus != null ? `Failed · ${result.httpStatus}` : 'Failed'
}

function IncrementalRequestPanel({
  state,
  checkpointTestRecords,
  previewRecord,
  eventArrayPath,
  eventRootPath,
  checkpointSourcePath,
  checkpointFieldType,
  pattern,
  draft,
  onChange,
  onClearCheckpoint,
  onCopy,
}: {
  state: WizardState
  checkpointTestRecords: Array<Record<string, unknown>>
  previewRecord: Record<string, unknown> | null
  eventArrayPath: string
  eventRootPath: string
  checkpointSourcePath: string
  checkpointFieldType: WizardCheckpointFieldType
  pattern: IncrementalRequestPattern
  draft: string
  onChange: (patch: Partial<WizardConfigState>) => void
  onClearCheckpoint: () => void
  onCopy: (text: string) => void
}) {
  const fieldFull = fieldNameFromCheckpointPath(checkpointSourcePath)
  const hasCheckpoint = Boolean(fieldFull)
  const checkpointPathOnRecord = useMemo(
    () => resolveCheckpointPathForRecord(checkpointSourcePath, eventArrayPath),
    [checkpointSourcePath, eventArrayPath],
  )
  const sampleValue = useMemo(
    () =>
      hasCheckpoint && previewRecord
        ? eventRootPath.trim()
          ? readCheckpointFromExtractedEvent(
              previewRecord,
              checkpointSourcePath,
              eventArrayPath,
              eventRootPath,
            )
          : readCheckpointFromEventSourceRecord(
              previewRecord,
              checkpointPathOnRecord || checkpointSourcePath,
              eventRootPath,
            )
        : undefined,
    [previewRecord, checkpointPathOnRecord, checkpointSourcePath, eventArrayPath, eventRootPath, hasCheckpoint],
  )
  const { testing, testDisabled, testDisabledReason, runTest, signature } = useIncrementalRequestTest({
    state,
    eventSourceRecords: checkpointTestRecords,
    previewRecord,
    eventArrayPath,
    eventRootPath,
    checkpointSourcePath,
    checkpointFieldType,
    pattern,
    draft,
    resolvedSampleValue: sampleValue,
    onStreamPatch: onChange,
  })
  const detectedTypeLabel = checkpointFieldType || sampleValueTypeLabel(sampleValue)

  useEffect(() => {
    const inferred = inferIncrementalRequestPattern({
      endpoint: state.stream.endpoint,
      requestBody: state.stream.requestBody,
      httpMethod: state.stream.httpMethod,
    })
    if (inferred !== 'visualsearch_query') return
    // Only auto-apply visualsearch_query from endpoint/body hints when no
    // operator pattern has been chosen yet. Preserve explicit user selection.
    if (pattern !== 'none') return
    const generated = buildIncrementalRequestPlan(inferred, checkpointSourcePath)
    onChange({
      incrementalRequestPattern: inferred,
      ...(generated?.preview ? { incrementalRequestDraft: generated.preview } : {}),
    })
  }, [
    state.stream.endpoint,
    state.stream.requestBody,
    state.stream.httpMethod,
    checkpointSourcePath,
    pattern,
    onChange,
  ])

  const generated = useMemo(
    () => buildIncrementalRequestPlan(pattern, checkpointSourcePath),
    [pattern, checkpointSourcePath],
  )

  const httpMethod = state.stream.httpMethod
  const patternOptions = useMemo(() => availableIncrementalPatterns(httpMethod), [httpMethod])
  const selectValue = incrementalPatternSelectValue(pattern)
  const patternLabel = incrementalPatternDisplayLabel(pattern)
  const previewKindLabel = incrementalPreviewKindLabel(pattern, draft, httpMethod)
  const testStatus = lastTestStatusLabel(
    pattern,
    state.stream.incrementalRequestTestResult,
    signature,
    state.stream.incrementalRequestTestSignature,
  )
  const testResultVisible = Boolean(
    state.stream.incrementalRequestTestResult &&
      state.stream.incrementalRequestTestResult.signature === signature,
  )
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Auto-fill the draft when the user picks a non-custom pattern with a valid checkpoint, but
  // only when the current draft is empty / matches a known generated template — don't clobber
  // edits the operator has already made.
  useEffect(() => {
    if (pattern === 'none') {
      if (draft !== '') onChange({ incrementalRequestDraft: '' })
      return
    }
    if (pattern === 'custom' || pattern === 'visualsearch_query') return
    const next = generated?.preview ?? ''
    if (!draft && next) onChange({ incrementalRequestDraft: next })
  }, [pattern, generated, draft, onChange])

  const setPattern = useCallback(
    (nextSelect: IncrementalPatternSelectValue) => {
      const next = incrementalPatternFromSelect(nextSelect, pattern)
      const generatedNext = buildIncrementalRequestPlan(next, checkpointSourcePath)
      const patch: Partial<WizardConfigState> = { incrementalRequestPattern: next }
      if (next === 'none') {
        patch.incrementalRequestDraft = ''
      } else if (next !== 'custom' && next !== 'visualsearch_query') {
        patch.incrementalRequestDraft = generatedNext?.preview ?? ''
      } else if (nextSelect === 'custom' && next === 'custom') {
        // Preserve operator draft when switching to Custom Body.
      } else if (next === 'visualsearch_query' && !draft.trim()) {
        patch.incrementalRequestDraft = generatedNext?.preview ?? ''
      }
      onChange(patch)
    },
    [checkpointSourcePath, draft, onChange, pattern],
  )

  const setDraft = useCallback(
    (next: string) => onChange({ incrementalRequestDraft: next }),
    [onChange],
  )

  const generateDisabled =
    !hasCheckpoint && pattern !== 'custom' && pattern !== 'none' && pattern !== 'visualsearch_query'
  const activeOption = PATTERN_OPTION_META[selectValue] ?? PATTERN_OPTION_META.none
  const draftPlaceholder =
    pattern === 'none'
      ? '// Select a pattern above to get started.'
      : pattern === 'custom' || pattern === 'visualsearch_query'
        ? isBodyHttpMethodForPlaceholder(httpMethod)
          ? '// Custom JSON body — use {{checkpoint.last_timestamp}}, {{now}}, {{checkpoint.last_id}}.'
          : '// Custom template — JSON body or `key=value` lines for query params.\n// You can use {{checkpoint.last_timestamp}}, {{now}}, {{checkpoint.last_id}}.'
        : '// Pick a checkpoint field to populate this template.'

  return (
    <>
    <div
      id="record-selection-incremental-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white p-2.5 dark:border-gdc-border dark:bg-gdc-card"
    >
      <div className="flex shrink-0 items-center gap-2">
        <Wand2 className="h-3.5 w-3.5 text-violet-600 dark:text-violet-300" aria-hidden />
        <h4 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Incremental request</h4>
      </div>

      <div className="gdc-thin-scroll mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-0.5">
      <div className="rounded-md border border-slate-200/70 bg-slate-50/70 p-2 dark:border-gdc-border dark:bg-gdc-elevated">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <NumberBadge n={1} />
            <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Selected checkpoint field</p>
          </div>
          {hasCheckpoint ? (
            <button
              type="button"
              onClick={onClearCheckpoint}
              className="inline-flex h-6 items-center gap-1 rounded border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              title="Clear the checkpoint to pick a different field from the tree"
            >
              Change field
            </button>
          ) : null}
        </div>
        {hasCheckpoint ? (
          <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
            <KvCell label="Field" value={fieldFull} mono />
            <KvCell label="Type" value={detectedTypeLabel || '—'} />
            <KvCell label="Example" value={formatSample(sampleValue)} mono />
          </div>
        ) : (
          <p className="mt-1.5 text-[11px] text-slate-500 dark:text-gdc-mutedStrong">
            Pick a checkpoint by clicking the bookmark icon on any leaf row in the tree (or choose{' '}
            <span className="font-semibold">Custom Body</span> below to write a template manually).
          </p>
        )}
      </div>

      <div className="mt-2 rounded-md border border-slate-200/70 p-2 dark:border-gdc-border">
        <div className="flex flex-wrap items-center gap-2">
          <NumberBadge n={2} />
          <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Incremental pattern</p>
          <select
            value={selectValue}
            onChange={(e) => setPattern(e.target.value as IncrementalPatternSelectValue)}
            className="ml-auto h-7 max-w-full rounded border border-slate-200/90 bg-white px-2 text-[11px] text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:[color-scheme:dark]"
            aria-label="Incremental pattern"
            data-testid="incremental-pattern-select"
          >
            {patternOptions.map((value) => (
              <option key={value} value={value}>
                {PATTERN_OPTION_META[value].label}
              </option>
            ))}
          </select>
        </div>
        {generateDisabled ? (
          <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
            Pick a checkpoint field first, or switch to <span className="font-semibold">Custom Body</span>.
          </p>
        ) : (
          <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">{activeOption.subtitle}</p>
        )}
      </div>

      <div className="mt-2 rounded-md border border-slate-200/70 p-2 dark:border-gdc-border">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <NumberBadge n={3} />
            <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Request summary</p>
          </div>
          {pattern !== 'none' ? (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex h-7 items-center gap-1 rounded bg-violet-600 px-2.5 text-[10px] font-semibold text-white hover:bg-violet-700"
              data-testid="open-request-preview-button"
            >
              Open Request Preview
            </button>
          ) : null}
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-3">
          <div>
            <dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong">
              Pattern
            </dt>
            <dd className="font-medium text-slate-800 dark:text-slate-100" data-testid="incremental-pattern-summary">
              {patternLabel}
            </dd>
          </div>
          <div>
            <dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong">
              Preview type
            </dt>
            <dd className="font-medium text-slate-800 dark:text-slate-100" data-testid="incremental-preview-type-summary">
              {pattern === 'none' ? '—' : previewKindLabel}
            </dd>
          </div>
          <div>
            <dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong">
              Last test status
            </dt>
            <dd
              className={cn(
                'font-medium',
                testStatus.startsWith('Success')
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : testStatus.startsWith('Failed')
                    ? 'text-red-700 dark:text-red-300'
                    : 'text-slate-800 dark:text-slate-100',
              )}
              data-testid="incremental-last-test-status"
            >
              {testStatus}
            </dd>
          </div>
        </dl>
        {pattern !== 'none' && testDisabled && testDisabledReason ? (
          <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-mutedStrong">{testDisabledReason}</p>
        ) : null}
      </div>
      </div>
    </div>

    <RequestPreviewDrawer
      open={drawerOpen}
      title="Request Preview"
      previewKindLabel={previewKindLabel}
      onClose={() => setDrawerOpen(false)}
      draft={draft}
      onDraftChange={setDraft}
      draftDisabled={pattern === 'none'}
      draftPlaceholder={draftPlaceholder}
      splitResults={testResultVisible}
      toolbar={
        <div className="flex items-center gap-1">
          {pattern !== 'none' ? (
            <IncrementalRequestTestButton
              testing={testing}
              disabled={testDisabled}
              disabledReason={testDisabledReason}
              onClick={() => void runTest()}
            />
          ) : null}
          {pattern !== 'none' && pattern !== 'custom' && pattern !== 'visualsearch_query' ? (
            <button
              type="button"
              onClick={() => setDraft(generated?.preview ?? '')}
              disabled={!generated}
              className="inline-flex h-7 items-center gap-1 rounded border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              title="Reset preview back to the auto-generated template"
            >
              Reset
            </button>
          ) : null}
          <RequestPreviewCopyButton disabled={!draft} onClick={() => onCopy(draft)} />
        </div>
      }
      footer="Incremental request template will be applied automatically when the stream is created. The saved stream keeps template placeholders — only the Test call substitutes checkpoint values."
    >
      <IncrementalRequestTestSection
        state={state}
        pattern={pattern}
        testDisabled={testDisabled}
        testDisabledReason={testDisabledReason}
        signature={signature}
        drawerLayout
      />
    </RequestPreviewDrawer>
    </>
  )
}

function isBodyHttpMethodForPlaceholder(httpMethod: string): boolean {
  return ['POST', 'PUT', 'PATCH'].includes(httpMethod.trim().toUpperCase())
}

function NumberBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[9px] font-bold text-white">
      {n}
    </span>
  )
}

function KvCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong">{label}</p>
      <p
        className={cn(
          'truncate text-[11px] text-slate-800 dark:text-slate-100',
          mono && 'font-mono',
        )}
        title={value}
      >
        {value || '—'}
      </p>
    </div>
  )
}

function formatSample(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value.length > 48 ? `${value.slice(0, 48)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const s = JSON.stringify(value)
    return s.length > 48 ? `${s.slice(0, 48)}…` : s
  } catch {
    return String(value)
  }
}

