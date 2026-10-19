import { useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AdministrationHub, type AdministrationCoreTask, type AdministrationCoreGroupId } from '@datarelay-labs/system-admin-ui'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { isSessionExpired, onSessionChange, readSession, type SessionRole } from '../../auth/session'
import { PagePurposeHeader, type PageHelpContent } from '../ui/page-purpose-header'

type HubDestination = {
  title: string
  description: string
  path: string
  testId: string
}

type HubTaskGroup = {
  id: AdministrationCoreGroupId
  title: string
  description: string
  testId: string
  destinations: readonly HubDestination[]
}

const TASK_GROUPS: readonly HubTaskGroup[] = [
  {
    id: 'access-security',
    title: 'Access & security',
    description: 'TLS, platform accounts, and credential changes.',
    testId: 'admin-hub-group-access-security',
    destinations: [
      {
        title: 'HTTPS',
        description: 'TLS listener, certificate SANs, and HTTP-to-HTTPS redirect.',
        path: SETTINGS_SECTION_PATH.https,
        testId: 'admin-hub-https',
      },
      {
        title: 'User Management',
        description: 'Platform accounts, roles, and access status.',
        path: SETTINGS_SECTION_PATH.userManagement,
        testId: 'admin-hub-user-management',
      },
      {
        title: 'Password Management',
        description: 'Change operator passwords and credential policy.',
        path: SETTINGS_SECTION_PATH.passwordManagement,
        testId: 'admin-hub-password-management',
      },
    ],
  },
  {
    id: 'platform-network',
    title: 'Platform & network',
    description: 'Display timezone, published ports, and reverse-proxy apply workflow.',
    testId: 'admin-hub-group-platform-network',
    destinations: [
      {
        title: 'Display timezone',
        description: 'Effective display timezone, personal override, and platform default.',
        path: SETTINGS_SECTION_PATH.displayTimezone,
        testId: 'admin-hub-display-timezone',
      },
      {
        title: 'Network',
        description: 'Published HTTP/HTTPS ports and reverse-proxy apply workflow.',
        path: SETTINGS_SECTION_PATH.network,
        testId: 'admin-hub-network',
      },
    ],
  },
  {
    id: 'lifecycle-recovery',
    title: 'Lifecycle & recovery',
    description: 'Retention policy and portable workspace snapshots.',
    testId: 'admin-hub-group-lifecycle-recovery',
    destinations: [
      {
        title: 'Retention',
        description: 'Cleanup scheduler and per-category retention policy.',
        path: SETTINGS_SECTION_PATH.retention,
        testId: 'admin-hub-retention',
      },
      {
        title: 'Backup & Import',
        description: 'Export and import portable workspace configuration snapshots.',
        path: NAV_PATH.backup,
        testId: 'admin-hub-backup',
      },
    ],
  },
  {
    id: 'operations-audit',
    title: 'Operations & audit',
    description: 'Configuration history and operational health evidence.',
    testId: 'admin-hub-group-operations-audit',
    destinations: [
      {
        title: 'Audit',
        description: 'Platform audit trail and configuration change history.',
        path: SETTINGS_SECTION_PATH.audit,
        testId: 'admin-hub-audit',
      },
      {
        title: 'System Health',
        description: 'Operational health signals, maintenance readiness, and alerts.',
        path: SETTINGS_SECTION_PATH.systemHealth,
        testId: 'admin-hub-system-health',
      },
    ],
  },
] as const

const FOUNDATION_ADMIN_PATH = new Map(
  TASK_GROUPS.flatMap((group) => group.destinations.map((destination) => [destination.testId, destination.path] as const)),
)

const ADMINISTRATION_HELP: PageHelpContent = {
  docsHref: '/help/administration',
  title: 'Administration',
  intro: 'Administration is for platform access, security, network, lifecycle, recovery, and audit settings. Data-flow configuration stays with Connectors, Streams, Routes, and Destinations.',
  sections: [
    {
      title: 'What belongs here?',
      bullets: [
        'Access & security: HTTPS, platform users, and passwords.',
        'Platform & network: display timezone and published network settings.',
        'Lifecycle & recovery: retention and portable backup/import.',
        'Operations & audit: platform audit history and system health.',
      ],
    },
    {
      title: 'What does not belong here?',
      body: 'Do not configure source collection, Stream logic, Route Processing, or Destination delivery here. Those remain in the data-flow workspaces.',
    },
    {
      title: 'Before a high-risk change',
      body: 'Check the access-context banner first. Individual settings pages keep their existing confirmation, RBAC, and apply workflows.',
    },
  ],
}

// The JWT-backed platform session, not legacy UI role hints, drives link visibility.
// Product server route guards remain the authority for actual access.
function activeSessionRole(): SessionRole | null {
  const session = readSession()
  if (!session || isSessionExpired() || session.user.status !== 'ACTIVE' || session.user.must_change_password) {
    return null
  }
  return session.user.role
}

