import { LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { postAuthLogout } from '../../api/gdcAdmin'
import { clearSession, readSession } from '../../auth/session'
import type { SidebarNavEntry, SidebarTopItem } from '../../config/app-navigation'
import { getDatarelayInstanceLabel } from '../../config/datarelay-instance-label'
import type { PlatformPersona } from '../../utils/persona-mode'
import { PersonaSwitcher } from './persona-switcher'
import { isInternalOperatorUiEnabled } from '../../lib/feature-flags'
import { isNavKeyActive } from './sidebar-nav-active'

export type { AppNavKey } from '../../config/app-navigation'

type SidebarProps = {
  structure: readonly SidebarNavEntry[]
  collapsed: boolean
  /** Narrow-viewport drawer visibility. Ignored at `md` and up. */
  mobileOpen: boolean
  pathname: string
  persona: PlatformPersona
  onPersonaChange: (persona: PlatformPersona) => void
  onToggleCollapsed: () => void
  onNavigate: (path: string) => void
  onMobileClose?: () => void
}

async function performSignOut(): Promise<void> {
  try {
    await postAuthLogout({ revoke_all: false })
  } catch {
    /* logout is best-effort; client cleanup must happen regardless */
  }
  clearSession()
  try {
    window.location.assign('/streams')
  } catch {
    /* ignore */
  }
}

function userInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '—'
  const parts = trimmed.split(/[._\-\s]+/).filter(Boolean)
  if (parts.length === 0) return trimmed.slice(0, 2).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function roleLabel(role: string): string {
  if (role === 'ADMINISTRATOR') return 'Administrator'
  if (role === 'OPERATOR') return 'Operator'
  if (role === 'VIEWER') return 'Viewer'
  return role
}

function isGroupActive(pathname: string, items: readonly SidebarTopItem[]): boolean {
  return items.some((item) => isNavKeyActive(pathname, item.key))
}

function NavButton({
  item,
  collapsed,
  pathname,
  onNavigate,
  nested = false,
}: {
  item: SidebarTopItem
  collapsed: boolean
  pathname: string
  onNavigate: (path: string) => void
  nested?: boolean
}) {
  const ItemIcon = item.icon as ComponentType<{ className?: string }>
  const active = isNavKeyActive(pathname, item.key)
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.path)}
      title={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg py-2 text-left text-sm transition-colors',
        active
          ? 'bg-slate-100 font-medium text-slate-900 dark:bg-gdc-rowHover dark:text-gdc-foreground'
          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-gdc-muted dark:hover:bg-gdc-rowHover dark:hover:text-gdc-foreground',
        collapsed ? 'justify-center px-0' : nested ? 'pl-8 pr-3' : 'px-3',
      )}
    >
      {!nested || collapsed ? (
        <ItemIcon
          className={cn(
            'h-[18px] w-[18px] shrink-0',
            active ? 'text-slate-700 dark:text-gdc-foreground' : 'text-slate-400 dark:text-gdc-muted',
          )}
          aria-hidden
        />
      ) : (
        <span className="h-[18px] w-[18px] shrink-0" aria-hidden />
      )}
      {!collapsed ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
    </button>
  )
}

