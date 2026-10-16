import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleHelp, Loader2, RefreshCw } from 'lucide-react'
import { fetchCatalogSnapshot } from '../../../api/gdcCatalog'
import { fetchDestinationsList, invalidateDestinationsListCache } from '../../../api/gdcDestinations'
import { summarizeResourceReadiness, type Availability, type ReadinessResult, type ResourceSummary } from './wizard-resource-readiness-model'

const statusLabel: Record<Availability, string> = {
  checking: 'Checking',
  available: 'Configured',
  'needs-setup': 'Needs setup',
  'not-verified': 'Not verified',
}

const appearance: Record<Availability, string> = {
  checking: 'text-slate-600 bg-slate-100 dark:bg-gdc-section dark:text-slate-200',
  available: 'text-emerald-800 bg-emerald-50 dark:bg-emerald-500/15 dark:text-emerald-200',
  'needs-setup': 'text-amber-900 bg-amber-50 dark:bg-amber-500/15 dark:text-amber-200',
  'not-verified': 'text-slate-600 bg-slate-100 dark:bg-gdc-section dark:text-slate-200',
}

function ResourceLine({ label, resource }: { label: string; resource: ResourceSummary }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200/80 bg-white px-3 py-3 dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">{label}</span>
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${appearance[resource.state]}`}>
          {resource.state === 'checking' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> :
            resource.state === 'available' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> :
              resource.state === 'needs-setup' ? <AlertCircle className="h-3 w-3" aria-hidden /> :
                <CircleHelp className="h-3 w-3" aria-hidden />}
          {statusLabel[resource.state]}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-gdc-mutedStrong">{resource.description}</p>
    </div>
  )
}

/**
 * Configuration readiness, not a test of connectivity or delivery.
 * All reads use existing authenticated list APIs; failures never mean zero resources.
 */
export function WizardResourceReadiness() {
  const [resources, setResources] = useState<ReadinessResult>({
    source: { state: 'checking', description: 'Checking saved Connectors and Sources…' },
    destination: { state: 'checking', description: 'Checking saved Destinations…' },
  })
  const [busy, setBusy] = useState(true)
  const epoch = useRef(0)

  const refresh = useCallback(async (force = false) => {
    const request = ++epoch.current
    setBusy(true)
    if (force) invalidateDestinationsListCache()
    const [catalogResult, destinationResult] = await Promise.allSettled([
      fetchCatalogSnapshot(),
      fetchDestinationsList(),
    ])
    if (epoch.current !== request) return
    const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null
    const destinations = destinationResult.status === 'fulfilled' ? destinationResult.value : null
    setResources(summarizeResourceReadiness(catalog, destinations))
    setBusy(false)
  }, [])

  useEffect(() => {
    const activeEpoch = epoch
    void refresh()
    return () => { activeEpoch.current++ }
  }, [refresh])

  return (
    <section aria-label="Setup prerequisites" data-testid="wizard-resource-readiness" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 dark:border-gdc-border dark:bg-gdc-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Before you start</h3>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-gdc-mutedStrong">
            Reuse saved Source access and Destinations where possible. Configuration does not prove a working connection.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={busy}
          data-testid="wizard-recheck-resources"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-violet-300 disabled:cursor-wait disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
          Recheck resources
        </button>
      </div>
      <div aria-live="polite" className="grid gap-3 sm:grid-cols-2">
        <div data-testid="wizard-source-readiness"><ResourceLine label="Connector and Source" resource={resources.source} /></div>
        <div data-testid="wizard-destination-readiness"><ResourceLine label="Destination" resource={resources.destination} /></div>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
        You can choose a goal now. Actual Source testing, Destination selection and deployment occur in the five-step Wizard.
      </p>
    </section>
  )
}
