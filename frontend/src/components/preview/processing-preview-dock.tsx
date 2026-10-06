import { cn } from '../../lib/utils'

export type ProcessingPreviewTruth = 'Preview' | 'Saved configuration' | 'Runtime'
export type ProcessingPreviewStage = { id: string; label: string; truth: ProcessingPreviewTruth; status?: string | null; before?: unknown; after?: unknown; message?: string | null; onPreview?: (() => void) | null }

function sample(value: unknown) {
  if (value == null) return 'Not available'
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function ProcessingPreviewDock({ stages, title = 'Processing Preview' }: { stages: readonly ProcessingPreviewStage[]; title?: string }) {
  return <section className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid="processing-preview-dock" aria-label={title}>
    <div className="mb-3"><h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</h3><p className="text-[11px] text-slate-500 dark:text-gdc-muted">Input → Mapping → Enrichment / Transform → Protection / Policy → Destination Payload. Preview evidence never claims persistence or delivery success.</p></div>
    <div className="grid gap-2 xl:grid-cols-5">{stages.map((stage) => <article key={stage.id} className="min-w-0 rounded-lg border border-slate-200/80 bg-slate-50/60 p-2.5 dark:border-gdc-border dark:bg-gdc-section" data-testid={`processing-preview-stage-${stage.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-1"><p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">{stage.label}</p><span className={cn('rounded-full border px-1.5 py-0.5 text-[9px] font-semibold', stage.truth === 'Runtime' ? 'border-emerald-300 text-emerald-700 dark:text-emerald-200' : stage.truth === 'Saved configuration' ? 'border-slate-300 text-slate-600 dark:border-gdc-border dark:text-gdc-muted' : 'border-violet-300 text-violet-700 dark:text-violet-200')}>{stage.truth}</span></div>
      {stage.status ? <p className="mt-1 text-[10px] font-medium text-slate-600 dark:text-gdc-muted">{stage.status}</p> : null}
      <details className="mt-2 text-[10px]"><summary className="cursor-pointer font-semibold text-slate-600 dark:text-gdc-muted">Before / after</summary><div className="mt-1 grid gap-1"><pre className="max-h-24 overflow-auto rounded bg-slate-950 p-1.5 text-slate-100">{sample(stage.before)}</pre><pre className="max-h-24 overflow-auto rounded bg-slate-950 p-1.5 text-slate-100">{sample(stage.after)}</pre></div></details>
      {stage.message ? <p className="mt-2 text-[10px] text-slate-600 dark:text-gdc-muted">{stage.message}</p> : null}
      {stage.onPreview ? <button type="button" onClick={stage.onPreview} className="mt-2 text-[10px] font-semibold text-violet-700 hover:underline dark:text-violet-300">Preview here</button> : null}
    </article>)}</div>
  </section>
}
