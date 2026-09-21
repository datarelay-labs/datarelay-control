import type { ReactNode } from 'react'
import { Activity, Menu, Moon, RefreshCw, Settings, Sun, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { NAV_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { GDC_HEADER_REFRESH_EVENT } from './header-refresh-event'

/** Truthful destination for shell health/alerts affordance (Validation → Alerts). */
export const SHELL_ALERTS_PATH = `${NAV_PATH.validation}/alerts`

type TopHeaderProps = {
  title: string
  /** Optional breadcrumb row above the title (e.g. Streams / … / Runtime). */
  breadcrumb?: ReactNode
  runtimeSummary?: string
  runtimeHealthy?: boolean
  isDark: boolean
  onToggleTheme: () => void
  onRefresh?: () => void
  /** Narrow-viewport navigation drawer control. */
  mobileNavOpen?: boolean
  onMobileNavToggle?: () => void
}

export function TopHeader({
  title,
  breadcrumb,
  runtimeSummary = '24 streams active · delivery path nominal',
  runtimeHealthy = true,
  isDark,
  onToggleTheme,
  onRefresh,
  mobileNavOpen = false,
  onMobileNavToggle,
}: TopHeaderProps) {
  const navigate = useNavigate()

  function handleHeaderRefresh() {
    onRefresh?.()
    if (typeof globalThis.window !== 'undefined') {
      globalThis.window.dispatchEvent(new CustomEvent(GDC_HEADER_REFRESH_EVENT))
    }
  }

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/95 px-3 py-3 backdrop-blur-md dark:border-gdc-border dark:bg-gdc-panel/95 md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {onMobileNavToggle ? (
            <button
              type="button"
              onClick={onMobileNavToggle}
              className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
              aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileNavOpen}
              aria-controls="primary-navigation"
              data-testid="shell-mobile-nav-toggle"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-x-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {breadcrumb ? (
                <div className="min-w-0 text-xs leading-snug text-slate-500 dark:text-gdc-muted">{breadcrumb}</div>
              ) : null}
              <h1 className="shrink-0 text-lg font-semibold tracking-tight text-slate-900 dark:text-gdc-foreground">
                {title}
              </h1>
            </div>
            <div className="hidden h-4 w-px shrink-0 bg-slate-200 dark:bg-gdc-border sm:block" aria-hidden />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium',
                  runtimeHealthy
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-100/90'
                    : 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100/90',
                )}
                aria-label="Runtime status"
              >
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', runtimeHealthy ? 'bg-emerald-500' : 'bg-amber-500')}
                  aria-hidden
                />
                {runtimeHealthy ? 'Healthy' : 'Attention'}
              </span>
              <span className="min-w-0 text-xs leading-snug text-slate-600 dark:text-gdc-muted">{runtimeSummary}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => navigate(SHELL_ALERTS_PATH)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Open runtime health alerts"
            title="Runtime health — Alerts"
            data-testid="shell-health-alerts"
          >
            <Activity className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => navigate(NAV_PATH.settings)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Open settings"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleHeaderRefresh}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Refresh dashboard and runtime data"
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
            aria-label="Toggle color theme"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  )
}
