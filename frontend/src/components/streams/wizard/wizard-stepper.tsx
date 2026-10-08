import { useEffect, useRef } from 'react'
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
  const railRef = useRef<HTMLOListElement>(null)
  const activeStep = wizardSteps[stepIndex]

  useEffect(() => {
    const rail = railRef.current
    const active = rail?.querySelector<HTMLButtonElement>('[aria-current="step"]')
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth || typeof rail.scrollTo !== 'function') return
    rail.scrollTo({ left: Math.max(0, active.offsetLeft - rail.offsetLeft - 16), behavior: 'smooth' })
  }, [stepIndex])

  return (
    <div className={cn('space-y-3', className)} data-testid="wizard-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100" data-testid="wizard-progress-label">
          Step {stepIndex + 1} of {wizardSteps.length}
          <span className="ml-2 font-normal text-slate-500 dark:text-gdc-muted">
            {activeStep?.title ?? 'Stream setup'}
          </span>
        </p>
        <span className="text-xs font-medium text-slate-500 dark:text-gdc-muted">
          Choose a completed step to review it
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Stream setup progress"
        aria-valuemin={0}
        aria-valuemax={wizardSteps.length}
        aria-valuenow={stepIndex + 1}
        className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-gdc-border"
      >
        <div
          className="h-full rounded-full bg-violet-600 transition-[width] duration-200 dark:bg-violet-400"
          style={{ width: `${((stepIndex + 1) / Math.max(1, wizardSteps.length)) * 100}%` }}
        />
      </div>
      <ol
        id="wizard-stepper"
        ref={railRef}
        data-testid="wizard-stepper"
        aria-label="Stream setup steps"
        className="flex snap-x gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-gdc-border dark:bg-gdc-panel lg:grid lg:grid-cols-5"
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
            <li key={step.key} className="min-w-[170px] flex-[0_0_74%] snap-start sm:flex-[0_0_210px] lg:min-w-0 lg:flex-auto">
              <button
                type="button"
                onClick={() => {
                  if (!reachable) return
                  setStepIndex(index)
                }}
                disabled={!reachable}
                title={!reachable ? 'Complete required steps before opening this section.' : undefined}
                className={cn(
                  'h-full w-full rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400',
                  active
                    ? 'border-violet-400 bg-white shadow-sm dark:border-violet-400/60 dark:bg-violet-500/10'
                    : 'border-transparent bg-transparent hover:bg-white dark:hover:bg-gdc-rowHover',
                  !reachable && 'cursor-not-allowed opacity-60',
                )}
                aria-current={active ? 'step' : undefined}
                data-testid={`wizard-stepper-${step.key}`}
                data-active={active ? 'true' : 'false'}
                data-status={status}
              >
                <p className="flex items-center gap-2">
                  <span className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold', tone)}>
                    {status === 'complete' ? '✓' : index + 1}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 text-sm font-semibold leading-tight',
                      active ? 'text-violet-800 dark:text-violet-200' : 'text-slate-700 dark:text-gdc-mutedStrong',
                    )}
                  >
                    {step.title}
                  </span>
                </p>
                <p className="ml-9 mt-1 text-xs leading-snug text-slate-500 dark:text-gdc-muted">
                  {step.subtitle}
                </p>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
