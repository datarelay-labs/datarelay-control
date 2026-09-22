import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { AdministrationHubPage } from './administration-hub-page'

function renderHub(initialPath = '/admin') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/admin" element={<AdministrationHubPage />} />
        <Route path="/settings" element={<div data-testid="settings-landing">Settings</div>} />
        <Route path="/operations/backup" element={<div data-testid="backup-landing">Backup</div>} />
        <Route path="/settings/audit-logs" element={<div data-testid="audit-landing">Audit</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AdministrationHubPage modernization', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows SaaS hierarchy: purpose, access context, and task groups', () => {
    renderHub()
    expect(screen.getByTestId('administration-hub-page')).toBeInTheDocument()
    expect(screen.getByTestId('admin-hub-purpose')).toHaveTextContent(/What needs configuring/i)
    expect(screen.getByTestId('admin-hub-access-context')).toBeInTheDocument()
    expect(screen.getByTestId('admin-hub-task-groups')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Access & security' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Platform & network' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lifecycle & recovery' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operations & audit' })).toBeInTheDocument()
  })

  it('preserves every Administration destination path and accessible name', () => {
    renderHub()
    const expected = [
      { testId: 'admin-hub-https', path: SETTINGS_SECTION_PATH.https, name: 'Open HTTPS' },
      { testId: 'admin-hub-user-management', path: SETTINGS_SECTION_PATH.userManagement, name: 'Open User Management' },
      {
        testId: 'admin-hub-password-management',
        path: SETTINGS_SECTION_PATH.passwordManagement,
        name: 'Open Password Management',
      },
      {
        testId: 'admin-hub-display-timezone',
        path: SETTINGS_SECTION_PATH.displayTimezone,
        name: 'Open Display timezone',
      },
      { testId: 'admin-hub-network', path: SETTINGS_SECTION_PATH.network, name: 'Open Network' },
      { testId: 'admin-hub-retention', path: SETTINGS_SECTION_PATH.retention, name: 'Open Retention' },
      { testId: 'admin-hub-audit', path: SETTINGS_SECTION_PATH.audit, name: 'Open Audit' },
      { testId: 'admin-hub-backup', path: NAV_PATH.backup, name: 'Open Backup' },
      { testId: 'admin-hub-system-health', path: SETTINGS_SECTION_PATH.systemHealth, name: 'Open System Health' },
    ] as const

    for (const item of expected) {
      const link = screen.getByTestId(item.testId)
      expect(link).toHaveAttribute('href', item.path)
      expect(link).toHaveAccessibleName(item.name)
    }
  })

  it('frames Viewer sessions as read-only without inventing extra capabilities', () => {
    localStorage.setItem('gdc_platform_ui_role', 'VIEWER')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Viewer session — read-only/i)
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/backend role guard/i)
  })

  it('frames Operator sessions with Administrator-restricted security settings truth', () => {
    localStorage.setItem('gdc_platform_ui_role', 'OPERATOR')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Operator session/i)
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/restricted to Administrators/i)
  })

  it('supports keyboard-accessible navigation to all settings', async () => {
    const user = userEvent.setup()
    renderHub()
    await user.tab()
    expect(screen.getByTestId('admin-hub-open-all-settings')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('settings-landing')).toBeInTheDocument()
  })
})
