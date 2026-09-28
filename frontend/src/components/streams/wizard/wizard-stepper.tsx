import { cn } from '../../../lib/utils'
import { wizardStepReachable, type WizardStepReachableOptions } from './wizard-step-gates'
import type { WizardState, WizardStepCompletion, WizardStepDef } from './wizard-state'

export type WizardStepperProps = {
  wizardSteps: readonly WizardStepDef[]
  stepIndex: number
  setStepIndex: (idx: number) => void
  completion: WizardStepCompletion
  state: WizardState
  reachability?: WizardStepReachableOptions
  className?: string
}

export function WizardStepper({
  wizardSteps,
  stepIndex,
  setStepIndex,
  completion,
  state,
  reachability,
  className,
}: WizardStepperProps) {
  return (
    <ol
      id="wizard-stepper"
      data-testid="wizard-stepper"
      className={cn(
        'grid grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-gdc-border dark:bg-gdc-card sm:grid-cols-3 lg:grid-cols-5',
        className,
      )}
    >
      {wizardSteps.map((step, index) => {
        const active = index === stepIndex
        const status = completion[step.key]
        const reachable = wizardStepReachable(step.key, state, reachability)
        const tone =
          status === 'complete'
            ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : active
              ? 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:border-violet-400/40 dark:text-violet-300'
              : status === 'in_progress'
                ? 'border-amber-300/60 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                : 'border-slate-300 bg-white text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted'
        return (
          <li key={step.key} className="min-w-0">
            <button
              type="button"
              onClick={() => {
                if (!reachable) return
                setStepIndex(index)
              }}
              disabled={!reachable}
              title={
                !reachable ? 'Complete required steps before opening this section.' : undefined
              }
              className={cn(
                'w-full rounded-md border px-2.5 py-2 text-left',
                active
                  ? 'border-violet-500/30 bg-violet-500/[0.06] dark:border-violet-400/30 dark:bg-violet-500/[0.08]'
                  : 'border-transparent bg-transparent hover:bg-slate-50 dark:hover:bg-gdc-rowHover',
                !reachable && 'cursor-not-allowed opacity-60',
              )}
              aria-current={active ? 'step' : undefined}
              data-testid={`wizard-stepper-${step.key}`}
              data-active={active ? 'true' : 'false'}
              data-status={status}
            >
              <p className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold',
                    tone,
                  )}
                >
                  {status === 'complete' ? '✓' : index + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 truncate text-sm font-semibold',
                    active ? 'text-violet-800 dark:text-violet-200' : 'text-slate-700 dark:text-gdc-mutedStrong',
                  )}
                >
                  {step.title}
                </span>
              </p>
              <p className="ml-8 mt-0.5 truncate text-xs font-medium text-slate-500 dark:text-gdc-muted">
                {step.subtitle}
              </p>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
