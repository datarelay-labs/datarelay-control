import { AlertTriangle, ChevronDown, Database, Layers, Loader2, ShieldCheck, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../lib/utils'
import {
  previewTemplateDraftInference,
  type InferenceCandidate,
} from '../../../api/gdcTemplateDrafts'
import type { WizardMappingRow, WizardState } from './wizard-state'
import {
  analyzeStellarSuggestions,
  applyMetadataMappingWithAutoFallback,
  applySelectedMetadataSuggestions,
  collectTopLevelSourceFieldPaths,
  unmappedTopLevelSourcePaths,
  type StellarSuggestion,
} from './wizard-mapping-merge'

/**
 * Compact dropdown menu for applying schema-targeted metadata mapping
 * suggestions to the wizard mapping rows.
 *
 * Constraints:
 *   - No backend additions: reuses `POST /api/templates/drafts/preview-inference`
 *     via `previewTemplateDraftInference()`. That endpoint runs the existing
 *     `detect_mapping_candidates` heuristic against the wizard's sample event.
 *   - Compact operational style — no fullscreen modal, wizard step move, or
 *     side panel. Popover-only (portal-rendered to avoid clip).
 *   - Apply merges suggestions into existing rows: any candidate whose
 *     `output_field` OR `source_json_path` is already mapped is treated as
 *     already-handled and left alone. Only truly-unmapped candidates are
 *     appended, tagged `origin: 'stellar'`, then any remaining top-level
 *     source fields receive the same Auto-suggest top-level fallback as the
 *     Mapping toolbar (`origin: 'auto'`).
 *
 * UI sketch:
 *
 *   [ Metadata Mapping ▾ ]
 *   │
 *   └─ popover
 *       Schema target
 *         ◉ Stellar Cyber           (active)
 *         ○ Common SIEM             Coming soon
 *         ○ Generic ECS             Coming soon
 *
 *       [Generate / Refresh suggestions]
 *
 *       (loading) Generating metadata mapping…
 *       (loaded) 14 fields matched · 3 unmapped · 2 conflicts
 *                [Apply Suggested Mapping]
 */

type MetadataMappingMenuProps = {
  state: WizardState
  onChangeMapping: (rows: WizardMappingRow[]) => void
}

type SchemaTarget = {
  id: 'stellar' | 'siem' | 'ecs'
  label: string
  description: string
  enabled: boolean
}

const SCHEMA_TARGETS: ReadonlyArray<SchemaTarget> = [
  {
    id: 'stellar',
    label: 'Stellar Cyber',
    description: 'Stellar Cyber Interflow metadata schema (active).',
    enabled: true,
  },
  {
    id: 'siem',
    label: 'Common SIEM',
    description: 'Common SIEM normalization (coming soon).',
    enabled: false,
  },
  {
    id: 'ecs',
    label: 'Generic ECS',
    description: 'Elastic Common Schema (coming soon).',
    enabled: false,
  },
]

type SuggestionRow = StellarSuggestion & {
  confidence: number
  reason: string
}

function normalizeMappingCandidates(raw: ReadonlyArray<InferenceCandidate> | undefined): SuggestionRow[] {
  if (!raw || raw.length === 0) return []
  const out: SuggestionRow[] = []
  for (const c of raw) {
    const outputField = (c.output_field ?? '').trim()
    const sourceJsonPath = (c.source_json_path ?? c.path ?? c.field_path ?? '').trim()
    if (!outputField || !sourceJsonPath) continue
    out.push({
      outputField,
      sourceJsonPath,
      confidence: Number(c.confidence) || 0,
      reason: String(c.reason ?? ''),
    })
  }
  return out
}

function makeRowId(prefix: string): string {
  return `row-${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
}

const POPOVER_WIDTH = 320
const POPOVER_GAP = 4
const VIEWPORT_MARGIN = 8

type PopoverCoords = { top: number; left: number } | null

export function MetadataMappingMenu({ state, onChangeMapping }: MetadataMappingMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<PopoverCoords>(null)
  const [target, setTarget] = useState<SchemaTarget['id']>('stellar')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionRow[] | null>(null)
  const [selectedSuggestionKeys, setSelectedSuggestionKeys] = useState<Set<string>>(new Set())

  const sampleEvent = state.apiTest.extractedEvents[0] ?? null
  const samplePayload = state.apiTest.parsedJson ?? sampleEvent ?? null
  const hasSample = sampleEvent != null

  const computeCoords = useCallback((): PopoverCoords => {
    const el = triggerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const right = Math.min(window.innerWidth - VIEWPORT_MARGIN, rect.right)
    const top = Math.min(window.innerHeight - VIEWPORT_MARGIN, rect.bottom + POPOVER_GAP)
    const left = Math.max(VIEWPORT_MARGIN, right - POPOVER_WIDTH)
    return { top, left }
  }, [])

  const handleToggle = useCallback(() => {
    if (open) {
      setOpen(false)
      return
    }
    setCoords(computeCoords())
    setOpen(true)
  }, [computeCoords, open])

  useEffect(() => {
    if (!open) return
    const recompute = () => setCoords(computeCoords())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onClickOutside = (e: MouseEvent) => {
      const tgt = e.target as Node | null
      if (triggerRef.current?.contains(tgt as Node)) return
      const pop = document.getElementById('metadata-mapping-popover')
      if (pop && tgt && pop.contains(tgt as Node)) return
      setOpen(false)
    }
    window.addEventListener('resize', recompute)
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClickOutside)
    return () => {
      window.removeEventListener('resize', recompute)
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClickOutside)
    }
  }, [open, computeCoords])

  const sampleRecord = sampleEvent && typeof sampleEvent === 'object' && !Array.isArray(sampleEvent)
    ? (sampleEvent as Record<string, unknown>)
    : null

  const analysis = useMemo(() => {
    if (!suggestions) return null
    return analyzeStellarSuggestions(state.mapping, suggestions)
  }, [state.mapping, suggestions])

  const sourceFieldStats = useMemo(() => {
    const total = collectTopLevelSourceFieldPaths(sampleRecord).length
    const currentlyUnmapped = unmappedTopLevelSourcePaths(state.mapping, sampleRecord).length
    return { total, currentlyUnmapped }
  }, [sampleRecord, state.mapping])

  const applyPreview = useMemo(() => {
    if (!suggestions || !sampleRecord) return null
    return applyMetadataMappingWithAutoFallback(state.mapping, suggestions, sampleRecord, () => 'preview')
  }, [sampleRecord, state.mapping, suggestions])

  const generateSuggestions = useCallback(async () => {
    if (busy || !hasSample) return
    setBusy(true)
    setError(null)
    try {
      const inference = await previewTemplateDraftInference({
        sample_payload: samplePayload,
        approved_event_array_path:
          state.stream.useWholeResponseAsEvent || !state.stream.eventArrayPath.trim()
            ? null
            : state.stream.eventArrayPath.trim(),
        source_type: state.connector.sourceType || 'HTTP_API_POLLING',
      })
      const nextSuggestions = normalizeMappingCandidates(inference.mapping_candidates)
      setSuggestions(nextSuggestions)
      setSelectedSuggestionKeys(new Set(nextSuggestions.filter((item) => item.confidence >= 0.85).map((item) => `${item.sourceJsonPath}→${item.outputField}`)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate output field suggestions.')
      setSuggestions(null)
    } finally {
      setBusy(false)
    }
  }, [
    busy,
    hasSample,
    samplePayload,
    state.connector.sourceType,
    state.stream.eventArrayPath,
    state.stream.useWholeResponseAsEvent,
  ])

  const applySuggestions = useCallback(() => {
    if (!suggestions || !sampleRecord) return
    const selected = suggestions.filter((item) => selectedSuggestionKeys.has(`${item.sourceJsonPath}→${item.outputField}`))
    onChangeMapping(applySelectedMetadataSuggestions(state.mapping, selected, () => makeRowId('merge')))
    setOpen(false)
  }, [onChangeMapping, sampleRecord, selectedSuggestionKeys, state.mapping, suggestions])

  const canApply =
    hasSample &&
    suggestions != null &&
    applyPreview != null &&
    selectedSuggestionKeys.size > 0

  const popoverStyle: CSSProperties | null = coords
    ? { position: 'fixed', top: coords.top, left: coords.left, width: POPOVER_WIDTH, zIndex: 50 }
    : null

  const triggerLabel = 'Output field profile'
  const disabledRunReason = !hasSample
    ? 'Run the Fetch Sample Data step first so we can derive a sample event.'
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12px] font-semibold shadow-sm transition-colors',
          'border-violet-300/70 bg-violet-50 text-violet-800 hover:bg-violet-100',
          'dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100 dark:hover:bg-violet-500/20',
        )}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        {triggerLabel}
        <ChevronDown className="h-3.5 w-3.5 opacity-70" aria-hidden />
      </button>

      {open && popoverStyle
        ? createPortal(
            <div
              id="metadata-mapping-popover"
              role="menu"
              style={popoverStyle}
              className="rounded-lg border border-slate-200/90 bg-white p-3 shadow-xl dark:border-gdc-border dark:bg-gdc-card"
            >
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-mutedStrong">
                <Layers className="h-3 w-3" aria-hidden />
                Schema target
              </p>
              <ul className="mt-1.5 space-y-1">
                {SCHEMA_TARGETS.map((t) => {
                  const selected = target === t.id
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        disabled={!t.enabled}
                        onClick={() => setTarget(t.id)}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
                          selected
                            ? 'border-violet-400 bg-violet-50 dark:border-violet-500/60 dark:bg-violet-500/10'
                            : 'border-slate-200/80 bg-white hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:hover:bg-gdc-rowHover',
                          !t.enabled && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                            selected
                              ? 'border-violet-600 bg-violet-600'
                              : 'border-slate-300 bg-white dark:border-gdc-border dark:bg-gdc-section',
                          )}
                          aria-hidden
                        >
                          {selected ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            {t.id === 'stellar' ? (
                              <ShieldCheck className="h-3 w-3 text-violet-600 dark:text-violet-300" aria-hidden />
                            ) : (
                              <Database className="h-3 w-3 text-slate-400" aria-hidden />
                            )}
                            <span className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">
                              {t.label}
                            </span>
                            {!t.enabled ? (
                              <span className="ml-auto inline-flex items-center rounded-full border border-slate-200/90 bg-slate-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong">
                                Soon
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-[10px] leading-snug text-slate-500 dark:text-gdc-muted">
                            {t.description}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>

              <div className="mt-3 border-t border-slate-200/70 pt-2 dark:border-gdc-border">
                <button
                  type="button"
                  onClick={() => void generateSuggestions()}
                  disabled={busy || !hasSample}
                  title={disabledRunReason ?? undefined}
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Generating output field suggestions…
                    </>
                  ) : suggestions ? (
                    <>
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      Refresh suggestions
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      Generate suggestions
                    </>
                  )}
                </button>
                {disabledRunReason ? (
                  <p className="mt-1 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                    {disabledRunReason}
                  </p>
                ) : null}
                {error ? (
                  <p className="mt-1.5 flex items-start gap-1 rounded border border-red-300/70 bg-red-50 px-1.5 py-1 text-[10px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                ) : null}
              </div>

              {analysis && applyPreview ? (
                <div className="mt-2 rounded-md border border-slate-200/80 bg-slate-50/70 p-2 text-[11px] dark:border-gdc-border dark:bg-gdc-section">
                  <p className="font-semibold text-slate-700 dark:text-slate-100">Summary</p>
                  <ul className="mt-1 grid grid-cols-3 gap-1.5">
                    <SummaryStat label="Stellar" value={applyPreview.stellarAdded} tone="neutral" />
                    <SummaryStat label="Auto" value={applyPreview.autoAdded} tone="success" />
                    <SummaryStat
                      label="Unmapped"
                      value={applyPreview.unmappedSourceFields}
                      tone={applyPreview.unmappedSourceFields === 0 ? 'success' : 'warning'}
                    />
                  </ul>
                  <p className="mt-1.5 text-[10px] leading-snug text-slate-600 dark:text-gdc-mutedStrong">
                    {sourceFieldStats.total} source fields · {analysis.conflicts.length} Stellar conflicts (kept manual)
                  </p>
                  <div className="mt-2 max-h-40 space-y-1 overflow-auto" data-testid="mapping-confidence-review">
                    {suggestions?.map((item) => {
                      const key = `${item.sourceJsonPath}→${item.outputField}`
                      const bucket = item.confidence >= 0.85 ? 'High Confidence' : item.confidence >= 0.6 ? 'Medium Confidence' : 'No Match'
                      const checked = selectedSuggestionKeys.has(key)
                      return (
                        <label key={key} className="flex items-start gap-2 rounded border border-slate-200/80 bg-white p-1.5 dark:border-gdc-border dark:bg-gdc-card">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedSuggestionKeys((current) => {
                              const next = new Set(current)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })}
                            className="mt-0.5"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate font-mono text-[10px]">{item.sourceJsonPath} → {item.outputField}</span>
                              <span className="shrink-0 text-[9px] font-semibold text-violet-700 dark:text-violet-300">{bucket}</span>
                            </span>
                            <span className="block text-[9px] text-slate-500">{Math.round(item.confidence * 100)}% · {item.reason || 'Deterministic schema/sample match'}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-[9px] text-slate-500">High-confidence suggestions are preselected. Review medium-confidence suggestions; leave No Match unchecked to skip. Nothing is applied until you confirm.</p>
                  {analysis.conflicts.length > 0 ? (
                    <p className="mt-1 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                      Manual output fields win over Stellar; remaining top-level fields use Auto-suggest.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={applySuggestions}
                    disabled={!canApply}
                    className="mt-2 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-2 text-[11px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Apply selected suggestions
                    {selectedSuggestionKeys.size > 0 ? <span>(+{selectedSuggestionKeys.size})</span> : null}
                  </button>
                </div>
              ) : !busy && hasSample ? (
                <p className="mt-2 text-[10px] leading-snug text-slate-500 dark:text-gdc-mutedStrong">
                  Generate to preview Stellar output field suggestions plus Auto-suggest for any remaining top-level source
                  fields. Existing rows are never overwritten.
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'warning' | 'neutral'
}) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-200/80 bg-emerald-500/[0.08] text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200'
      : tone === 'warning'
        ? 'border-amber-200/80 bg-amber-500/[0.08] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
        : 'border-slate-200/80 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200'
  return (
    <li className={cn('flex flex-col items-center rounded border px-1.5 py-1 text-center', toneClass)}>
      <span className="text-[14px] font-bold leading-none">{value}</span>
      <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-80">{label}</span>
    </li>
  )
}
