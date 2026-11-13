import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Open modals, topmost last: only the topmost one reacts to Escape and Tab.
const modalStack: symbol[] = []

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  )
}

type Options = {
  open: boolean
  containerRef: RefObject<HTMLElement | null>
  /** Preferred element for initial focus (for example the safe Cancel button). */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Called on Escape. */
  onEscape: () => void
  /** While true Escape is ignored (for example while a request is in flight). */
  escapeDisabled?: boolean
}

/**
 * Keyboard behaviour every modal dialog needs (F-228): initial focus inside the dialog, Tab/Shift+Tab
 * trapped within it, Escape to dismiss from anywhere, and focus returned to the opener on close.
 */
export function useModalA11y({ open, containerRef, initialFocusRef, onEscape, escapeDisabled = false }: Options): void {
  const onEscapeRef = useRef(onEscape)
  const escapeDisabledRef = useRef(escapeDisabled)
  onEscapeRef.current = onEscape
  escapeDisabledRef.current = escapeDisabled

  useEffect(() => {
    if (!open) return undefined
    const token = Symbol('modal')
    modalStack.push(token)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current

    const preferred = initialFocusRef?.current
    const target =
      preferred && !(preferred as HTMLButtonElement).disabled
        ? preferred
        : container
          ? (focusableWithin(container)[0] ?? container)
          : null
    target?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== token) return
      if (event.key === 'Escape') {
        if (escapeDisabledRef.current) return
        event.preventDefault()
        onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab' || !container) return
      const items = focusableWithin(container)
      if (items.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (!container.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = modalStack.indexOf(token)
      if (index >= 0) modalStack.splice(index, 1)
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [open, containerRef, initialFocusRef])
}
