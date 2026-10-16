import { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '../../lib/utils'
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
  Added: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
  Changed: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
  Removed: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
  Unchanged: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong',
}

function PreviewValue({ value, present }: { value: unknown; present: boolean }) {
  if (!present) return <span className="text-slate-500 dark:text-gdc-muted">Not present</span>
  const display = formatPreviewValue(value)
  return <><code className="whitespace-pre-wrap break-all text-sm">{display.text}</code>{display.truncated ? <span className="block text-xs text-slate-500 dark:text-gdc-muted">Value truncated</span> : null}</>
}

function JsonEvidence({ label, value, present }: { label: 'Before' | 'After'; value: unknown; present: boolean }) {
  const display = present ? formatPreviewValue(value, 16000) : null
  return (
    <div className="min-w-0">
      <p className="mb-1 text-sm font-semibold text-slate-700 dark:text-gdc-mutedStrong">{label}</p>
      {display ? <>
        <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-sm leading-6 text-slate-100">{display.text}</pre>
        {display.truncated ? <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">JSON display truncated; the original sample is unchanged.</p> : null}
      </> : <p className="text-sm text-slate-500 dark:text-gdc-muted">{label === 'Before' ? 'No input preview for this stage' : 'No after-preview for this stage'}</p>}
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
    <section className="min-w-0 rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="processing-preview-dock" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">Select a stage to compare its actual input and output. Preview evidence never claims persistence or delivery success.</p>
        </div>
        <span className="rounded-md bg-violet-500/10 px-2.5 py-1 text-xs font-semibold text-violet-700 dark:text-violet-300">{stages.length} processing stages</span>
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Processing stage sequence">
        {stages.map((stage, index) => {
          const active = selected?.id === stage.id
          return <li key={stage.id} className="min-w-0">
            <button type="button" onClick={() => setSelectedId(stage.id)} aria-pressed={active}
              data-testid={`processing-preview-stage-${stage.id}`}
              className={cn('flex h-full min-h-20 w-full min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500',
                active ? 'border-violet-400 bg-violet-50/80 shadow-sm dark:border-violet-500/60 dark:bg-violet-500/10' : 'border-slate-200 bg-slate-50/70 hover:border-violet-300 hover:bg-violet-50/40 dark:border-gdc-border dark:bg-gdc-section dark:hover:border-violet-500/40')}>
              <span className="flex w-full items-start justify-between gap-2">
                <span className="text-xs font-bold tabular-nums text-violet-700 dark:text-violet-300">{String(index + 1).padStart(2, '0')}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              </span>
              <span className="break-words text-sm font-semibold leading-snug text-slate-900 dark:text-slate-100">{stage.label}</span>
              <span className="text-xs text-slate-500 dark:text-gdc-muted">{stage.truth}{stage.status ? ` · ${stage.status}` : ''}</span>
            </button>
          </li>
        })}
      </ol>
      {selected ? <div className="mt-3 min-w-0 rounded-lg border border-slate-200/80 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/50" data-testid="processing-preview-stage-comparison" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{selected.label} · inspection</h4>
          <span className="rounded-md border border-violet-300 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:border-violet-500/40 dark:text-violet-300">{selected.truth}</span>
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
