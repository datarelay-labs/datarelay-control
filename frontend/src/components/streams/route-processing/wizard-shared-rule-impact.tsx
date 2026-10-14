import type { DestinationListItem } from '../../../api/gdcDestinations'
import {
  computeWizardRouteProcessingStatuses,
  type RouteProcessingStatus,
  type WizardDataProtectionState,
  type WizardRouteDraft,
} from '../wizard/wizard-state'
import { ROUTE_PROCESSING_CONCERN_LABEL, type RouteProcessingConcernKey } from './route-processing-labels'

const IMPACT_LABEL: Record<RouteProcessingStatus, string> = {
  Inherited: 'Uses shared rules',
  Overridden: 'Customized for this destination',
  Mixed: 'Shared and destination-specific rules',
}

/** Display current draft ownership only; this is not a second evaluator or apply action. */
export function WizardSharedRuleImpact({ routes, destinations, dataProtection, concern, onSelectRoute }: {
  routes: readonly WizardRouteDraft[]
  destinations: readonly Pick<DestinationListItem, 'id' | 'name'>[]
  dataProtection: WizardDataProtectionState
  concern: 'transform' | 'data_protection'
  onSelectRoute?: (key: string) => void
}) {
  if (routes.length === 0) return null
  const names = new Map(destinations.map((destination) => [destination.id, destination.name]))
  const concerns: readonly RouteProcessingConcernKey[] = concern === 'transform'
    ? ['transform'] : ['protection', 'classification', 'policy']

  return <details className="mt-3 text-sm" data-testid="shared-rule-impact">
    <summary className="w-fit cursor-pointer rounded-md py-2 font-semibold text-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-200">
      Review impact on {routes.length} Route{routes.length === 1 ? '' : 's'}
    </summary>
    <p className="mb-2 text-sm text-slate-600 dark:text-gdc-muted">
      Draft configuration only — no settings have been applied by opening this view.
      {concern === 'data_protection' ? ' Shared and field-customized rules require a Route preview before applying a shared change.' : ' Mixed settings can still use shared Mapping or Enrichment. Preview each customized Route before applying a shared change.'}
    </p>
    {routes.length > 100 ? <p className="mb-2 text-sm text-amber-900 dark:text-amber-200">Showing 100 of {routes.length} Routes.</p> : null}
    <div className="max-h-80 overflow-auto rounded-md border border-slate-200 dark:border-gdc-border" tabIndex={0} role="region" aria-label="Scrollable shared rule impact">
      <table className="w-full min-w-[28rem] text-left text-sm" aria-label="Shared rule impact by Route">
        <thead className="sticky top-0 bg-slate-100 text-slate-800 dark:bg-gdc-section dark:text-gdc-foreground">
          <tr><th className="p-3 font-semibold" scope="col">Destination</th>
            {concerns.map((key) => <th key={key} className="p-3 font-semibold" scope="col">{ROUTE_PROCESSING_CONCERN_LABEL[key]}</th>)}
          </tr>
        </thead>
        <tbody>{routes.slice(0, 100).map((draft, index) => {
          const name = names.get(draft.destinationId)?.trim() || `Destination #${draft.destinationId}`
          const statuses = computeWizardRouteProcessingStatuses(draft, dataProtection)
          return <tr key={draft.key} className="border-t border-slate-200 align-top text-slate-800 dark:border-gdc-border dark:text-gdc-foreground">
            <th className="max-w-64 break-words p-3 font-normal" scope="row">
              {onSelectRoute ? <button type="button" className="text-left font-semibold text-violet-800 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-200"
                aria-label={`Review ${name}`} onClick={() => onSelectRoute(draft.key)}>{name}</button> : <span className="font-semibold">{name}</span>}
              <span className="mt-1 block text-xs text-slate-600 dark:text-gdc-muted">Route {index + 1} · Destination #{draft.destinationId}{draft.enabled ? '' : ' · Disabled'}</span>
            </th>
            {concerns.map((key) => {
              const load = key === 'transform' ? undefined : draft.governanceLoad?.[key]
              const unknown = load === 'unloaded' || load === 'unavailable' || load === 'passthrough'
              return <td key={key} className="min-w-40 p-3">
                <span>{unknown ? 'Not verified' : IMPACT_LABEL[statuses[key]]}</span>
                {unknown ? <span className="mt-1 block text-xs text-amber-900 dark:text-amber-200">Existing rules were not fully loaded.</span>
                  : <span className="mt-1 block text-xs text-slate-600 dark:text-gdc-muted">{statuses[key]}</span>}
              </td>
            })}
          </tr>
        })}</tbody>
      </table>
    </div>
  </details>
}
