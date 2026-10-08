import {
  ArrowRight,
  Check,
  Database,
  FileArchive,
  Globe2,
  Layers3,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { WIZARD_INTENT_TEMPLATES, type WizardIntentTemplateId } from './intent-templates'

const TEMPLATE_ICONS: Record<Exclude<WizardIntentTemplateId, 'scratch'>, LucideIcon> = {
  'api-logs-siem': Globe2,
  'database-collection': Database,
  'multi-destination': Layers3,
  'archive-raw': FileArchive,
  'protect-sensitive': ShieldCheck,
}

export function IntentTemplatePicker({ onSelect }: { onSelect: (id: WizardIntentTemplateId) => void }) {
  const guided = WIZARD_INTENT_TEMPLATES.filter((template) => template.id !== 'scratch')
  const scratch = WIZARD_INTENT_TEMPLATES.find((template) => template.id === 'scratch')

  return (
    <section className="space-y-5" data-testid="wizard-intent-picker" aria-labelledby="wizard-intent-heading">
      <div className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-white px-5 py-6 dark:border-gdc-border dark:from-gdc-section dark:via-gdc-card dark:to-gdc-card sm:px-7">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-violet-700 dark:text-violet-300">Create a data flow</p>
        <h2 id="wizard-intent-heading" className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
          What would you like to deliver?
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">
          Choose a common goal to start with helpful defaults. You can review every setting before deploying, and no template activates a Stream automatically.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Guided setup options">
        {guided.map((template) => {
          const Icon = TEMPLATE_ICONS[template.id as Exclude<WizardIntentTemplateId, 'scratch'>]
          return (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template.id)}
              className="group flex min-h-[232px] flex-col rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-violet-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-gdc-border dark:bg-gdc-card dark:hover:border-violet-500"
              data-testid={`wizard-intent-${template.id}`}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-700 group-hover:bg-violet-200 dark:bg-violet-500/15 dark:text-violet-300" aria-hidden>
                <Icon className="h-5 w-5" />
              </span>
              <span className="mt-4 text-base font-semibold leading-snug text-slate-900 dark:text-white">{template.title}</span>
              <span className="mt-2 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">{template.description}</span>
              <span className="mt-4 flex-1 space-y-2 text-xs text-slate-500 dark:text-gdc-muted">
                {template.seeds.map((seed) => (
                  <span key={seed} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" aria-hidden />
                    <span>{seed}</span>
                  </span>
                ))}
              </span>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 dark:text-violet-300">
                Start this setup
                <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" aria-hidden />
              </span>
            </button>
          )
        })}
      </div>

      {scratch ? (
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/80 px-5 py-4 dark:border-gdc-border dark:bg-gdc-panel sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Already know your setup?</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-gdc-mutedStrong">Start with the same five-step wizard and no template-specific defaults.</p>
          </div>
          <button
            type="button"
            onClick={() => onSelect(scratch.id)}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:border-violet-400 hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            data-testid="wizard-intent-scratch"
          >
            Start from scratch
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  )
}
