import { Link, useNavigate } from 'react-router-dom'
import { AdministrationHub, createStandardAdministrationTasks, type StandardAdministrationTaskBindings } from '@datarelay-labs/foundation'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { isAdminUiOperator, isAdminUiReadOnly, readAdminUiRole } from '../../lib/gdc-ui-tokens'
import { PagePurposeHeader, type PageHelpContent } from '../ui/page-purpose-header'

// Only Control's real destination paths and authenticated capabilities are product-owned.
// Foundation owns the common task labels, descriptions, ordering and four-group layout.
function controlAdministrationBindings(): StandardAdministrationTaskBindings {
  const role = readAdminUiRole()
  const authenticated = role === 'ADMINISTRATOR' || role === 'OPERATOR' || role === 'VIEWER' || role === 'CONNECTOR_OPERATOR'
  const administrator = role === 'ADMINISTRATOR'
  const access = administrator ? 'manage' : authenticated ? 'view' : 'none'
  const readAccess = authenticated ? 'view' : 'none'
  return {
    'core.https': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.https },
    },
    'core.users': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.userManagement },
    },
    'core.password': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.passwordManagement },
    },
    'core.timezone': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.displayTimezone },
    },
    'core.network': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.network },
      effects: ['reconnect_required'],
    },
    'core.retention': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.retention },
    },
    'core.backup-import': {
      availability: 'supported',
      access,
      target: { kind: 'path', path: NAV_PATH.backup },
    },
    'core.audit': {
      availability: 'read_only',
      access: readAccess,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.audit },
    },
    'core.health': {
      availability: 'read_only',
      access: readAccess,
      target: { kind: 'path', path: SETTINGS_SECTION_PATH.systemHealth },
    },
  }
}

const ADMINISTRATION_HELP: PageHelpContent = {
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

function roleLabel(role: string | null): string {
  if (role === 'ADMINISTRATOR') return 'Administrator'
  if (role === 'OPERATOR') return 'Operator'
  if (role === 'CONNECTOR_OPERATOR') return 'Connector Operator'
  if (role === 'VIEWER') return 'Viewer'
  return 'Unknown session'
}

function AccessContextBanner() {
  const role = readAdminUiRole()
  const readOnly = isAdminUiReadOnly()
  const operator = isAdminUiOperator() || role === 'CONNECTOR_OPERATOR'

  if (readOnly) {
    return (
      <div
        role="status"
        data-testid="admin-hub-access-context"
        className="rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-4 py-3 text-sm text-sky-950 dark:border-sky-500/35 dark:bg-sky-500/10 dark:text-sky-100"
      >
        <p className="font-semibold">Viewer session — read-only.</p>
        <p className="mt-1 text-sm leading-relaxed opacity-90">
          Mutating Administration actions stay disabled in the UI and are rejected by the backend role guard. Sign in as
          Operator or Administrator to make changes.
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

  return (
    <div className="flex w-full min-w-0 flex-col gap-6" data-testid="administration-hub-page">
      <PagePurposeHeader
        title="Administration"
        showTitle={false}
        purpose="What needs configuring on this platform? Choose an Administration task for access, security, network, lifecycle, recovery, or audit; data-flow setup stays in its operational workspace."
        help={ADMINISTRATION_HELP}
        testId="administration-purpose-header"
        actions={
          <Link
            to={NAV_PATH.settings}
            data-testid="admin-hub-open-all-settings"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            Browse all settings
          </Link>
        }
      />

      <AccessContextBanner />

      <div data-testid="admin-hub-task-groups">
        <AdministrationHub
          productId="control"
          tasks={createStandardAdministrationTasks(controlAdministrationBindings())}
          onOpen={(task) => {
            if (task.target?.kind === 'path') navigate(task.target.path)
          }}
        />
      </div>
    </div>
  )
}
