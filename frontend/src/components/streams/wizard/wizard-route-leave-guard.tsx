import { useContext, useEffect, type MutableRefObject } from 'react'
import { useBlocker } from 'react-router-dom'
import { NAV_PATH } from '../../../config/nav-paths'
import { DataRouterEnabledContext } from '../../../router/data-router-enabled'

export type WizardBlockedNavigation = {
  proceed: () => void
  reset: () => void
}

type GuardProps = {
  active: boolean
  allowedNextPathRef: MutableRefObject<string | null>
  onBlocked: (navigation: WizardBlockedNavigation) => void
}

/**
 * A data router is required for useBlocker. Keep declarative MemoryRouter
 * component tests mounted without the hook; production uses RouterProvider.
 */
export function WizardRouteLeaveGuard(props: GuardProps) {
  const dataRouterEnabled = useContext(DataRouterEnabledContext)
  return dataRouterEnabled ? <DataRouterWizardLeaveGuard {...props} /> : null
}

function DataRouterWizardLeaveGuard({ active, allowedNextPathRef, onBlocked }: GuardProps) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!active) return false
    if (
      currentLocation.pathname === nextLocation.pathname &&
      currentLocation.search === nextLocation.search
    ) return false

    const allowed = allowedNextPathRef.current
    if (
      allowed != null &&
      (nextLocation.pathname === allowed ||
        (allowed === NAV_PATH.destinations && nextLocation.pathname.startsWith(`${allowed}/`)))
    ) {
      allowedNextPathRef.current = null
      return false
    }
    return true
  })

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    onBlocked({ proceed: blocker.proceed, reset: blocker.reset })
  }, [blocker, onBlocked])

  return null
}
