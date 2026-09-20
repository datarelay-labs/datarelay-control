import { AlertTriangle, Eye, Layers, Loader2, Maximize2, ShieldCheck } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runTransformPreview, type TransformPreviewResponse } from '../../../api/gdcRuntimePreview'
import { FULL_EVENT_JSONATA_GUIDANCE, FULL_EVENT_REGEX_GUIDANCE } from '../../../types/advancedTransform'
import { cn } from '../../../lib/utils'
import { buildRepresentativeEventFromUnionSchema, type UnionSchema } from '../../../utils/unionSchema'
import {
  getUnionSchemaSampleStatus,
  resolveUnionSchemaSampleCount,
} from '../../../utils/unionSchemaSamplePolicy'
import { TimestampUtcTransformGuide } from '../../transform/timestamp-utc-transform-guide'
import { ResizableSplit } from '../../ui/resizable-split'
import { MappingJsonTree, PanelChrome, type MappingJsonTreeExpandStrategy } from '../mapping-json-tree'
import { UnionSchemaTreeDetailLayout } from '../union-schema-tree-detail-layout'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import { UnionSchemaSamplePolicyBanner } from './union-schema-sample-policy-banner'
import {
  buildWizardJsonataPreviewFieldMappings,
  runWizardLocalTransformPreview,
} from './wizard-full-event-preview'
import {
  buildFieldMappingsFromFullEventRegexConfigJson,
  fullEventRegexConfigParseError,
  FULL_EVENT_REGEX_CONFIG_PLACEHOLDER,
  parseFullEventRegexConfigText,
} from './wizard-full-event-regex-config'

const EMPTY_SAMPLE_MESSAGE = 'Run API Test / JSON Preview first to load a sample event.'
const PREVIEW_RESULT_IDLE_JSONATA = 'Enter a JSONata expression that returns a JSON object to see the preview.'
const PREVIEW_RESULT_IDLE_REGEX =
  'Paste a valid regex transform JSON config, then click Preview to see the final mapped event object.'
const PREVIEW_DEBOUNCE_MS = 400

const JSONATA_TEXTAREA_CLASS =
  'min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-slate-50/50 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-0 dark:bg-slate-950/90 dark:text-emerald-100 dark:placeholder:text-slate-500'

const FULL_EVENT_EDITOR_SURFACE_CLASS =
  'flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-slate-200/90 dark:border-gdc-border'

const FULL_EVENT_EDITOR_HEADER_CLASS =
  'flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 bg-slate-50/80 px-2.5 py-1.5 dark:border-gdc-border dark:bg-gdc-section/90'

const WORKSPACE_SHELL_CLASS = 'h-[min(88vh,960px)] min-h-[min(88vh,960px)]'

export type WizardFullEventTransformWorkspaceProps = {
  sampleEvent: Record<string, unknown> | null
  unionSchema?: UnionSchema | null
  enrichment?: readonly WizardEnrichmentRule[]
  eventCount?: number
  jsonataExpression: string
  onJsonataExpressionChange: (expression: string) => void
  fullEventRegexConfigJson: string
  onFullEventRegexConfigJsonChange: (json: string) => void
  filterUiMode: 'advanced' | 'expert'
}

function issueLabel(item: { code?: string | null; message?: string; error_message?: string }): string {
  return item.message || item.error_message || item.code || 'Unknown issue'
}

type SourceSchemaPanelProps = {
  sampleEvent: Record<string, unknown> | null
  unionSchema: UnionSchema | null
  enrichment: readonly WizardEnrichmentRule[]
  eventCount: number
}

