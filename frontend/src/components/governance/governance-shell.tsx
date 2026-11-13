import { NavLink, Outlet } from 'react-router-dom'
import { NAV_PATH } from '../../config/nav-paths'
import { isOssReleaseMode } from '../../lib/feature-flags'
import {
  canViewAudit,
  canViewGovernance,
  canViewGovernanceOperations,
  canViewGovernanceWorkspace,
  governanceReadOnlyReason,
} from '../../lib/governance-rbac'
import { semanticCn } from '../ui/semantic-cn'
import { PersonaReadOnlyBanner } from './persona-read-only-banner'

const TABS: readonly { to: string; end?: boolean; label: string; testId: string; visible?: () => boolean }[] = [
  { to: NAV_PATH.governance, end: true, label: 'Dashboard', testId: 'governance-nav-dashboard' },
  { to: NAV_PATH.governanceOperations, label: 'Operations', testId: 'governance-nav-operations', visible: canViewGovernanceOperations },
  { to: NAV_PATH.governanceDataProtection, label: 'Data Protection', testId: 'governance-nav-data-protection', visible: canViewGovernanceWorkspace },
  { to: NAV_PATH.governanceViolations, label: 'Violations', testId: 'governance-nav-violations', visible: canViewGovernanceWorkspace },
  { to: NAV_PATH.governanceQuarantine, label: 'Quarantine', testId: 'governance-nav-quarantine', visible: canViewGovernanceWorkspace },
  { to: NAV_PATH.governanceAudit, label: 'Audit', testId: 'governance-nav-audit', visible: canViewAudit },
  { to: NAV_PATH.governanceReplay, label: 'Replay', testId: 'governance-nav-replay', visible: canViewGovernanceWorkspace },
  { to: NAV_PATH.governanceApprovals, label: 'Approvals', testId: 'governance-nav-approvals', visible: canViewGovernanceWorkspace },
  { to: NAV_PATH.governanceNotifications, label: 'Notifications', testId: 'governance-nav-notifications', visible: canViewGovernanceWorkspace },
] as const

export function GovernanceShell() {
  if (!canViewGovernance()) {
    const reason = governanceReadOnlyReason() ?? 'Governance access requires an authorized role.'
    return (
      <section
        className="rounded-lg border border-status-warning-border bg-status-warning-subtle p-6 text-body text-status-warning"
        data-testid="governance-unauthorized"
        role="alert"
      >
        <h2 className="text-title">Governance access unavailable</h2>
        <p className="mt-2">{reason}</p>
      </section>
    )
  }

  const visibleTabs = TABS.filter((t) => {
    if (isOssReleaseMode()) {
      if (t.to === NAV_PATH.governanceDataProtection) return false
    }
    return t.visible ? t.visible() : true
  })

  return (
    <div className="w-full min-w-0 space-y-4" data-testid="governance-shell">
      <PersonaReadOnlyBanner />
      <nav
        className="flex flex-wrap gap-x-1 border-b border-default"
        aria-label="Governance sections"
      >
        {visibleTabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            data-testid={t.testId}
            className={({ isActive }) =>
              semanticCn(
                '-mb-px inline-flex h-control-md items-center whitespace-nowrap border-b-2 px-3 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
                isActive
                  ? 'border-accent text-fg'
                  : 'border-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  )
}
