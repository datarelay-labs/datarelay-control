import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { NAV_PATH } from '../../config/nav-paths'
import { isAiGatewayFoundationEnabled } from '../../lib/feature-flags'

export function AiGatewayFoundationGuard({ children }: { children: ReactNode }) {
  if (!isAiGatewayFoundationEnabled()) {
    return <Navigate to={NAV_PATH.streams} replace />
  }
  return <>{children}</>
}
