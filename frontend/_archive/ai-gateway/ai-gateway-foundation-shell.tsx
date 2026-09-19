import { NavLink, Outlet } from 'react-router-dom'
import { NAV_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'

const TABS: readonly { to: string; end?: boolean; label: string; testId: string }[] = [
  { to: NAV_PATH.aiGatewayTraffic, end: true, label: 'Traffic', testId: 'ai-gateway-nav-traffic' },
  { to: NAV_PATH.aiGatewayStreams, label: 'AI Streams', testId: 'ai-gateway-nav-streams' },
  { to: NAV_PATH.aiGatewayProviders, label: 'Providers', testId: 'ai-gateway-nav-providers' },
  { to: NAV_PATH.aiGatewayGovernance, label: 'Governance', testId: 'ai-gateway-nav-governance' },
]

export function AiGatewayFoundationShell() {
  return (
    <div className="w-full min-w-0 space-y-4" data-testid="ai-gateway-foundation-shell">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">AI Gateway</p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">Traffic control for AI providers</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
          Monitor AI traffic first, then manage AI streams and provider credentials.
        </p>
      </header>
      <nav
        className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-gdc-border"
        aria-label="AI Gateway sections"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            data-testid={tab.testId}
            className={({ isActive }) =>
              cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-gdc-buttonPrimary text-white shadow-sm dark:bg-gdc-buttonPrimary'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
