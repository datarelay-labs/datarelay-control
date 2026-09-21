import type { SidebarNavKey } from '../../config/app-navigation'

export function isDashboardPath(pathname: string): boolean {
  const p = pathname || '/'
  return (
    p === '/' ||
    p === '/monitoring' ||
    p.startsWith('/monitoring/') ||
    p === '/runtime' ||
    p.startsWith('/runtime/')
  )
}

export function isAdministrationPath(pathname: string): boolean {
  const p = pathname || '/'
  return (
    p === '/admin' ||
    p.startsWith('/admin/') ||
    p.startsWith('/settings') ||
    p.startsWith('/operations/backup') ||
    p.startsWith('/validation')
  )
}

export function isNavKeyActive(pathname: string, key: SidebarNavKey): boolean {
  const p = pathname || '/'
  switch (key) {
    case 'dashboard':
      return isDashboardPath(p)
    case 'connectors':
      return p.startsWith('/connectors')
    case 'streams':
      return p.startsWith('/streams') || p.startsWith('/templates')
    case 'destinations':
      return p.startsWith('/destinations')
    case 'routes':
      return p.startsWith('/routes')
    case 'governance':
      return p === '/governance' || (p.startsWith('/governance/') && !p.startsWith('/governance/workspace'))
    case 'governanceWorkspace':
      return p.startsWith('/governance/workspace')
    case 'administration':
      return isAdministrationPath(p)
    default:
      return false
  }
}
