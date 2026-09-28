import { Copy } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { resolveJsonPath } from '../mapping-jsonpath'
import { PanelChrome } from '../mapping-json-tree'
import { applyMappingWithPassThrough } from '../../../utils/mappingPassThrough'
import { unmappedTopLevelSourcePaths } from './wizard-mapping-merge'
import type { WizardState, WizardUnmappedFieldsPolicy } from './wizard-state'

export type WizardMappingOutputAsideProps = {
  state: WizardState
  onChangeUnmappedFieldsPolicy?: (policy: WizardUnmappedFieldsPolicy) => void
  className?: string
}

export function WizardMappingOutputAside({
  state,
  onChangeUnmappedFieldsPolicy,
  className,
}: WizardMappingOutputAsideProps) {
  const [previewTab, setPreviewTab] = useState<'preview' | 'raw_final'>('preview')

  const sampleEvent = state.apiTest.extractedEvents[0] ?? null

  const mappedPreview = useMemo(() => {
    if (!sampleEvent) return null
    return applyMappingWithPassThrough(
      sampleEvent,
      state.mapping,
      resolveJsonPath,
      state.unmappedFieldsPolicy,
    )
  }, [sampleEvent, state.mapping, state.unmappedFieldsPolicy])

  const rawSampleJson = useMemo(() => {
    if (!sampleEvent) return ''
    try {
      return JSON.stringify(sampleEvent, null, 2)
    } catch {
      return ''
    }
  }, [sampleEvent])

  const mappedPreviewJson = useMemo(() => {
    if (!mappedPreview) return ''
    try {
      return JSON.stringify(mappedPreview, null, 2)
    } catch {
      return ''
    }
  }, [mappedPreview])

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

  const stats = useMemo(() => {
    const mappedCount = state.mapping.filter((r) => r.outputField.trim() && r.sourceJsonPath.trim()).length
    const staticCount = state.enrichment.filter((e) => e.fieldName.trim()).length
    const totalKeys = new Set<string>()
    for (const r of state.mapping) {
      const k = r.outputField.trim()
      if (k) totalKeys.add(k)
    }
    for (const e of state.enrichment) {
      const k = e.fieldName.trim()
      if (k) totalKeys.add(k)
    }
    const sampleRecord =
      sampleEvent && typeof sampleEvent === 'object' && !Array.isArray(sampleEvent)
        ? (sampleEvent as Record<string, unknown>)
        : null
    const unmappedSourceCount = unmappedTopLevelSourcePaths(state.mapping, sampleRecord).length
    const missingRequired = state.mapping.some((r) => !r.outputField.trim() || !r.sourceJsonPath.trim())
    const potentialIssues =
      duplicateOutputKeys.size > 0 ||
      [...rowWarnings.values()].some((w) => w.dup || w.missing)
    return {
      mappedCount,
      staticCount,
      enrichedCount: staticCount,
      totalOutput: totalKeys.size,
      unmappedSourceCount,
      missingRequired,
      potentialIssues,
    }
  }, [sampleEvent, state.mapping, state.enrichment, duplicateOutputKeys, rowWarnings])

  const copyFinalJson = useCallback(async () => {
    const text = mappedPreviewJson || '{}'
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      }
    } catch {
      // ignore
    }
  }, [mappedPreviewJson])

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 self-start overflow-y-auto lg:sticky lg:top-2 lg:max-h-[calc(100vh-8rem)]',
        className,
      )}
      data-testid="route-processing-output-workspace"
    >
      <PanelChrome title="3. Final event" className="max-h-[min(42vh,440px)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 px-2.5 py-2 dark:border-gdc-border">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
              Preview ready
            </span>
            <div className="inline-flex rounded-md border border-slate-200/90 p-0.5 dark:border-gdc-border">
              <button
                type="button"
                onClick={() => setPreviewTab('preview')}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-semibold',
                  previewTab === 'preview'
                    ? 'bg-white text-slate-900 dark:bg-gdc-card dark:text-gdc-foreground'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                )}
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => setPreviewTab('raw_final')}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-semibold',
                  previewTab === 'raw_final'
                    ? 'bg-white text-slate-900 dark:bg-gdc-card dark:text-gdc-foreground'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                )}
              >
                Compare
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void copyFinalJson()}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            Copy JSON
          </button>
        </div>
        <div className="min-h-0 overflow-auto p-2">
          {previewTab === 'preview' ? (
            <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 p-2.5 text-[10px] leading-snug text-slate-100 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-foreground">
              {mappedPreviewJson || '—'}
            </pre>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-semibold text-slate-500">Raw sample (first event)</p>
                <pre className="max-h-[32vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-2 text-[9px] leading-snug text-slate-100 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-foreground">
                  {rawSampleJson || '—'}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold text-slate-500">Mapped output</p>
                <pre className="max-h-[32vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-2 text-[9px] leading-snug text-slate-100 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-foreground">
                  {mappedPreviewJson || '—'}
                </pre>
              </div>
            </div>
          )}
        </div>
      </PanelChrome>

      <section className="rounded-lg border border-slate-200 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
        <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Unmapped fields</h4>
        <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
          How to handle source fields not covered by a mapping row. Drop removes fields from the output event only — it
          does not block delivery.
        </p>
        <div className="mt-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 text-[11px]">
            <input
              type="radio"
              name="wizard-unmapped-fields-policy"
              checked={state.unmappedFieldsPolicy === 'pass_through'}
              onChange={() => onChangeUnmappedFieldsPolicy?.('pass_through')}
              className="mt-0.5"
              data-testid="unmapped-fields-policy-pass_through"
            />
            <span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">Pass Through</span>
              <span className="mt-0.5 block text-slate-500 dark:text-gdc-muted">
                Include unmapped source fields in mapped output with original field names (default).
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[11px]">
            <input
              type="radio"
              name="wizard-unmapped-fields-policy"
              checked={state.unmappedFieldsPolicy === 'drop_unmapped'}
              onChange={() => onChangeUnmappedFieldsPolicy?.('drop_unmapped')}
              className="mt-0.5"
              data-testid="unmapped-fields-policy-drop"
            />
            <span>
              <span className="font-semibold text-slate-800 dark:text-slate-100">Drop</span>
              <span className="mt-0.5 block text-slate-500 dark:text-gdc-muted">
                Remove unmapped fields from the output event. Mapped fields are still delivered.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
        <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Output summary</h4>
        <ul className="mt-2 space-y-1.5 text-[11px] text-slate-700 dark:text-slate-200">
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Mapped fields</span>
            <span className="font-semibold">{stats.mappedCount}</span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Unmapped source fields</span>
            <span
              className={cn(
                'font-semibold',
                stats.unmappedSourceCount === 0
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-amber-700 dark:text-amber-300',
              )}
            >
              {stats.unmappedSourceCount}
            </span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Static fields</span>
            <span className="font-semibold">{stats.staticCount}</span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Enriched fields</span>
            <span className="font-semibold">{stats.enrichedCount}</span>
          </li>
          <li className="flex justify-between gap-2 border-t border-slate-100 pt-1.5 dark:border-gdc-border">
            <span className="text-slate-500">Total output fields</span>
            <span className="font-semibold text-violet-700 dark:text-violet-300">{stats.totalOutput}</span>
          </li>
        </ul>
        <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 dark:border-gdc-border">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-600 dark:text-gdc-mutedStrong">Required fields missing</span>
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-300">
              {stats.missingRequired ? '⚠' : '✓'} {stats.missingRequired ? 'Yes' : 'None'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-600 dark:text-gdc-mutedStrong">Potential issues</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 font-semibold',
                stats.potentialIssues ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300',
              )}
            >
              {stats.potentialIssues ? '⚠ Review' : '✓ None'}
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}
