import { useEffect, useRef, type KeyboardEvent } from 'react'
import { AlertTriangle } from 'lucide-react'

export function WizardExitConfirmation({
  onKeepEditing,
  onSaveDraftAndLeave,
  onDiscardAndLeave,
}: {
  onKeepEditing: () => void
  onSaveDraftAndLeave: () => void
  onDiscardAndLeave: () => void
}) {
  const dialog = useRef<HTMLElement>(null)
  const keepEditing = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    keepEditing.current?.focus()
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onKeepEditing()
      return
    }
    if (event.key !== 'Tab') return
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (buttons.length === 0) return
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="presentation">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-exit-title"
        aria-describedby="wizard-exit-description"
        data-testid="wizard-unsaved-exit-dialog"
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-gdc-border dark:bg-gdc-panel sm:p-6"
      >
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-amber-50 p-2 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200" aria-hidden>
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h2 id="wizard-exit-title" className="text-lg font-semibold text-slate-900 dark:text-white">
              Leave this Data Flow setup?
            </h2>
            <p id="wizard-exit-description" className="mt-2 text-sm leading-6 text-slate-600 dark:text-gdc-mutedStrong">
              Your current configuration is not confirmed as saved. Save a local draft to resume the same step, or
              explicitly discard it. Local drafts redact known credential fields and raw response bodies.
              Re-enter secrets and repeat Source testing after resuming.
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            ref={keepEditing}
            onClick={onKeepEditing}
            className="min-h-10 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            data-testid="wizard-exit-keep"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onDiscardAndLeave}
            className="min-h-10 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500 dark:border-red-500/30 dark:bg-gdc-card dark:text-red-300"
            data-testid="wizard-exit-discard"
          >
            Discard and leave
          </button>
          <button
            type="button"
            onClick={onSaveDraftAndLeave}
            className="min-h-10 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
            data-testid="wizard-exit-save"
          >
            Save draft and leave
          </button>
        </div>
      </section>
    </div>
  )
}
