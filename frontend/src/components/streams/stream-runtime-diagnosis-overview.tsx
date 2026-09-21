import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import type { DiagnosisCause, DiagnosisNextStep, DiagnosisTone, StreamDiagnosis } from './stream-runtime-diagnosis'

function toneLabel(tone: DiagnosisTone): string {
  switch (tone) {
    case 'critical':
      return 'Critical'
    case 'attention':
      return 'Needs attention'
    case 'clear':
      return 'Clear'
    case 'not_applicable':
      return 'Not applicable'
    default:
      return 'Unknown'
  }
}

function toneClass(tone: DiagnosisTone): string {
  switch (tone) {
    case 'critical':
      return 'border-red-300/80 bg-red-500/[0.06] text-red-950 dark:border-red-500/35 dark:bg-red-500/10 dark:text-red-100'
    case 'attention':
      return 'border-amber-300/80 bg-amber-500/[0.07] text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100'
    case 'clear':
      return 'border-emerald-300/70 bg-emerald-500/[0.05] text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
    case 'not_applicable':
      return 'border-slate-200/80 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200'
    default:
      return 'border-slate-200/80 bg-white text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'
  }
}

function CauseCard({ cause }: { cause: DiagnosisCause }) {
  return (
    <article
      data-testid={`stream-diagnosis-cause-${cause.key}`}
      data-tone={cause.tone}
      className={cn('rounded-xl border px-4 py-3', toneClass(cause.tone))}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{cause.label}</h3>
        <span className="text-[13px] font-medium">{toneLabel(cause.tone)}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed">{cause.detail}</p>
    </article>
  )
}

function NextStepControl({
  step,
  onStart,
  onRunOnce,
  onBackfill,
}: {
  step: DiagnosisNextStep
  onStart?: () => void
  onRunOnce?: () => void
  onBackfill?: () => void
}) {
  const className =
    'inline-flex h-9 items-center rounded-md border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover'
  if (step.kind === 'link') {
    return (
      <Link to={step.href} className={className} data-testid={`stream-diagnosis-step-${step.id}`}>
        {step.label}
      </Link>
    )
  }
  const onClick = step.kind === 'start' ? onStart : step.kind === 'run-once' ? onRunOnce : onBackfill
  if (!onClick) return null
  return (
    <button type="button" className={className} onClick={onClick} data-testid={`stream-diagnosis-step-${step.id}`}>
      {step.label}
    </button>
  )
}

export function StreamRuntimeDiagnosisOverview({
  diagnosis,
  onStart,
  onRunOnce,
  onBackfill,
  evidence,
}: {
  diagnosis: StreamDiagnosis
  onStart?: () => void
  onRunOnce?: () => void
  onBackfill?: () => void
  evidence: ReactNode
}) {
  return (
    <div className="space-y-4" data-testid="stream-diagnosis-overview">
      <section aria-label="What happened" className="rounded-xl border border-slate-200/80 bg-white px-4 py-4 dark:border-gdc-border dark:bg-gdc-card">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">What happened?</h3>
        <p className="mt-2 text-base leading-relaxed text-slate-800 dark:text-slate-100" data-testid="stream-diagnosis-summary">
          {diagnosis.whatHappened}
        </p>
      </section>

      <section aria-label="Why this stream needs attention">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Why?</h3>
        <div className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {diagnosis.causes.map((item) => (
            <CauseCard key={item.key} cause={item} />
          ))}
        </div>
      </section>

      <section aria-label="Recommended next step" className="rounded-xl border border-slate-200/80 bg-white px-4 py-4 dark:border-gdc-border dark:bg-gdc-card">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">What to do next</h3>
        {diagnosis.nextSteps.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {diagnosis.nextSteps.map((step) => (
              <NextStepControl
                key={step.id}
                step={step}
                onStart={onStart}
                onRunOnce={onRunOnce}
                onBackfill={onBackfill}
              />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600 dark:text-gdc-mutedStrong">No corrective action is indicated from the current evidence.</p>
        )}
      </section>

      <section aria-label="Runtime evidence" className="space-y-4" data-testid="stream-runtime-evidence">
        <h3 className="text-sm font-medium text-slate-500 dark:text-gdc-muted">Runtime evidence</h3>
        {evidence}
      </section>
    </div>
  )
}