export function Sidebar({
  structure,
  collapsed,
  mobileOpen,
  pathname,
  persona,
  onPersonaChange,
  onToggleCollapsed,
  onNavigate,
  onMobileClose,
}: SidebarProps) {
  function handleNavigate(path: string) {
    onNavigate(path)
    onMobileClose?.()
  }

  return (
    <aside
      id="primary-navigation"
      aria-label="Primary navigation"
      data-mobile-open={mobileOpen ? 'true' : 'false'}
      className={cn(
        'fixed inset-y-0 left-0 z-50 flex h-screen shrink-0 flex-col border-r border-slate-200/80 bg-white transition-[width,transform] duration-200 ease-out dark:border-gdc-border dark:bg-gdc-panel',
        'md:sticky md:translate-x-0',
        mobileOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full md:shadow-none',
        collapsed ? 'w-16 md:w-16' : 'w-[260px] md:w-[240px]',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2 border-b border-slate-100 px-3 py-3 dark:border-gdc-border',
          collapsed ? 'flex-col gap-2' : 'justify-between',
        )}
      >
        <Link
          to="/monitoring"
          onClick={() => onMobileClose?.()}
          className={cn(
            'flex min-w-0 items-center gap-2.5 rounded-lg outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-300 dark:hover:bg-gdc-rowHover dark:focus-visible:ring-gdc-primary/40',
            collapsed && 'flex-col items-center',
          )}
          aria-label="DataRelay — Dashboard home"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            <img
              src="/logo/datarelay-logo.svg"
              alt=""
              width={32}
              height={32}
              className="h-8 w-8"
              draggable={false}
            />
          </div>
          {!collapsed ? (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold tracking-tight">
                <span className="text-slate-900 dark:text-white">Data</span>
                <span className="text-[#00D084]">Relay</span>
              </p>
              <p className="truncate text-xs text-slate-500 dark:text-gdc-muted">{getDatarelayInstanceLabel()}</p>
            </div>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 md:inline-flex dark:text-gdc-muted dark:hover:bg-gdc-rowHover"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" role="navigation">
        {structure.map((entry) => {
          if (entry.type === 'item') {
            return (
              <NavButton
                key={entry.item.key}
                item={entry.item}
                collapsed={collapsed}
                pathname={pathname}
                onNavigate={handleNavigate}
              />
            )
          }

          const groupActive = isGroupActive(pathname, entry.group.items)
          return (
            <div key={entry.group.id} className="space-y-0.5 pt-2 first:pt-0">
              {!collapsed ? (
                <p
                  className={cn(
                    'px-3 pb-1 text-[11px] font-medium tracking-wide',
                    groupActive ? 'text-slate-700 dark:text-gdc-foreground' : 'text-slate-400 dark:text-gdc-muted',
                  )}
                >
                  {entry.group.label}
                </p>
              ) : (
                <div
                  className="mx-auto my-1 h-px w-6 bg-slate-200 dark:bg-gdc-border"
                  aria-hidden
                  title={entry.group.label}
                />
              )}
              {entry.group.items.map((item) => (
                <NavButton
                  key={item.key}
                  item={item}
                  collapsed={collapsed}
                  pathname={pathname}
                  onNavigate={handleNavigate}
                  nested
                />
              ))}
            </div>
          )
        })}
      </nav>

      <div
        className={cn(
          'mt-auto space-y-2 border-t border-slate-100 p-2 dark:border-gdc-border',
          collapsed && 'px-1.5',
        )}
      >
        {isInternalOperatorUiEnabled() ? (
          <PersonaSwitcher persona={persona} collapsed={collapsed} onPersonaChange={onPersonaChange} />
        ) : null}
        {!collapsed ? (
          <p className="px-2 text-[11px] text-slate-400 dark:text-gdc-muted">
            {isInternalOperatorUiEnabled() ? 'v0.0.0' : 'v1.0.0-rc'}
          </p>
        ) : null}

        {/* Static environment status — not a selector (no switching exists). */}
        {!collapsed ? (
          <div
            className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-gdc-section"
            role="status"
            aria-label="Environment: Production"
            data-testid="shell-environment-status"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
            <span className="min-w-0">
              <span className="block text-[11px] text-slate-500 dark:text-gdc-muted">Environment</span>
              <span className="block text-sm font-medium text-slate-800 dark:text-gdc-foreground">Production</span>
            </span>
          </div>
        ) : (
          <div
            className="flex justify-center py-1"
            title="Environment: Production"
            role="status"
            aria-label="Environment: Production"
            data-testid="shell-environment-status"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
          </div>
        )}

        {!collapsed ? <SidebarUserPanel /> : <SidebarUserPanelCollapsed />}
      </div>
    </aside>
  )
}

function SidebarUserPanel() {
  const session = readSession()
  const username = session?.user.username ?? 'Anonymous'
  const role = session?.user.role ?? 'VIEWER'
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200/90 text-xs font-semibold text-slate-700 dark:bg-gdc-rowHover dark:text-gdc-foreground">
          {userInitials(username)}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-gdc-foreground">{username}</p>
          <p className="truncate text-xs text-slate-500 dark:text-gdc-muted">{roleLabel(role)}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void performSignOut()}
        className="flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-slate-600 transition hover:bg-red-50 hover:text-red-700 dark:text-gdc-muted dark:hover:bg-red-500/10 dark:hover:text-red-200"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        Sign out
      </button>
    </div>
  )
}

function SidebarUserPanelCollapsed() {
  const session = readSession()
  const username = session?.user.username ?? 'Anonymous'
  const role = session?.user.role ?? 'VIEWER'
  return (
    <div className="space-y-1">
      <div className="flex justify-center py-0.5" title={`${username} (${roleLabel(role)})`}>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200/90 text-[10px] font-semibold text-slate-700 dark:bg-gdc-rowHover dark:text-gdc-foreground">
          {userInitials(username)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void performSignOut()}
        className="flex w-full items-center justify-center rounded-lg px-1.5 py-2 text-slate-500 transition hover:bg-red-50 hover:text-red-700 dark:text-gdc-muted dark:hover:bg-red-500/10 dark:hover:text-red-200"
        title="Sign out"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
