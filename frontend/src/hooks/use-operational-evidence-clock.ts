import { useEffect, useState } from 'react'

/**
 * Re-check snapshot freshness at the existing 90-second observation boundary.
 * This is a UI-only clock: no polling, network request or source data mutation.
 * Returning to a throttled/background tab forces an immediate evidence recheck.
 */
export function useOperationalEvidenceClock(updatedAt: string | undefined): void {
  const [, recheckEvidenceClock] = useState(0)
  useEffect(() => {
    if (!updatedAt) return
    const checkClock = () => recheckEvidenceClock((version) => version + 1)
    const observedAt = Date.parse(updatedAt)
    const remainingMs = observedAt + 90_000 + 1 - Date.now()
    const expiryTimer = Number.isFinite(observedAt) && remainingMs > 0 && remainingMs <= 2_147_483_647
      ? window.setTimeout(checkClock, remainingMs)
      : null
    window.addEventListener('focus', checkClock)
    document.addEventListener('visibilitychange', checkClock)
    return () => {
      if (expiryTimer !== null) window.clearTimeout(expiryTimer)
      window.removeEventListener('focus', checkClock)
      document.removeEventListener('visibilitychange', checkClock)
    }
  }, [updatedAt])
}
