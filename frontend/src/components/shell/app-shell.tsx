import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

type AppShellProps = {
  sidebar: ReactNode
  header: ReactNode
  children: ReactNode
  className?: string
  /** When true on narrow viewports, dim the workspace behind the drawer. */
  mobileNavOpen?: boolean
  onMobileNavClose?: () => void
}

export function AppShell({
  sidebar,
  header,
  children,
  className,
  mobileNavOpen = false,
  onMobileNavClose,
}: AppShellProps) {
  return (
    <div className={cn('flex min-h-screen', className)}>
      {mobileNavOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-slate-900/35 backdrop-blur-[1px] md:hidden"
          aria-label="Close navigation"
          onClick={onMobileNavClose}
        />
      ) : null}
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {header}
        <div className="gdc-app-workspace min-h-0 min-w-0 flex-1 overflow-x-hidden bg-slate-50 dark:bg-gdc-page">
          {children}
        </div>
      </div>
    </div>
  )
}
