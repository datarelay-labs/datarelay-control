import { useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { Bell, CircleHelp, Menu, Moon, Plus, RefreshCw, Settings, Sun, X } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { NAV_PATH, newStreamPath } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { isSessionExpired, onSessionChange, readSession } from '../../auth/session'
import { getSessionCapabilities } from '../../lib/rbac'
import { GDC_HEADER_REFRESH_EVENT } from './header-refresh-event'

/** Global operational-alert surface. Kept out of primary sidebar by UX charter. */
export const SHELL_ALERTS_PATH = NAV_PATH.alerts

const DATA_FLOW_LANDING_PATHS = new Set([
  NAV_PATH.dashboard,
  NAV_PATH.streams,
  NAV_PATH.connectors,
  NAV_PATH.destinations,
  NAV_PATH.routes,
])

// This is a presentation-only guard; the backend still owns mutation authority.
function canStartDataFlow(): boolean {
  const session = readSession()
  if (!session || isSessionExpired() || session.user.status !== 'ACTIVE' || session.user.must_change_password) return false
  return ['ADMINISTRATOR', 'OPERATOR', 'CONNECTOR_OPERATOR'].includes(session.user.role)
    && getSessionCapabilities().workspace_mutations === true
}

type TopHeaderProps = {
  title: string
  /** Optional breadcrumb row above the title (e.g. Streams / … / Runtime). */
  breadcrumb?: ReactNode
  runtimeSummary?: string
  /** Only explicitly measured health may be green; null means not verified. */
  runtimeHealthy?: boolean | null
  runtimeStatusLabel?: string
  runtimeStatusEvidence?: string
  showRuntimeStatus?: boolean
  isDark: boolean
  onToggleTheme: () => void
  onRefresh?: () => void
  /** Narrow-viewport navigation drawer control. */
  mobileNavOpen?: boolean
  onMobileNavToggle?: () => void
  /** Ref used to restore focus after the mobile drawer closes. */
  mobileNavToggleRef?: Ref<HTMLButtonElement>
}

export function TopHeader({
  title,
  breadcrumb,
  runtimeSummary = 'Runtime state has not been verified.',
  runtimeHealthy = null,
  runtimeStatusLabel,
  runtimeStatusEvidence,
  showRuntimeStatus = true,
  isDark,
  onToggleTheme,
  onRefresh,
  mobileNavOpen = false,
  onMobileNavToggle,
  mobileNavToggleRef,
}: TopHeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const canCreateFlow = useSyncExternalStore(onSessionChange, canStartDataFlow, () => false)
  const showNewDataFlow = canCreateFlow && DATA_FLOW_LANDING_PATHS.has(location.pathname)

  function handleHeaderRefresh() {
    onRefresh?.()
    if (typeof globalThis.window !== 'undefined') {
      globalThis.window.dispatchEvent(new CustomEvent(GDC_HEADER_REFRESH_EVENT))
    }
  }

  return (
    <header className="sticky top-0 z-10 min-h-[58px] border-b border-slate-200 bg-white px-3 py-2 dark:border-gdc-border dark:bg-gdc-panel md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {onMobileNavToggle ? (
            <button
              ref={mobileNavToggleRef}
              type="button"
              onClick={onMobileNavToggle}
              className="mt-0.5 inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-slate-600 outline-none hover:bg-slate-100 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-violet-400 md:hidden dark:text-gdc-muted dark:hover:bg-gdc-rowHover dark:focus:outline-violet-300"
              aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileNavOpen}
              aria-controls="primary-navigation"
              data-testid="shell-mobile-nav-toggle"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          ) : null}

          <div
            className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-x-4"
            {...(mobileNavOpen ? { inert: true } : {})}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {breadcrumb ? (
                <div className="min-w-0 text-xs leading-snug text-slate-500 dark:text-gdc-muted">{breadcrumb}</div>
              ) : null}
              <h1 className="shrink-0 text-lg font-semibold text-slate-900 dark:text-gdc-foreground">
                {title}
              </h1>
            </div>
            <div className="hidden h-4 w-px shrink-0 bg-slate-200 dark:bg-gdc-border sm:block" aria-hidden />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {showRuntimeStatus ? <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
                  runtimeHealthy === true
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-100/90'
                    : runtimeHealthy === false
                      ? 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100/90'
                      : 'bg-slate-100 text-slate-600 dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                )}
                aria-label="Runtime status"
              >
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', runtimeHealthy === true ? 'bg-emerald-500' : runtimeHealthy === false ? 'bg-amber-500' : 'bg-slate-400')}
                  aria-hidden
                />
                {runtimeStatusLabel ?? (runtimeHealthy === true ? 'Healthy' : runtimeHealthy === false ? 'Attention' : 'Not verified')}
              </span> : null}
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs leading-snug text-slate-600 dark:text-gdc-muted">{runtimeSummary}</p>
                {showRuntimeStatus && runtimeStatusEvidence ? (
                  <p data-testid="shell-runtime-evidence" role="status" aria-live="polite" aria-atomic="true" className="text-[11px] leading-snug text-slate-500 dark:text-gdc-muted">
                    {runtimeStatusEvidence}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto" {...(mobileNavOpen ? { inert: true } : {})}>
          {showNewDataFlow ? (
            <Link
              to={newStreamPath()}
              onClick={(event) => {
                if (!canStartDataFlow()) event.preventDefault()
              }}
              className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-gdc-primary px-3 text-xs font-semibold text-white hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
              aria-label="New data flow"
              title="Start a new Stream, then configure Routes and Destinations before delivery"
              data-testid="shell-new-data-flow"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="hidden min-[375px]:inline">New data flow</span>
            </Link>
          ) : null}
          <Link
            to="/help"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Open Help Center"
            title="Help Center"
            data-testid="shell-help-center"
          >
            <CircleHelp className="h-4 w-4" aria-hidden />
          </Link>
          <button
            type="button"
            onClick={() => navigate(SHELL_ALERTS_PATH)}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Open operational alerts"
            title="Operational alerts"
            data-testid="shell-health-alerts"
          >
            <Bell className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => navigate(NAV_PATH.settings)}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Open settings"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleHeaderRefresh}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Refresh dashboard and runtime data"
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Toggle color theme"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  )
}
