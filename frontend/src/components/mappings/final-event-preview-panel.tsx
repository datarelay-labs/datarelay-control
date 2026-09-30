import { Code2, LayoutGrid, Loader2, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { PanelChrome } from '../streams/mapping-json-tree'
import type { MappingPreviewState } from '../../hooks/useMappingPreview'
import type { MappingValidationWarning } from '../../api/gdcRuntimePreview'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { buildEventChangeRows, buildTransformPreviewSummary } from './transform-preview-summary'

type PreviewStage = 'raw' | 'mapped' | 'enriched' | 'comparison'

type FinalEventPreviewPanelProps = {
  preview: MappingPreviewState
  rawSampleEvent: Record<string, unknown> | null
  rawSampleEvents: Array<Record<string, unknown>>
  rows: MappingRowModel[]
  eventCount: number
  sampleEventIndex: number
  onSampleIndexChange: (idx: number) => void
  onRefresh: () => void
  warnings: MappingValidationWarning[]
  selectedRow?: MappingRowModel | null
}

function jsonBlock(data: unknown): string {
  if (data === null || data === undefined) return '—'
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

function PreviewMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'good' | 'neutral' | 'warning' | 'error'
}) {
  return (
    <div className="min-w-0 border-b border-r border-slate-200 px-2.5 py-2 last:border-r-0 dark:border-gdc-border">
      <p className="text-[10px] font-medium text-slate-500 dark:text-gdc-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[13px] font-semibold tabular-nums',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-300',
          tone === 'neutral' && 'text-slate-900 dark:text-gdc-foreground',
          tone === 'warning' && 'text-amber-700 dark:text-amber-300',
          tone === 'error' && 'text-red-700 dark:text-red-300',
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate text-[9px] text-slate-400 dark:text-gdc-placeholder" title={detail}>
        {detail}
      </p>
    </div>
  )
}

