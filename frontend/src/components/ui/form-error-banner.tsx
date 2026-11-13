import { useEffect, useRef } from 'react'
import { formatApiErrorMessage } from '../../lib/api-error-message'
import { cn } from '../../lib/utils'

type FormErrorBannerProps = {
  /** Raw validation text or transport error; status/code prefixes are stripped for display. */
  message: string | null | undefined
  className?: string
  'data-testid'?: string
}

/**
 * Form-level error that stays next to the action that produced it.
 *
 * Render it directly above the form's primary action (Save). When a new message appears it takes
 * focus and scrolls into view, so a failure on a long form is never left off-screen (F-002, F-004).
 */
export function FormErrorBanner({ message, className, 'data-testid': testId }: FormErrorBannerProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const text = message ? formatApiErrorMessage(message) : null

  useEffect(() => {
    const el = ref.current
    if (!el || !text) return
    try {
      el.focus({ preventScroll: true })
    } catch {
      /* focus is a convenience; the alert role still announces the message */
    }
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [text, message])

  if (!text) return null
  return (
    <p
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-testid={testId ?? 'form-error-banner'}
      className={cn(
        'rounded border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200',
        className,
      )}
    >
      {text}
    </p>
  )
}
