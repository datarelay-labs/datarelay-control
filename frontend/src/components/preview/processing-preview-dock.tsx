import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '../../lib/utils'

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

function previewText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return 'Preview cannot be displayed'
  }
}

/** One focused inspection instead of five repeated empty JSON panels. */
export function ProcessingPreviewDock({
  stages,
  title = 'Processing Preview',
}: {
  stages: readonly ProcessingPreviewStage[]
  title?: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = stages.find((stage) => stage.id === selectedId) ?? stages[0]
  const hasBefore = selected?.before != null
  const hasAfter = selected?.after != null

  return (
    <section
      className="min-w-0 rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid="processing-preview-dock"
      aria-label={title}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">
            Select a stage to inspect what is known. Preview evidence never claims persistence or delivery success.
          </p>
        </div>
        <span className="rounded-md bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
          {stages.length} processing stages
        </span>
      </div>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Processing stage sequence">
        {stages.map((stage, index) => {
          const active = selected?.id === stage.id
          return (
            <li key={stage.id} className="min-w-0">
              <button
                type="button"
                onClick={() => setSelectedId(stage.id)}
                aria-pressed={active}
                data-testid={`processing-preview-stage-${stage.id}`}
                className={cn(
                  'flex h-full min-h-20 w-full min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500',
                  active
                    ? 'border-violet-400 bg-violet-50/80 shadow-sm dark:border-violet-500/60 dark:bg-violet-500/10'
                    : 'border-slate-200 bg-slate-50/70 hover:border-violet-300 hover:bg-violet-50/40 dark:border-gdc-border dark:bg-gdc-section dark:hover:border-violet-500/40',
                )}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="text-[10px] font-bold tabular-nums text-violet-700 dark:text-violet-300">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                </span>
                <span className="break-words text-xs font-semibold leading-snug text-slate-900 dark:text-slate-100">{stage.label}</span>
                <span className="text-[10px] text-slate-500 dark:text-gdc-muted">
                  {stage.truth}{stage.status ? ` · ${stage.status}` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      {selected ? (
        <div className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/50" data-testid="processing-preview-stage-comparison" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">{selected.label} · inspection</h4>
            <span className={cn(
              'rounded-md border px-2 py-0.5 text-[10px] font-semibold',
              selected.truth === 'Runtime'
                ? 'border-emerald-300 text-emerald-700 dark:text-emerald-300'
                : selected.truth === 'Saved configuration'
                  ? 'border-slate-300 text-slate-700 dark:border-gdc-border dark:text-gdc-mutedStrong'
                  : 'border-violet-300 text-violet-700 dark:border-violet-500/40 dark:text-violet-300',
            )}>{selected.truth}</span>
          </div>
          {!hasBefore && !hasAfter ? (
            <p className="mt-2 text-xs text-slate-600 dark:text-gdc-muted">
              No before/after evidence for this stage yet. Use the detailed preview workspace for a verified sample.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Before</p>
                {hasBefore ? (
                  <pre className="max-h-44 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                    {previewText(selected.before)}
                  </pre>
                ) : <p className="text-xs text-slate-500">No input preview for this stage</p>}
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">After</p>
                {hasAfter ? (
                  <pre className="max-h-44 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                    {previewText(selected.after)}
                  </pre>
                ) : <p className="text-xs text-slate-500">No after-preview for this stage</p>}
              </div>
            </div>
          )}
          {selected.message ? (
            <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-gdc-muted">{selected.message}</p>
          ) : null}
          {selected.onPreview ? (
            <button type="button" onClick={selected.onPreview} className="mt-3 inline-flex min-h-9 items-center gap-1 rounded-md border border-violet-300 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10">
              Preview this stage <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">No processing stages available.</p>
      )}
    </section>
  )
}
