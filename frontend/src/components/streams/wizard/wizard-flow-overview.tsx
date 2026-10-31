import { ArrowRight } from 'lucide-react'
import { wizardSampleStepGateReady } from './wizard-step-gates'
import type { WizardState, WizardStepKey } from './wizard-state'

const STEP_ACTIONS: Record<WizardStepKey, string> = {
  connect: 'Choose where events come from and test the connection.',
  sample: 'Run a sample and confirm which records to collect.',
  destinations: 'Choose where to send your data. Each delivery path gets its own Route.',
  route_processing: 'Start with shared settings; customize only the destinations that need different handling.',
  deploy: 'Review readiness before saving. Then verify actual delivery in Stream monitoring.',
}

function deriveWizardFlowOutline(state: WizardState) {
  const sourceSelected =
    Number.isSafeInteger(state.connector.connectorId) && state.connector.connectorId! > 0 &&
    Number.isSafeInteger(state.connector.sourceId) && state.connector.sourceId! > 0
  const sourceDraft = !sourceSelected && Boolean(state.connector.registryModuleId?.trim())
  const sampleConfirmed = wizardSampleStepGateReady(state)
  const routes = state.destinations.routeDrafts
  const enabled = routes.filter((route) => route.enabled).length
  const destinationMissing = routes.some(
    (route) => route.enabled && (!Number.isSafeInteger(route.destinationId) || route.destinationId <= 0),
  )
  const customized = routes.filter((route) =>
    Object.values(route.inherit).some((isInherited) => isInherited === false),
  ).length

  return {
    source: {
      value: sourceSelected
        ? state.connector.connectorName.trim() || 'Source selected'
        : sourceDraft ? 'Connector module selected' : 'Choose a source',
      detail: sourceSelected
        ? sampleConfirmed ? 'Sample selection confirmed' : 'Source selected · confirm a sample'
        : sourceDraft ? 'Finish source setup and test it' : 'Where the data comes from',
    },
    processing: {
      value: routes.length === 0
        ? 'Choose destinations first'
        : customized === 0
          ? 'Shared settings by default'
          : `${customized} ${customized === 1 ? 'route' : 'routes'} customized`,
      detail: 'Transform and protect each destination path when needed',
    },
    delivery: {
      value: routes.length === 0
        ? 'Choose destinations'
        : destinationMissing
          ? 'Select a valid destination for each enabled delivery path'
          : `${enabled} of ${routes.length} delivery ${routes.length === 1 ? 'path' : 'paths'} enabled`,
      detail: destinationMissing
        ? 'An enabled route has no usable destination; delivery is not configured'
        : 'Configured destinations, not confirmed deliveries',
    },
  }
}

/**
 * Read-only explanation of the current configuration, not a runtime status view.
 * No credentials, sample payloads, or synthetic delivery-success metrics are shown.
 */
export function WizardFlowOverview({
  state,
  activeStep,
}: {
  state: WizardState
  activeStep: WizardStepKey
}) {
  const outline = deriveWizardFlowOutline(state)
  const stages = [
    { key: 'source', label: 'Source', ...outline.source },
    { key: 'processing', label: 'Process per route', ...outline.processing },
    { key: 'delivery', label: 'Destinations', ...outline.delivery },
  ] as const

  return (
    <section
      aria-label="Your data flow"
      data-testid="wizard-flow-overview"
      className="min-w-0 rounded-lg border border-default bg-surface-card p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-label text-fg">Your data flow</h3>
          <p className="mt-1 text-body-sm text-fg-secondary" data-testid="wizard-flow-next-action">
            Now: {STEP_ACTIONS[activeStep]}
          </p>
        </div>
        <span className="shrink-0 rounded-md border border-default bg-surface-section px-2 py-1 text-caption font-medium text-fg-secondary">
          Configuration view
        </span>
      </div>
      <div className="mt-3 flex min-w-0 flex-col gap-3 border-t border-default pt-3 sm:flex-row sm:items-center sm:gap-1" role="list" aria-label="Data flow stages">
        {stages.map((stage, index) => (
          <div key={stage.key} className="flex min-w-0 flex-1 items-center gap-2">
            <div
              role="listitem"
              data-testid={`wizard-flow-${stage.key}`}
              className="min-w-0 flex-1 px-1 py-1 sm:px-2"
            >
              <p className="text-caption font-semibold uppercase tracking-wide text-fg-muted">{stage.label}</p>
              <p className="mt-1 break-words text-label text-fg">{stage.value}</p>
              <p className="mt-1 break-words text-body-sm text-fg-secondary">{stage.detail}</p>
            </div>
            {index < stages.length - 1 ? (
              <ArrowRight className="hidden h-4 w-4 shrink-0 text-fg-muted sm:block" aria-hidden />
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-2 text-caption text-fg-muted">
        You choose destinations before tailoring Route Processing. This outline is not proof of live delivery.
      </p>
    </section>
  )
}
