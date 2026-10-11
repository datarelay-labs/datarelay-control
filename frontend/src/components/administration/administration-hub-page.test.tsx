import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { persistSession, type SessionRole } from '../../auth/session'
import { AdministrationHubPage } from './administration-hub-page'

function signInAs(role: SessionRole) {
  persistSession({
    access_token: 'pf5b-unit-test',
    refresh_token: 'pf5b-unit-test',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    user: { username: 'pf5b-test-user', role, status: 'ACTIVE' },
  })
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-probe">{location.pathname}{location.search}{location.hash}</div>
}

function renderHub(initialPath = '/admin') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
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
    signInAs('ADMINISTRATOR')
  })

  it('shows SaaS hierarchy: purpose, access context, and task groups', () => {
    renderHub()
    expect(screen.getByTestId('administration-hub-page')).toBeInTheDocument()
    expect(screen.getByTestId('administration-purpose-header')).toHaveTextContent(/What needs configuring/i)
    expect(screen.getByTestId('admin-hub-access-context')).toBeInTheDocument()
    expect(screen.getByTestId('admin-hub-task-groups')).toBeInTheDocument()
    expect(screen.getByTestId('foundation-administration-hub')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Manage / })).toHaveLength(7)
    expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Access & security' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Platform & network' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lifecycle & recovery' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operations & audit' })).toBeInTheDocument()
  })

  it('preserves every Administration destination path through the single shared task catalog', async () => {
    const expected = [
      { title: 'HTTPS', path: SETTINGS_SECTION_PATH.https },
      { title: 'User Management', path: SETTINGS_SECTION_PATH.userManagement },
      { title: 'Password Management', path: SETTINGS_SECTION_PATH.passwordManagement },
      { title: 'Display timezone', path: SETTINGS_SECTION_PATH.displayTimezone },
      { title: 'Network', path: SETTINGS_SECTION_PATH.network },
      { title: 'Retention', path: SETTINGS_SECTION_PATH.retention },
      { title: 'Audit', path: SETTINGS_SECTION_PATH.audit },
      { title: 'Backup & Import', path: NAV_PATH.backup },
      { title: 'System Health', path: SETTINGS_SECTION_PATH.systemHealth },
    ] as const

    for (const item of expected) {
      const user = userEvent.setup()
      const view = renderHub()
      const card = screen.getByText(item.title).closest('.dr-card')
      expect(card).toBeTruthy()
      await user.click(within(card as HTMLElement).getByRole('button', {
        name: /^(Manage|View) /,
      }))
      expect(screen.getByTestId('location-probe')).toHaveTextContent(item.path)
      view.unmount()
    }
  })

  it('provides contextual help without duplicating the task catalog', async () => {
    const user = userEvent.setup()
    renderHub()
    await user.click(screen.getByRole('button', { name: 'Help' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(/Data-flow configuration stays/i)
    expect(screen.getAllByText('HTTPS')).toHaveLength(1)
  })

  it('frames Viewer sessions as read-only without inventing extra capabilities', () => {
    signInAs('VIEWER')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Viewer session — read-only/i)
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/backend role guard/i)
  })

  it('does not advertise forbidden Settings destinations to a Viewer', () => {
    signInAs('VIEWER')
    renderHub()
    expect(screen.queryByRole('button', { name: /^Manage / })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(2)
    expect(screen.queryByTestId('admin-hub-open-all-settings')).not.toBeInTheDocument()
    expect(screen.getByText('Audit')).toBeInTheDocument()
    expect(screen.getByText('Backup & Import')).toBeInTheDocument()
  })

  it('ignores an Administrator legacy role hint when no authenticated session exists', () => {
    localStorage.clear()
    localStorage.setItem('gdc_platform_ui_role', 'ADMINISTRATOR')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Unknown session/i)
    expect(screen.queryByRole('button', { name: /^Manage / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^View / })).not.toBeInTheDocument()
  })

  it('retains only supported Connector Operator view destinations', () => {
    signInAs('CONNECTOR_OPERATOR')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Operator session/i)
    expect(screen.queryByRole('button', { name: /^Manage / })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(2)
    expect(screen.queryByTestId('admin-hub-open-all-settings')).not.toBeInTheDocument()
  })

  it('frames Operator sessions with Administrator-restricted security settings truth', () => {
    signInAs('OPERATOR')
    renderHub()
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/Operator session/i)
    expect(screen.getByTestId('admin-hub-access-context')).toHaveTextContent(/restricted to Administrators/i)
  })

  it.each([
    ['ADMINISTRATOR', 7, 2],
    ['OPERATOR', 0, 2],
    ['VIEWER', 0, 2],
    ['CONNECTOR_OPERATOR', 0, 2],
  ] as const)('uses the authenticated %s role rather than a stale local role hint', (role, manageCount, viewCount) => {
    signInAs(role)
    localStorage.setItem('gdc_platform_ui_role', role === 'ADMINISTRATOR' ? 'VIEWER' : 'ADMINISTRATOR')
    renderHub()
    expect(screen.getAllByRole('button', { name: /^(Manage|View) / })).toHaveLength(manageCount + viewCount)
    expect(screen.queryAllByRole('button', { name: /^Manage / })).toHaveLength(manageCount)
    expect(screen.queryAllByRole('button', { name: /^View / })).toHaveLength(viewCount)
    expect(screen.getByTestId('foundation-administration-hub')).toBeInTheDocument()
    if (role === 'ADMINISTRATOR') {
      expect(screen.getByTestId('admin-hub-open-all-settings')).toBeInTheDocument()
    } else {
      expect(screen.queryByTestId('admin-hub-open-all-settings')).not.toBeInTheDocument()
    }
  })

  it.each(['OPERATOR', 'VIEWER', 'CONNECTOR_OPERATOR'] as const)(
    'opens only standalone Audit and Backup views for authenticated %s',
    async (role) => {
      signInAs(role)
      const user = userEvent.setup()
      for (const item of [
        { title: 'Audit', path: SETTINGS_SECTION_PATH.audit },
        { title: 'Backup & Import', path: NAV_PATH.backup },
      ]) {
        const view = renderHub()
        expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(2)
        expect(screen.queryByTestId('admin-hub-open-all-settings')).not.toBeInTheDocument()
        const card = screen.getByText(item.title).closest('.dr-card')
        expect(card).toBeTruthy()
        await user.click(within(card as HTMLElement).getByRole('button', { name: /^View / }))
        expect(screen.getByTestId('location-probe')).toHaveTextContent(item.path)
        view.unmount()
      }
    },
  )

  it('supports keyboard-accessible navigation to all settings', async () => {
    const user = userEvent.setup()
    renderHub()
    await user.tab()
    expect(screen.getByTestId('admin-hub-open-all-settings')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('settings-landing')).toBeInTheDocument()
  })
})
