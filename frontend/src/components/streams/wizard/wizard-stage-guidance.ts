import type { WizardStepKey } from './wizard-state'

/** Operator question for the current wizard stage (UX Charter user questions). */
export const WIZARD_STAGE_PURPOSE: Record<WizardStepKey, string> = {
  connect: 'Can I connect to the source?',
  sample: 'Can I retrieve and identify the right records?',
  destinations: 'Where should the data go?',
  route_processing: 'Does any destination need different processing?',
  deploy: 'Am I ready to deploy?',
}

export function wizardStagePurpose(stepKey: WizardStepKey): string {
  return WIZARD_STAGE_PURPOSE[stepKey]
}
