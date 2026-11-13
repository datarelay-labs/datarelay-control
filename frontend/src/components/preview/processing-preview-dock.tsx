import { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { semanticCn as cn } from '../ui/semantic-cn'
import { comparePreviewFields, formatPreviewValue, type FieldChange } from './processing-preview-diff'

export type ProcessingPreviewTruth = 'Preview' | 'Saved configuration' | 'Runtime'
export type ProcessingPreviewStage = {
  id: string
  label: string
  truth: ProcessingPreviewTruth
  status?: string | null
  before?: unknown
  after?: unknown
  message?: string | null
  onPreview?: (() => void) | null
}

const CHANGE_STYLES: Record<FieldChange, string> = {
  Added: 'border-status-success-border bg-status-success-subtle text-status-success',
  Changed: 'border-status-warning-border bg-status-warning-subtle text-status-warning',
  Removed: 'border-status-critical-border bg-status-critical-subtle text-status-critical',
  Unchanged: 'border-default bg-surface-section text-fg-secondary',
}

function PreviewValue({ value, present }: { value: unknown; present: boolean }) {
  if (!present) return <span className="text-fg-muted">Not present</span>
  const display = formatPreviewValue(value)
  return <><code className="whitespace-pre-wrap break-all text-sm">{display.text}</code>{display.truncated ? <span className="block text-caption text-fg-muted">Value truncated</span> : null}</>
}

function JsonEvidence({ label, value, present }: { label: 'Before' | 'After'; value: unknown; present: boolean }) {
  const display = present ? formatPreviewValue(value, 16000) : null
  return (
    <div className="min-w-0">
      <p className="mb-1 text-body-sm font-semibold text-fg-secondary">{label}</p>
      {display ? <>
        <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-sm leading-6 text-slate-100">{display.text}</pre>
        {display.truncated ? <p className="mt-1 text-caption text-fg-muted">JSON display truncated; the original sample is unchanged.</p> : null}
      </> : <p className="text-body-sm text-fg-muted">{label === 'Before' ? 'No input preview for this stage' : 'No after-preview for this stage'}</p>}
    </div>
  )
}

/** Inspect one existing result, field-first. No rule evaluation or delivery occurs here. */
export function ProcessingPreviewDock({ stages, title = 'Processing Preview' }: {
  stages: readonly ProcessingPreviewStage[]
  title?: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const [changesOnly, setChangesOnly] = useState(false)
  const selected = stages.find((stage) => stage.id === selectedId) ?? stages[0]
  const hasBefore = selected?.before != null
  const hasAfter = selected?.after != null
  const comparison = useMemo(
    () => hasBefore && hasAfter ? comparePreviewFields(selected?.before, selected?.after) : null,
    [hasBefore, hasAfter, selected?.before, selected?.after],
  )
  const rows = comparison?.rows.filter((row) => !changesOnly || row.change !== 'Unchanged') ?? []

  return (
    <section className="w-full min-w-0 max-w-full rounded-lg border border-default bg-surface-card p-3.5"
      data-testid="processing-preview-dock" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-title text-fg">{title}</h3>
          <p className="mt-1 text-body-sm text-fg-muted">Select a stage to compare its actual input and output. Preview evidence never claims persistence or delivery success.</p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-md border border-default bg-surface-section px-2.5 py-1 text-body-sm font-semibold text-fg-secondary">{stages.length} processing stages</span>
      </div>
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5" aria-label="Processing stage sequence">
        {stages.map((stage, index) => {
          const active = selected?.id === stage.id
          return <li key={stage.id} className="min-w-0">
            <button type="button" onClick={() => setSelectedId(stage.id)} aria-pressed={active}
              data-testid={`processing-preview-stage-${stage.id}`}
              className={cn('flex h-full min-h-20 w-full min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                active ? 'border-accent bg-surface-card' : 'border-default bg-surface-section hover:bg-surface-hover')}>
              <span className="flex w-full items-start justify-between gap-2">
                <span className="text-label tabular-nums text-fg">{String(index + 1).padStart(2, '0')}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
              </span>
              <span className="break-words text-label text-fg">{stage.label}</span>
              <span className="break-words text-caption text-fg-muted">{stage.truth}{stage.status ? ` · ${stage.status}` : ''}</span>
            </button>
          </li>
        })}
      </ol>
      {selected ? <div className="mt-3 min-w-0 rounded-lg border border-default bg-surface-section p-3" data-testid="processing-preview-stage-comparison" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-label text-fg">{selected.label} · inspection</h4>
          <span className="rounded-md border border-default px-2 py-0.5 text-caption font-semibold text-fg-secondary">{selected.truth}</span>
        </div>
        {!hasBefore && !hasAfter ? <p className="mt-2 text-sm text-slate-600 dark:text-gdc-muted">No before/after evidence for this stage yet. Use the detailed preview workspace for a verified sample.</p> : <>
          {comparison ? <>
            <div className="my-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1" role="group" aria-label="Preview result view">
                {(['fields', 'json'] as const).map((mode) => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)}
                  className={cn('min-h-9 rounded-md border px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500', view === mode ? 'border-violet-400 bg-violet-50 text-violet-800 dark:bg-violet-500/10 dark:text-violet-200' : 'border-slate-200 text-slate-700 dark:border-gdc-border dark:text-gdc-mutedStrong')}>
                  {mode === 'fields' ? 'Field changes' : 'JSON detail'}
                </button>)}
              </div>
              {view === 'fields' ? <label className="flex min-h-9 items-center gap-2 text-sm text-slate-700 dark:text-gdc-mutedStrong"><input type="checkbox" checked={changesOnly} onChange={(event) => setChangesOnly(event.target.checked)} />Changes only</label> : null}
            </div>
            {view === 'fields' ? <>
              <dl className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Field change counts">
                {(Object.keys(CHANGE_STYLES) as FieldChange[]).map((change) => <div key={change} className={cn('flex gap-1.5 rounded-md border px-2 py-1', CHANGE_STYLES[change])}><dt>{change}</dt><dd className="font-semibold tabular-nums">{comparison.counts[change]}</dd></div>)}
              </dl>
              {comparison.truncated ? <p role="status" className="mb-3 text-sm text-amber-900 dark:text-amber-200">Comparison limited: {comparison.rows.length} fields compared. Additional or deeply nested fields were not evaluated.</p> : null}
              <div className="max-h-96 min-w-0 overflow-auto rounded-lg border border-slate-200 bg-white dark:border-gdc-border dark:bg-gdc-card" tabIndex={0} role="region" aria-label="Scrollable field comparison">
                <table className="w-full min-w-[32rem] table-fixed text-left text-sm" aria-label={`${selected.label} field comparison`}>
                  <thead className="sticky top-0 bg-slate-100 text-slate-800 dark:bg-gdc-section dark:text-gdc-foreground"><tr><th scope="col" className="w-[28%] p-3 font-semibold">Field</th><th scope="col" className="w-[18%] p-3 font-semibold">Change</th><th scope="col" className="w-[27%] p-3 font-semibold">Before</th><th scope="col" className="w-[27%] p-3 font-semibold">After</th></tr></thead>
                  <tbody>{rows.map((row) => <tr key={row.path} className="border-t border-slate-100 align-top text-slate-800 dark:border-gdc-border dark:text-gdc-foreground">
                    <th scope="row" className="break-all p-3 font-mono font-normal">{row.path.length > 240 ? `${row.path.slice(0, 240)}…` : row.path}</th>
                    <td className="p-3"><span className={cn('inline-block rounded border px-1.5 py-0.5 text-xs font-semibold', CHANGE_STYLES[row.change])}>{row.change}</span></td>
                    <td className="p-3"><PreviewValue value={row.before} present={row.beforePresent} /></td><td className="p-3"><PreviewValue value={row.after} present={row.afterPresent} /></td>
                  </tr>)}</tbody>
                </table>
                {rows.length === 0 ? <p className="p-3 text-sm text-slate-600 dark:text-gdc-muted">{comparison.truncated ? 'No matching changes in the compared portion.' : changesOnly ? 'No changed fields in this sample.' : 'No fields to compare.'}</p> : null}
              </div>
            </> : null}
          </> : <p className="mt-2 text-sm text-slate-600 dark:text-gdc-muted">Field comparison requires both input and output evidence.</p>}
          {!comparison || view === 'json' ? <div className="mt-3 grid gap-3 md:grid-cols-2"><JsonEvidence label="Before" value={selected.before} present={hasBefore} /><JsonEvidence label="After" value={selected.after} present={hasAfter} /></div> : null}
        </>}
        {selected.message ? <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-gdc-muted">{selected.message}</p> : null}
        {selected.onPreview ? <button type="button" onClick={selected.onPreview} className="mt-3 inline-flex min-h-9 items-center gap-1 rounded-md border border-violet-300 px-3 py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10">Preview this stage <ArrowRight className="h-3.5 w-3.5" aria-hidden /></button> : null}
      </div> : <p className="mt-3 text-sm text-slate-500 dark:text-gdc-muted">No processing stages available.</p>}
    </section>
  )
}
