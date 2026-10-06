import { WIZARD_INTENT_TEMPLATES, type WizardIntentTemplateId } from './intent-templates'

export function IntentTemplatePicker({ onSelect }: { onSelect: (id: WizardIntentTemplateId) => void }) {
  return <section className="space-y-3" data-testid="wizard-intent-picker" aria-labelledby="wizard-intent-heading">
    <div><h2 id="wizard-intent-heading" className="text-lg font-semibold text-slate-900 dark:text-white">What do you want this Stream to do?</h2><p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">Choose a starting point. Templates only prefill editable Wizard values and never deploy anything automatically.</p></div>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{WIZARD_INTENT_TEMPLATES.map((template) => <button key={template.id} type="button" onClick={() => onSelect(template.id)} className="rounded-lg border border-slate-200 bg-white p-4 text-left hover:border-violet-400 hover:bg-violet-50/40 dark:border-gdc-border dark:bg-gdc-card dark:hover:border-violet-500" data-testid={`wizard-intent-${template.id}`}><span className="block text-sm font-semibold text-slate-900 dark:text-white">{template.title}</span><span className="mt-1 block text-xs text-slate-600 dark:text-gdc-muted">{template.description}</span><ul className="mt-3 space-y-1 text-[11px] text-slate-500 dark:text-gdc-muted">{template.seeds.map((seed) => <li key={seed}>• {seed}</li>)}</ul></button>)}</div>
  </section>
}
