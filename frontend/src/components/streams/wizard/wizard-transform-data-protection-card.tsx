import { ChevronDown, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import {
  dataProtectionDeliveryControlsSummary,
  validDataProtectionIntents,
} from './wizard-data-protection-summary'
import { WizardDataProtectionDrawer } from './wizard-data-protection-drawer'
import type { WizardDataProtectionState, WizardState } from './wizard-state'

export type WizardTransformDataProtectionCardProps = {
  state: WizardState
  onChange: (patch: Partial<WizardDataProtectionState>) => void
  drawerOpen?: boolean
  onDrawerOpenChange?: (open: boolean) => void
}

/** Optional Data Protection summary card at the bottom of the Transform step. */
export function WizardTransformDataProtectionCard({
  state,
  onChange,
  drawerOpen: controlledOpen,
  onDrawerOpenChange,
}: WizardTransformDataProtectionCardProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const drawerOpen = controlledOpen ?? internalOpen
  const setDrawerOpen = onDrawerOpenChange ?? setInternalOpen
  const ownsDrawer = controlledOpen === undefined

  const validIntents = validDataProtectionIntents(state.dataProtection.intents)
  const configured = validIntents.length > 0
  const deliverySummary = dataProtectionDeliveryControlsSummary(state.dataProtection.intents)

  return (
    <>
      <section
        className="rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
        data-testid="wizard-transform-data-protection-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
              <ShieldCheck className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Data Protection</h3>
                <span className="inline-flex rounded-full border border-slate-200/90 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted">
                  Optional
                </span>
              </div>
              {configured ? (
                <>
                  <p className="text-[12px] font-medium text-slate-800 dark:text-slate-100">
                    {validIntents.length} protection intent{validIntents.length === 1 ? '' : 's'} configured
                  </p>
                  {deliverySummary ? (
                    <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
                      Delivery controls: {deliverySummary}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                    Protect sensitive fields before delivery.
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-gdc-muted">No rules configured.</p>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-violet-300/70 bg-violet-500/[0.07] px-3 text-[12px] font-semibold text-violet-800 hover:bg-violet-500/15 dark:border-violet-500/40 dark:text-violet-200 dark:hover:bg-violet-500/20"
            data-testid={configured ? 'wizard-data-protection-edit' : 'wizard-data-protection-configure'}
          >
            {configured ? 'Edit Data Protection' : 'Configure Data Protection'}
            <ChevronDown className="h-3.5 w-3.5 -rotate-90" aria-hidden />
          </button>
        </div>
      </section>

      {ownsDrawer ? (
        <WizardDataProtectionDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          state={state}
          onChange={onChange}
        />
      ) : null}
    </>
  )
}