const SourceSchemaPanel = memo(function SourceSchemaPanel({
  sampleEvent,
  unionSchema,
  enrichment,
  eventCount,
}: SourceSchemaPanelProps) {
  const [sampleView, setSampleView] = useState<'tree' | 'json'>('tree')
  const [treeExpandStrategy, setTreeExpandStrategy] = useState<MappingJsonTreeExpandStrategy>('smart')
  const [treeMountKey, setTreeMountKey] = useState(0)
  const [selectedUnionPath, setSelectedUnionPath] = useState<string | null>(null)

  const samplePolicy = getUnionSchemaSampleStatus(
    resolveUnionSchemaSampleCount({
      unionSchema,
      eventCount,
      extractedEvents: sampleEvent ? [sampleEvent] : [],
    }),
  )

  const rawSampleJson = useMemo(() => {
    if (unionSchema) return JSON.stringify(buildRepresentativeEventFromUnionSchema(unionSchema), null, 2)
    return sampleEvent ? JSON.stringify(sampleEvent, null, 2) : ''
  }, [sampleEvent, unionSchema])

  const hasSchemaSource = Boolean(unionSchema || sampleEvent)
  const panelTitle = unionSchema ? 'Union Schema' : 'Source Event'

  const expandAll = useCallback(() => {
    setTreeExpandStrategy('all')
    setTreeMountKey((k) => k + 1)
  }, [])

  const collapseAll = useCallback(() => {
    setTreeExpandStrategy('minimal')
    setTreeMountKey((k) => k + 1)
  }, [])

  return (
    <PanelChrome
      fillParent
      className="h-full min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
      title={panelTitle}
      right={
        hasSchemaSource ? (
          <div className="flex items-center gap-1.5">
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
            {sampleView === 'tree' ? (
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
            ) : null}
          </div>
        ) : null
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {unionSchema ? (
          <div className="shrink-0 space-y-0.5 border-b border-slate-200/70 px-2.5 py-2 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
            <p>
              <span className="font-semibold text-slate-700 dark:text-slate-200">Records: </span>
              {eventCount}
            </p>
            <UnionSchemaSamplePolicyBanner policy={samplePolicy} className="mt-2" />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {!hasSchemaSource ? (
            <p className="rounded-md border border-dashed border-amber-200/80 bg-amber-500/[0.06] px-3 py-6 text-center text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
              {EMPTY_SAMPLE_MESSAGE}
            </p>
          ) : sampleView === 'tree' && unionSchema ? (
            <UnionSchemaTreeDetailLayout
              key={`${treeMountKey}-${treeExpandStrategy}`}
              className="min-h-0"
              schema={unionSchema}
              search=""
              onPickPath={() => {}}
              expandStrategy={treeExpandStrategy}
              selectedPath={selectedUnionPath}
              onSelectPath={setSelectedUnionPath}
              generatedRules={enrichment}
            />
          ) : sampleView === 'tree' && sampleEvent ? (
            <div data-testid="mapping-json-tree-fallback">
              <MappingJsonTree
                key={`${treeMountKey}-${treeExpandStrategy}`}
                value={sampleEvent}
                baseLabel="event"
                basePath="$"
                search=""
                onPickPath={() => {}}
                expandStrategy={treeExpandStrategy}
              />
            </div>
          ) : (
            <pre className="min-h-full overflow-auto rounded-md border border-slate-200/80 bg-slate-950/90 p-2 text-[10px] leading-snug text-emerald-100 dark:border-gdc-border">
              {rawSampleJson}
            </pre>
          )}
        </div>
      </div>
    </PanelChrome>
  )
})

export function WizardFullEventTransformWorkspace({
  sampleEvent,
  unionSchema = null,
  enrichment = [],
  eventCount = 0,
  jsonataExpression,
  onJsonataExpressionChange,
  fullEventRegexConfigJson,
  onFullEventRegexConfigJsonChange,
  filterUiMode,
}: WizardFullEventTransformWorkspaceProps) {
  const isExpertMode = filterUiMode === 'expert'
  const regexConfigTrimmed = fullEventRegexConfigJson.trim()

  const parsedRegexConfig = useMemo(
    () => (isExpertMode ? parseFullEventRegexConfigText(regexConfigTrimmed) : null),
    [isExpertMode, regexConfigTrimmed],
  )

  const [preview, setPreview] = useState<TransformPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewFingerprint, setPreviewFingerprint] = useState<string | null>(null)
  const [previewSucceeded, setPreviewSucceeded] = useState(false)
  const [autoPreviewPending, setAutoPreviewPending] = useState(false)
  const previewReqIdRef = useRef(0)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const expressionTrimmed = jsonataExpression.trim()
  const regexConfigValid = parsedRegexConfig?.ok === true

  const currentFingerprint = useMemo(
    () => (isExpertMode ? regexConfigTrimmed : expressionTrimmed),
    [isExpertMode, regexConfigTrimmed, expressionTrimmed],
  )

  const configChangedAfterPreview =
    previewSucceeded && previewFingerprint != null && previewFingerprint !== currentFingerprint

  const previewFieldMappings = useMemo(() => {
    if (isExpertMode) {
      if (!regexConfigValid || !parsedRegexConfig?.ok) return null
      const built = buildFieldMappingsFromFullEventRegexConfigJson(regexConfigTrimmed)
      return built.ok ? built.fieldMappings : null
    }
    return buildWizardJsonataPreviewFieldMappings(expressionTrimmed)
  }, [isExpertMode, regexConfigTrimmed, regexConfigValid, parsedRegexConfig, expressionTrimmed])

  const runLocalPreview = useCallback((): TransformPreviewResponse | null => {
    if (!sampleEvent) return null
    if (isExpertMode) {
      if (!parsedRegexConfig?.ok) return null
      return runWizardLocalTransformPreview(sampleEvent, {
        isExpert: true,
        regexConfig: parsedRegexConfig.config,
      })
    }
    return runWizardLocalTransformPreview(sampleEvent, {
      isExpert: false,
      expression: expressionTrimmed,
    })
  }, [sampleEvent, isExpertMode, parsedRegexConfig, expressionTrimmed])

  const runPreview = useCallback(
    async (fingerprintOverride?: string, opts?: { auto?: boolean }) => {
      const fingerprint = fingerprintOverride ?? currentFingerprint
      const isAuto = opts?.auto === true
      if (!isAuto && previewTimerRef.current) {
        clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
        setAutoPreviewPending(false)
      }

      if (!sampleEvent) {
        setPreviewError(EMPTY_SAMPLE_MESSAGE)
        setPreview(null)
        setPreviewSucceeded(false)
        setPreviewFingerprint(null)
        setAutoPreviewPending(false)
        return
      }

      if (isExpertMode) {
        if (!parsedRegexConfig || !parsedRegexConfig.ok) {
          setPreviewError(
            fullEventRegexConfigParseError(parsedRegexConfig) ??
              'Paste a valid regex transform JSON config.',
          )
          setPreview(null)
          setPreviewSucceeded(false)
          setPreviewFingerprint(null)
          setAutoPreviewPending(false)
          return
        }
        if (!previewFieldMappings) {
          setPreviewError('Could not build field mappings from config.')
          setPreview(null)
          setPreviewSucceeded(false)
          setPreviewFingerprint(null)
          setAutoPreviewPending(false)
          return
        }
      } else if (!expressionTrimmed) {
        setPreviewError('Enter a JSONata expression before previewing.')
        setPreview(null)
        setPreviewSucceeded(false)
        setPreviewFingerprint(null)
        setAutoPreviewPending(false)
        return
      }

      const reqId = ++previewReqIdRef.current
      if (isAuto) setAutoPreviewPending(true)
      else setPreviewLoading(true)
      setPreviewError(null)

      try {
        let res: TransformPreviewResponse
        try {
          res = await runTransformPreview({
            stage: 'mapping',
            sample_event: sampleEvent,
            field_mappings: previewFieldMappings ?? undefined,
          })
        } catch (apiErr) {
          if (isExpertMode) {
            const local = runLocalPreview()
            if (!local) {
              throw apiErr instanceof Error ? apiErr : new Error('Preview request failed')
            }
            res = local
          } else {
            throw apiErr instanceof Error ? apiErr : new Error('JSONata preview request failed')
          }
        }
        if (reqId !== previewReqIdRef.current) return
        setPreview(res)
        const ok = !res.save_blocked
        setPreviewSucceeded(ok)
        setPreviewFingerprint(ok ? fingerprint : null)
      } catch (e) {
        if (reqId !== previewReqIdRef.current) return
        setPreview(null)
        setPreviewError(e instanceof Error ? e.message : 'Preview request failed')
        setPreviewSucceeded(false)
        setPreviewFingerprint(null)
      } finally {
        if (reqId === previewReqIdRef.current) {
          if (isAuto) setAutoPreviewPending(false)
          else setPreviewLoading(false)
        }
      }
    },
    [
      sampleEvent,
      isExpertMode,
      expressionTrimmed,
      parsedRegexConfig,
      previewFieldMappings,
      currentFingerprint,
      runLocalPreview,
    ],
  )

  useEffect(() => {
    if (!isExpertMode) return
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    if (!sampleEvent || !regexConfigValid) {
      previewReqIdRef.current += 1
      setPreview(null)
      setPreviewError(null)
      setPreviewFingerprint(null)
      setPreviewSucceeded(false)
      setPreviewLoading(false)
      setAutoPreviewPending(false)
      return
    }
    setAutoPreviewPending(true)
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null
      void runPreview(currentFingerprint, { auto: true })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
        setAutoPreviewPending(false)
      }
    }
  }, [
    isExpertMode,
    sampleEvent,
    regexConfigValid,
    regexConfigTrimmed,
    parsedRegexConfig,
    currentFingerprint,
    runPreview,
  ])

  useEffect(() => {
    if (isExpertMode) return
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    if (!sampleEvent || !expressionTrimmed) {
      previewReqIdRef.current += 1
      setPreview(null)
      setPreviewError(null)
      setPreviewFingerprint(null)
      setPreviewSucceeded(false)
      setPreviewLoading(false)
      setAutoPreviewPending(false)
      return
    }
    setAutoPreviewPending(true)
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null
      void runPreview(currentFingerprint, { auto: true })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current)
        previewTimerRef.current = null
        setAutoPreviewPending(false)
      }
    }
  }, [sampleEvent, expressionTrimmed, currentFingerprint, runPreview, isExpertMode])

  const previewJson = useMemo(() => {
    if (!preview) return ''
    return JSON.stringify(preview.transformed_result, null, 2)
  }, [preview])

  const workspaceTitle = isExpertMode ? 'Full Event Regex Transform' : 'JSONata Workspace'
  const guidanceLines = isExpertMode ? FULL_EVENT_REGEX_GUIDANCE : FULL_EVENT_JSONATA_GUIDANCE
  const idlePreviewMessage = isExpertMode ? PREVIEW_RESULT_IDLE_REGEX : PREVIEW_RESULT_IDLE_JSONATA
  const readyToSaveMapping =
    previewSucceeded &&
    !preview?.save_blocked &&
    !configChangedAfterPreview &&
    (!isExpertMode || regexConfigValid)

  const previewResultPanel = (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-slate-200/80 bg-slate-50/60 dark:border-gdc-border dark:bg-gdc-section/80"
      aria-live="polite"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/70 px-3 py-2 dark:border-gdc-border">
        <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Preview Result</p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void runPreview(currentFingerprint, { auto: false })}
            disabled={
              previewLoading ||
              !sampleEvent ||
              (isExpertMode ? !regexConfigValid : !expressionTrimmed)
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-violet-500/40 bg-white px-2.5 text-[10px] font-semibold text-violet-700 shadow-sm hover:bg-violet-500/[0.06] disabled:opacity-50 dark:border-violet-500/35 dark:bg-gdc-card dark:text-violet-300"
          >
            {previewLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Eye className="h-3 w-3" aria-hidden />
            )}
            Preview
          </button>
          {configChangedAfterPreview ? (
            <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">Config changed</span>
          ) : null}
          {preview?.save_blocked ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-red-800 dark:text-red-200">
              Save blocked
            </span>
          ) : preview && previewSucceeded && !configChangedAfterPreview ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800 dark:text-emerald-200">
              Preview OK
            </span>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {!preview && !previewError && !previewLoading && !(isExpertMode && parsedRegexConfig && !parsedRegexConfig.ok) ? (
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">{idlePreviewMessage}</p>
        ) : null}
        {isExpertMode && parsedRegexConfig && !parsedRegexConfig.ok && regexConfigTrimmed ? (
          <p className="flex items-start gap-2 rounded-md border border-red-200/80 bg-red-500/[0.06] px-2.5 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {fullEventRegexConfigParseError(parsedRegexConfig)}
          </p>
        ) : null}
        {(previewLoading || autoPreviewPending) && !preview ? (
          <p className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-gdc-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {isExpertMode ? 'Applying regex rules to sample event…' : 'Evaluating JSONata against sample event…'}
          </p>
        ) : null}
        {previewError ? (
          <p className="flex items-start gap-2 rounded-md border border-red-200/80 bg-red-500/[0.06] px-2.5 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {previewError}
          </p>
        ) : null}
        {preview ? (
          <>
            {preview.errors.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-red-200/70 bg-red-500/[0.04] p-2 text-[11px] text-red-900 dark:border-red-500/25 dark:text-red-100">
                {preview.errors.map((e, i) => (
                  <li key={`e-${i}`}>
                    {e.code === 'JSONATA_RESULT_NOT_OBJECT'
                      ? 'JSONata must return a JSON object (not a string, number, boolean, array, or null).'
                      : issueLabel(e)}
                    {e.output_field ? ` (${e.output_field})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-200/70 bg-amber-500/[0.04] p-2 text-[11px] text-amber-900 dark:border-amber-500/25 dark:text-amber-100">
                {preview.warnings.map((w, i) => (
                  <li key={`w-${i}`}>
                    {issueLabel(w)}
                    {w.output_field ? ` (${w.output_field})` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Final mapped event
              </p>
              <pre className="min-h-[80px] overflow-auto rounded-md border border-slate-200/70 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100">
                {previewJson || '{}'}
              </pre>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )

  const fullEventEditorPanel = isExpertMode ? (
    <div className={FULL_EVENT_EDITOR_SURFACE_CLASS}>
      <div className={FULL_EVENT_EDITOR_HEADER_CLASS}>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
          Regex Transform
        </p>
      </div>
      <textarea
        value={fullEventRegexConfigJson}
        onChange={(e) => onFullEventRegexConfigJsonChange(e.target.value)}
        spellCheck={false}
        placeholder={FULL_EVENT_REGEX_CONFIG_PLACEHOLDER}
        aria-label="Full event regex transform JSON config"
        className={JSONATA_TEXTAREA_CLASS}
      />
    </div>
  ) : (
    <div className={FULL_EVENT_EDITOR_SURFACE_CLASS}>
      <div className={FULL_EVENT_EDITOR_HEADER_CLASS}>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
          Full Event JSONata
        </p>
      </div>
      <textarea
        value={jsonataExpression}
        onChange={(e) => onJsonataExpressionChange(e.target.value)}
        spellCheck={false}
        placeholder={`{
  "user": username,
  "domain": $split(username, "@")[1],
  "is_admin": $exists(roles[$ = "sys_admin"])
}`}
        aria-label="Full event JSONata expression"
        className={JSONATA_TEXTAREA_CLASS}
      />
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 px-3 py-2.5 dark:border-gdc-border dark:bg-gdc-section">
        <div className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
          <div className="space-y-1 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            {guidanceLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </div>

      <TimestampUtcTransformGuide
        mode={isExpertMode ? 'regex' : 'jsonata'}
        variant="full_event"
        sampleEvent={sampleEvent}
        onInsertExpression={isExpertMode ? undefined : onJsonataExpressionChange}
      />

      <div className={WORKSPACE_SHELL_CLASS}>
        <ResizableSplit
          direction="row"
          initialRatio={0.4}
          minFirstPx={240}
          minSecondPx={300}
          storageKey="gdc.advanced-transform.col-ratio"
          className="h-full"
          first={
            <SourceSchemaPanel
              sampleEvent={sampleEvent}
              unionSchema={unionSchema}
              enrichment={enrichment}
              eventCount={eventCount}
            />
          }
          second={
            <PanelChrome
              fillParent
              title={workspaceTitle}
              bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
              className="h-full min-h-0"
              right={
                readyToSaveMapping ? (
                  <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    Ready to save
                  </span>
                ) : null
              }
            >
              <ResizableSplit
                direction="column"
                initialRatio={0.5}
                minFirstPx={200}
                minSecondPx={200}
                storageKey="gdc.advanced-transform.row-ratio"
                className="h-full min-h-0 flex-1"
                first={fullEventEditorPanel}
                second={<div className="h-full min-h-0 p-3 pt-0">{previewResultPanel}</div>}
              />
            </PanelChrome>
          }
        />
      </div>
    </div>
  )
}
