import { useEffect, useRef } from 'react'
import { semanticCn } from '../../ui/semantic-cn'
import { WizardFlowOverview } from './wizard-flow-overview'
import {
  wizardDestinationGateReady,
  wizardRouteProcessingStepBlockReason,
  wizardSampleStepBlockReason,
  wizardSampleStepGateReady,
  wizardStepReachable,
  type WizardStepReachableOptions,
} from './wizard-step-gates'
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
  // Position in the wizard is not the same as a completed configuration.
  const completedStages = wizardSteps.filter((step) => completion[step.key] === 'complete').length
  const sampleBlocked = !wizardSampleStepGateReady(state)
  const unlockGuidance = reachability?.editMode
    ? null
    : sampleBlocked
      ? {
          target: 'Destinations',
          reason: state.connector.connectorId == null || state.connector.sourceId == null
            ? 'Choose a source in Connect, then run a successful source test.'
            : wizardSampleStepBlockReason(state),
        }
      : !wizardDestinationGateReady(state)
        ? { target: 'Deploy', reason: wizardRouteProcessingStepBlockReason(state) }
        : null

  useEffect(() => {
    const rail = railRef.current
    const active = rail?.querySelector<HTMLButtonElement>('[aria-current="step"]')
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth || typeof rail.scrollTo !== 'function') return
    rail.scrollTo({ left: Math.max(0, active.offsetLeft - rail.offsetLeft - 16), behavior: 'smooth' })
  }, [stepIndex])

  return (
    <div className={semanticCn('min-w-0 space-y-3', className)} data-testid="wizard-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-body font-semibold text-fg" data-testid="wizard-progress-label">
          Step {stepIndex + 1} of {wizardSteps.length}
          <span className="ml-2 font-normal text-fg-muted">
            {activeStep?.title ?? 'Stream setup'}
          </span>
        </p>
        <div className="flex flex-col items-start gap-0.5 sm:items-end">
          <span
            className="text-body-sm font-medium text-fg-secondary"
            data-testid="wizard-completed-stage-count"
          >
            {completedStages} of {wizardSteps.length} setup stages marked complete
          </span>
          <span className="text-caption text-fg-muted">
            Choose an available step to review its settings
          </span>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Setup stages marked complete"
        aria-valuemin={0}
        aria-valuemax={wizardSteps.length}
        aria-valuenow={completedStages}
        aria-valuetext={`${completedStages} of ${wizardSteps.length} setup stages marked complete`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${(completedStages / Math.max(1, wizardSteps.length)) * 100}%` }}
        />
      </div>
      {/* Five equal columns at every width: nothing scrolls sideways. Inactive titles stay in the
          accessibility tree but collapse visually below sm so the rail fits a 390px viewport. */}
      <ol
        id="wizard-stepper"
        ref={railRef}
        data-testid="wizard-stepper"
        aria-label="Stream setup steps"
        className="grid grid-cols-5 gap-1 rounded-lg border border-default bg-surface-section p-1"
      >
        {wizardSteps.map((step, index) => {
          const active = index === stepIndex
          const status = completion[step.key]
          const reachable = wizardStepReachable(step.key, state, reachability)
          const describedByUnlockGuidance = !reachable && (
            (unlockGuidance?.target === 'Destinations' && step.key === 'destinations') ||
            (unlockGuidance?.target === 'Deploy' && step.key === 'deploy')
          )
          const tone =
            status === 'complete'
              ? 'border-status-success-border bg-status-success-subtle text-status-success'
              : active
                ? 'border-accent bg-accent text-on-accent'
                : status === 'in_progress'
                  ? 'border-status-warning-border bg-status-warning-subtle text-status-warning'
                  : 'border-default bg-surface-card text-fg-muted'
          return (
            <li key={step.key} className="min-w-0">
              <button
                type="button"
                onClick={() => {
                  if (!reachable) return
                  setStepIndex(index)
                }}
                disabled={!reachable}
                title={!reachable ? unlockGuidance?.reason ?? 'Complete required steps before opening this section.' : undefined}
                className={semanticCn(
                  'flex h-full w-full min-w-0 flex-col items-center gap-1 rounded-md border px-1 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:items-start sm:px-3',
                  active
                    ? 'border-accent bg-surface-card'
                    : 'border-transparent bg-transparent hover:bg-surface-hover',
                  !reachable && 'cursor-not-allowed opacity-60',
                )}
                aria-current={active ? 'step' : undefined}
                aria-describedby={describedByUnlockGuidance ? 'wizard-unlock-guidance' : undefined}
                data-testid={`wizard-stepper-${step.key}`}
                data-active={active ? 'true' : 'false'}
                data-status={status}
              >
                <span className="flex min-w-0 max-w-full items-center gap-2">
                  <span className={semanticCn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-label', tone)}>
                    {status === 'complete' ? '✓' : index + 1}
                  </span>
                  <span
                    data-testid={`wizard-stepper-${step.key}-title`}
                    className={semanticCn(
                      'min-w-0 truncate text-label',
                      active ? 'text-fg' : 'sr-only text-fg-secondary sm:not-sr-only',
                    )}
                  >
                    {step.title}
                  </span>
                </span>
                <span className="hidden w-full min-w-0 truncate pl-9 text-caption text-fg-muted lg:block">
                  {step.subtitle}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {unlockGuidance ? (
        <p
          className="text-caption text-fg-secondary"
          id="wizard-unlock-guidance"
          data-testid="wizard-unlock-guidance"
          role="status"
        >
          <span className="font-semibold">To open {unlockGuidance.target}:</span> {unlockGuidance.reason}
        </p>
      ) : null}
      <WizardFlowOverview state={state} activeStep={activeStep?.key ?? 'connect'} />
    </div>
  )
}
