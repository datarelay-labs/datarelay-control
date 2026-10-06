import { CircleHelp, ExternalLink, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

export type PageHelpSection = {
  title: string
  body?: string
  bullets?: readonly string[]
}

export type PageHelpContent = {
  title: string
  intro: string
  sections: readonly PageHelpSection[]
  docsHref?: string
}

export type PagePurposeHeaderProps = {
  title: string
  purpose: string
  help: PageHelpContent
  actions?: ReactNode
  testId?: string
  showTitle?: boolean
}

export function PagePurposeHeader({
  title,
  purpose,
  help,
  actions,
  testId = 'page-purpose-header',
  showTitle = true,
}: PagePurposeHeaderProps) {
  const [helpOpen, setHelpOpen] = useState(false)
  const titleId = useId()
  const helpButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  const closeHelp = useCallback(() => {
    setHelpOpen(false)
    window.setTimeout(() => helpButtonRef.current?.focus({ preventScroll: true }), 0)
  }, [])

  useEffect(() => {
    if (!helpOpen) return
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeHelp()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute('hidden') && node.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialog.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [helpOpen, closeHelp])

  return (
    <>
      <header
        className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between"
        data-testid={testId}
      >
        <div className="space-y-2">
          {showTitle ? (
            <h1 id={titleId} className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              {title}
            </h1>
          ) : null}
          <p className="max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">{purpose}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <button
            ref={helpButtonRef}
            type="button"
            onClick={() => setHelpOpen(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            data-testid="page-help-open"
          >
            <CircleHelp className="h-4 w-4" aria-hidden />
            Help
          </button>
        </div>
      </header>

      {helpOpen ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="fixed inset-0 z-[70] bg-slate-950/35 backdrop-blur-[1px]"
            onClick={closeHelp}
          />
          <aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId + '-help'}
            className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-gdc-border dark:bg-gdc-card"
            data-testid="page-help-drawer"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-gdc-divider">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Page help</p>
                <h2 id={titleId + '-help'} className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                  {help.title}
                </h2>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeHelp}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-300 dark:hover:bg-gdc-rowHover"
                aria-label="Close help"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">{help.intro}</p>
              <div className="mt-6 space-y-6">
                {help.sections.map((section) => (
                  <section key={section.title} className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{section.title}</h3>
                    {section.body ? (
                      <p className="text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">{section.body}</p>
                    ) : null}
                    {section.bullets?.length ? (
                      <ul className="space-y-2 pl-5 text-sm leading-relaxed text-slate-600 marker:text-slate-400 dark:text-gdc-muted">
                        {section.bullets.map((bullet) => (
                          <li key={bullet} className="list-disc">
                            {bullet}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                ))}
              </div>
            </div>

            {help.docsHref ? (
              <div className="border-t border-slate-200 px-5 py-4 dark:border-gdc-divider">
                <a
                  href={help.docsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-violet-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/40 dark:text-violet-300"
                >
                  Read full documentation
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
            ) : null}
          </aside>
        </>
      ) : null}
    </>
  )
}
