import { ShieldCheck } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { isGovernanceModeEnabled } from '../../../utils/governance-mode'

type WizardGovernanceStartModalProps = {
  open: boolean
  governanceForStream: boolean
  onGovernanceForStreamChange: (enabled: boolean) => void
  onStart: () => void
  onCancel: () => void
}

export function WizardGovernanceStartModal({
  open,
  governanceForStream,
  onGovernanceForStreamChange,
  onStart,
  onCancel,
}: WizardGovernanceStartModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => {
      previouslyFocusedRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const tenantGov = isGovernanceModeEnabled()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-governance-modal-title"
      data-testid="wizard-governance-start-modal"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
          return
        }
        if (event.key !== 'Tab') return
        const root = event.currentTarget
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200/90 bg-white p-5 shadow-xl dark:border-gdc-border dark:bg-gdc-card">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
            <ShieldCheck className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="wizard-governance-modal-title" className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Enable data governance?
            </h2>
            <p className="mt-1 text-[13px] text-slate-600 dark:text-gdc-muted">
              Applies sensitive-data, protection, classification, and response controls in Route Processing. Default is off for connector operators.
            </p>
          </div>
        </div>

        {tenantGov ? (
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200/90 p-3 dark:border-gdc-border">
            <input
              type="checkbox"
              className="mt-1"
              checked={governanceForStream}
              onChange={(e) => onGovernanceForStreamChange(e.target.checked)}
            />
            <div>
              <p className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">
                Enable data governance for this stream
              </p>
              <p className="mt-0.5 text-[11px] text-slate-600 dark:text-gdc-muted">
                Recommended for regulated data. Includes sensitive data, protection, classification, and response actions in Route Processing.
              </p>
            </div>
          </label>
        ) : (
          <p className="mt-4 rounded-md border border-slate-200/80 bg-slate-50/80 px-3 py-2 text-[11px] text-slate-600 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
            Tenant governance mode is off. The standard wizard continues without stream governance controls.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onStart}
            className="inline-flex h-9 items-center rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700"
          >
            Start Wizard
          </button>
        </div>
      </div>
    </div>
  )
}