const READ_ONLY_TASKS = new Set(['admin-hub-audit', 'admin-hub-backup'])
const ADMIN_VIEW_TASKS = new Set(['admin-hub-audit', 'admin-hub-system-health'])

function canViewAdministration(role: SessionRole | null): boolean {
  return role === 'OPERATOR' || role === 'VIEWER' || role === 'CONNECTOR_OPERATOR'
}

function mayOpenAdministrationTask(role: SessionRole | null, taskId: string): boolean {
  return role === 'ADMINISTRATOR' || (canViewAdministration(role) && READ_ONLY_TASKS.has(taskId))
}

function foundationTasksForGroup(group: HubTaskGroup, role: SessionRole | null): readonly AdministrationCoreTask[] {
  const administrator = role === 'ADMINISTRATOR'
  return group.destinations
    .filter((destination) => mayOpenAdministrationTask(role, destination.testId))
    .map((destination) => ({
      id: destination.testId,
      label: destination.title,
      description: destination.description,
      groupId: group.id,
      target: { kind: 'path' as const, path: destination.path },
      access: administrator && !ADMIN_VIEW_TASKS.has(destination.testId)
        ? 'manage' as const
        : 'view' as const,
      availability: administrator && !ADMIN_VIEW_TASKS.has(destination.testId)
        ? 'supported' as const
        : 'read_only' as const,
    }))
}

function roleLabel(role: string | null): string {
  if (role === 'ADMINISTRATOR') return 'Administrator'
  if (role === 'OPERATOR') return 'Operator'
  if (role === 'VIEWER') return 'Viewer'
  return 'Unknown session'
}

function AccessContextBanner({ role }: { role: SessionRole | null }) {
  const readOnly = role === 'VIEWER'
  const operator = role === 'OPERATOR' || role === 'CONNECTOR_OPERATOR'

  if (readOnly) {
    return (
      <div
        role="status"
        data-testid="admin-hub-access-context"
        className="rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-4 py-3 text-sm text-sky-950 dark:border-sky-500/35 dark:bg-sky-500/10 dark:text-sky-100"
      >
        <p className="font-semibold">Viewer session — read-only.</p>
        <p className="mt-1 text-sm leading-relaxed opacity-90">
          Read-only Audit and Backup views remain available. Only Administrators can change Administration settings;
          the backend role guard rejects unauthorized changes.
        </p>
      </div>
    )
  }

  if (operator) {
    return (
      <div
        role="status"
        data-testid="admin-hub-access-context"
        className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
      >
        <p className="font-semibold">Operator session.</p>
        <p className="mt-1 text-sm leading-relaxed opacity-90">
          Admin and security settings (HTTPS, accounts, retention policy, alert settings) remain restricted to
          Administrators. Operational destinations stay available according to current product rules.
        </p>
      </div>
    )
  }

  return (
    <div
      role="status"
      data-testid="admin-hub-access-context"
      className="rounded-xl border border-slate-200/90 bg-slate-50/70 px-4 py-3 text-sm text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
    >
      <p className="font-semibold">Signed in as {roleLabel(role)}.</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
        Choose a task group below. High-risk changes still use the existing confirmation and apply workflows inside
        Settings.
      </p>
    </div>
  )
}

export function AdministrationHubPage() {
  const navigate = useNavigate()
  const role = useSyncExternalStore(onSessionChange, activeSessionRole, () => null)
  const canOpenSettings = role === 'ADMINISTRATOR'

  return (
    <div className="flex w-full min-w-0 flex-col gap-6" data-testid="administration-hub-page">
      <PagePurposeHeader
        title="Administration"
        showTitle={false}
        purpose="What needs configuring on this platform? Choose an Administration task for access, security, network, lifecycle, recovery, or audit; data-flow setup stays in its operational workspace."
        help={ADMINISTRATION_HELP}
        testId="administration-purpose-header"
        actions={canOpenSettings ? (
          <Link
            to={NAV_PATH.settings}
            data-testid="admin-hub-open-all-settings"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            Browse all settings
          </Link>
        ) : undefined}
      />

      <AccessContextBanner role={role} />

      <div className="flex flex-col gap-8" data-testid="admin-hub-task-groups">
        <AdministrationHub
          productId="datarelay-control"
          tasks={TASK_GROUPS.flatMap((group) => foundationTasksForGroup(group, role))}
          showHeader={false}
          onOpen={(task) => {
            if (!mayOpenAdministrationTask(activeSessionRole(), task.id)) return
            const path = FOUNDATION_ADMIN_PATH.get(task.id)
            if (task.target?.kind === 'path' && path === task.target.path) navigate(path)
          }}
        />
      </div>
    </div>
  )
}