export function FinalEventPreviewPanel({
  preview,
  rawSampleEvent,
  rawSampleEvents,
  rows,
  eventCount,
  sampleEventIndex,
  onSampleIndexChange,
  onRefresh,
  warnings,
  selectedRow = null,
}: FinalEventPreviewPanelProps) {
  const [stage, setStage] = useState<PreviewStage>('comparison')
  const [view, setView] = useState<'json' | 'table'>('json')

  const mappedEvent = preview.mapped?.mapped_events?.[sampleEventIndex] ?? null
  const finalEvent = preview.final?.final_events?.[sampleEventIndex] ?? null
  const allWarnings = warnings
  const summary = useMemo(
    () =>
      buildTransformPreviewSummary({
        rawEvents: rawSampleEvents,
        rows,
        mapped: preview.mapped,
        final: preview.final,
        warnings,
      }),
    [rawSampleEvents, rows, preview.mapped, preview.final, warnings],
  )
  const availableEventCount = Math.max(
    Math.min(
      summary.previewEventCount > 0 ? summary.previewEventCount : eventCount,
      rawSampleEvents.length > 0 ? rawSampleEvents.length : eventCount,
      20,
    ),
    1,
  )
  const displayObject = useMemo(() => {
    if (stage === 'raw') return rawSampleEvent
    if (stage === 'mapped') return mappedEvent
    return finalEvent
  }, [stage, rawSampleEvent, mappedEvent, finalEvent])

  const changeRows = useMemo(
    () =>
      buildEventChangeRows(
        rawSampleEvent,
        finalEvent && typeof finalEvent === 'object' && !Array.isArray(finalEvent)
          ? (finalEvent as Record<string, unknown>)
          : null,
      ),
    [rawSampleEvent, finalEvent],
  )

  return (
    <PanelChrome
      title="Final event preview"
      className="max-h-[min(72vh,780px)]"
      right={
        <div className="flex items-center gap-1">
          {preview.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" aria-hidden /> : null}
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </button>
        </div>
      }
    >
      <div className="space-y-2 p-2">
        <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
          Changes-first preview across up to 20 sample events. Event {sampleEventIndex + 1} of {availableEventCount}.
        </p>
        {selectedRow ? (
          <div className="rounded-md border border-violet-200/80 bg-violet-500/[0.06] px-2.5 py-2 text-[10px] dark:border-violet-500/30" data-testid="mapping-selection-trace">
            <span className="font-semibold text-violet-800 dark:text-violet-200">Selected trace</span>
            <span className="ml-2 font-mono text-slate-600 dark:text-gdc-muted">{selectedRow.sourceJsonPath || '—'} → {selectedRow.outputField || '—'}</span>
          </div>
        ) : null}
        {availableEventCount > 1 ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-semibold text-slate-600 dark:text-gdc-mutedStrong" htmlFor="sample-idx">
              Sample event
            </label>
            <select
              id="sample-idx"
              value={sampleEventIndex}
              onChange={(e) => onSampleIndexChange(Number(e.target.value))}
              className="h-7 rounded-md border border-slate-200/90 bg-white px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-card"
            >
              {Array.from({ length: availableEventCount }, (_, i) => (
                <option key={i} value={i}>
                  Event {i + 1}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex overflow-x-auto border-b border-slate-200 dark:border-gdc-border" role="tablist" aria-label="Preview stage">
          {(['comparison', 'enriched', 'mapped', 'raw'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={stage === s}
              onClick={() => setStage(s)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-[11px] font-semibold',
                stage === s
                  ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-gdc-muted dark:hover:text-gdc-foreground',
              )}
            >
              {s === 'enriched' ? 'Final event' : s === 'comparison' ? `Changes (${changeRows.length})` : s === 'mapped' ? 'Transformed' : 'Raw'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 overflow-hidden rounded-md border border-slate-200 bg-slate-50/60 dark:border-gdc-border dark:bg-gdc-section sm:grid-cols-3">
          <PreviewMetric
            label="Field matches"
            value={summary.totalApplications > 0 ? `${summary.matchedApplications}/${summary.totalApplications}` : '—'}
            detail={summary.previewEventCount > 0 ? `${summary.previewEventCount} sample${summary.previewEventCount === 1 ? '' : 's'}` : 'No preview'}
            tone={summary.missingApplications === 0 ? 'good' : 'neutral'}
          />
          <PreviewMetric
            label="Missing"
            value={String(summary.missingApplications)}
            detail={summary.missingEventCount > 0 ? `${summary.missingEventCount} affected sample${summary.missingEventCount === 1 ? '' : 's'}` : 'No missing values'}
            tone={summary.missingApplications > 0 ? 'warning' : 'good'}
          />
          <PreviewMetric
            label="Null outputs"
            value={String(summary.nullOutputCount)}
            detail="Mapped targets with null final values"
            tone={summary.nullOutputCount > 0 ? 'warning' : 'good'}
          />
          <PreviewMetric
            label="Type changes"
            value={String(summary.typeChangeCount)}
            detail="Source and final JSON types differ"
            tone={summary.typeChangeCount > 0 ? 'warning' : 'good'}
          />
          <PreviewMetric
            label="Duplicate targets"
            value={String(summary.duplicateTargetCount)}
            detail="Destination field names reused"
            tone={summary.duplicateTargetCount > 0 ? 'warning' : 'good'}
          />
          <PreviewMetric
            label="Validation"
            value={summary.errorCount > 0 ? `${summary.errorCount} error${summary.errorCount === 1 ? '' : 's'}` : `${summary.warningCount} warning${summary.warningCount === 1 ? '' : 's'}`}
            detail={summary.errorCount > 0 && summary.warningCount > 0 ? `+${summary.warningCount} warning${summary.warningCount === 1 ? '' : 's'}` : summary.errorCount === 0 && summary.warningCount === 0 ? 'No validation issues' : 'Review before deploy'}
            tone={summary.errorCount > 0 ? 'error' : summary.warningCount > 0 ? 'warning' : 'good'}
          />
        </div>

        {allWarnings.length > 0 ? (
          <ul className="max-h-24 space-y-1 overflow-auto rounded-md border border-amber-200/80 bg-amber-500/[0.06] p-2 text-[10px] dark:border-amber-500/30">
            {allWarnings.slice(0, 8).map((w, i) => (
              <li key={`${w.code}-${i}`} className={w.severity === 'error' ? 'text-red-800 dark:text-red-300' : 'text-amber-900 dark:text-amber-100'}>
                <span className="font-semibold">{w.code}: </span>
                {w.message}
              </li>
            ))}
            {allWarnings.length > 8 ? <li className="text-slate-500">+{allWarnings.length - 8} more</li> : null}
          </ul>
        ) : null}

        {preview.error ? (
          <p className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-2 text-[11px] text-red-800 dark:text-red-200">{preview.error}</p>
        ) : null}

        {stage !== 'comparison' ? (
          <div className="flex rounded-md border border-slate-200/80 bg-slate-50/80 p-0.5 dark:border-gdc-border dark:bg-gdc-section">
            <button
              type="button"
              onClick={() => setView('json')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-semibold',
                view === 'json' ? 'bg-white dark:bg-gdc-card' : 'text-slate-500',
              )}
            >
              <Code2 className="h-3.5 w-3.5" aria-hidden />
              JSON
            </button>
            <button
              type="button"
              onClick={() => setView('table')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[11px] font-semibold',
                view === 'table' ? 'bg-white dark:bg-gdc-card' : 'text-slate-500',
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
              Table
            </button>
          </div>
        ) : null}

        {stage === 'comparison' ? (
          <div className="space-y-2">
            <section>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">Current sample changes</p>
                <p className="text-[9px] text-slate-400 dark:text-gdc-placeholder">
                  Event {sampleEventIndex + 1}
                </p>
              </div>
              <div className="max-h-[24vh] overflow-auto rounded-md border border-slate-200 dark:border-gdc-border">
                {changeRows.length === 0 ? (
                  <p className="px-3 py-5 text-center text-[11px] text-slate-500 dark:text-gdc-muted">
                    No top-level field changes in this sample.
                  </p>
                ) : (
                  <table className={opTable}>
                    <thead>
                      <tr className={opThRow}>
                        <th className={opTh}>Change</th>
                        <th className={opTh}>Field</th>
                        <th className={opTh}>Before</th>
                        <th className={opTh}>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changeRows.map((row) => (
                        <tr key={`${row.kind}:${row.path}`} className={opTr}>
                          <td className={opTd}>
                            <span
                              className={cn(
                                'inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-semibold capitalize',
                                row.kind === 'added' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                                row.kind === 'removed' && 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
                                row.kind === 'changed' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
                              )}
                            >
                              {row.kind}
                            </span>
                          </td>
                          <td className={cn(opTd, 'font-mono text-[10px] text-violet-700 dark:text-violet-300')}>{row.path}</td>
                          <td className={cn(opTd, 'max-w-[150px] truncate font-mono text-[10px] text-slate-500 dark:text-gdc-muted')} title={jsonBlock(row.before)}>
                            {jsonBlock(row.before)}
                          </td>
                          <td className={cn(opTd, 'max-w-[150px] truncate font-mono text-[10px]')} title={jsonBlock(row.after)}>
                            {jsonBlock(row.after)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <section>
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">Validation by field</p>
                <p className="text-[9px] text-slate-400 dark:text-gdc-placeholder">
                  Across {summary.previewEventCount} preview sample{summary.previewEventCount === 1 ? '' : 's'}
                </p>
              </div>
              <div className="max-h-[24vh] overflow-auto rounded-md border border-slate-200 dark:border-gdc-border">
                {summary.fieldSummaries.length === 0 ? (
                  <p className="px-3 py-5 text-center text-[11px] text-slate-500 dark:text-gdc-muted">
                    Add at least one source-to-output mapping to validate sample coverage.
                  </p>
                ) : (
                  <table className={opTable}>
                    <thead>
                      <tr className={opThRow}>
                        <th className={opTh}>Output field</th>
                        <th className={opTh}>Matched</th>
                        <th className={opTh}>Missing</th>
                        <th className={opTh}>Null</th>
                        <th className={opTh}>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.fieldSummaries.map((field) => (
                        <tr key={field.rowId} className={opTr}>
                          <td className={opTd}>
                            <span className="block font-mono text-[10px] text-violet-700 dark:text-violet-300">{field.outputField}</span>
                            <span className="block max-w-[150px] truncate font-mono text-[9px] text-slate-400 dark:text-gdc-placeholder" title={field.sourceJsonPath}>
                              {field.sourceJsonPath}
                            </span>
                            {field.duplicateTarget ? (
                              <span className="mt-0.5 inline-flex rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:text-amber-300">
                                Duplicate target
                              </span>
                            ) : null}
                          </td>
                          <td className={cn(opTd, 'tabular-nums')}>
                            {field.matchedCount}/{summary.previewEventCount}
                          </td>
                          <td className={cn(opTd, 'tabular-nums', field.missingCount > 0 && 'text-amber-700 dark:text-amber-300')}>
                            {field.missingCount}
                          </td>
                          <td className={cn(opTd, 'tabular-nums', field.nullCount > 0 && 'text-amber-700 dark:text-amber-300')}>
                            {field.nullCount}
                          </td>
                          <td className={cn(opTd, 'tabular-nums', field.typeChangeCount > 0 && 'text-amber-700 dark:text-amber-300')}>
                            {field.typeChangeCount > 0 ? `${field.typeChangeCount} changed` : 'Stable'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        ) : view === 'json' ? (
          <pre className="max-h-[40vh] overflow-auto rounded-md border border-slate-200 bg-slate-950 p-2.5 text-[10px] leading-relaxed text-slate-100 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-foreground">
            {jsonBlock(displayObject)}
          </pre>
        ) : (
          <div className="max-h-[40vh] overflow-auto rounded-md border border-slate-200/60 bg-white dark:border-gdc-border dark:bg-gdc-section">
            <table className={opTable}>
              <thead>
                <tr className={opThRow}>
                  <th className={opTh}>Field</th>
                  <th className={opTh}>Value</th>
                </tr>
              </thead>
              <tbody>
                {displayObject && typeof displayObject === 'object'
                  ? Object.entries(displayObject as Record<string, unknown>).map(([k, v]) => (
                      <tr key={k} className={opTr}>
                        <td className={cn(opTd, 'font-mono text-[10px] text-violet-800 dark:text-violet-200')}>{k}</td>
                        <td className={cn(opTd, 'max-w-[180px] truncate font-mono text-[10px]')}>{v === null ? 'null' : String(v)}</td>
                      </tr>
                    ))
                  : (
                      <tr className={opTr}>
                        <td colSpan={2} className={cn(opTd, 'text-slate-500')}>
                          No preview data for this stage yet.
                        </td>
                      </tr>
                    )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PanelChrome>
  )
}
