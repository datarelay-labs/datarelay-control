import type { KeyboardEvent } from 'react'

const FORWARD_KEYS = new Set(['ArrowRight', 'ArrowDown'])
const BACKWARD_KEYS = new Set(['ArrowLeft', 'ArrowUp'])

/**
 * WAI-ARIA-style roving keyboard navigation for horizontal/compact tablists.
 * Arrow keys wrap; Home/End jump to the first/last enabled tab.
 * The target tab's existing click handler remains the single activation path.
 */
export function handleTablistKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
  const key = event.key
  if (!FORWARD_KEYS.has(key) && !BACKWARD_KEYS.has(key) && key !== 'Home' && key !== 'End') return

  const tablist = event.currentTarget.closest('[role="tablist"]')
  if (!tablist) return

  const tabs = Array.from(
    tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
  )
  if (tabs.length === 0) return

  const currentIndex = tabs.indexOf(event.currentTarget)
  if (currentIndex < 0) return

  let nextIndex = currentIndex
  if (key === 'Home') nextIndex = 0
  else if (key === 'End') nextIndex = tabs.length - 1
  else if (FORWARD_KEYS.has(key)) nextIndex = (currentIndex + 1) % tabs.length
  else nextIndex = (currentIndex - 1 + tabs.length) % tabs.length

  const target = tabs[nextIndex]
  if (!target) return

  event.preventDefault()
  target.focus()
  target.click()
}
