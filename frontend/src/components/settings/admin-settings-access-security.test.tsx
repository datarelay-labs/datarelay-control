import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAdminUser,
  deleteAdminUser,
  getAdminHttpsSettings,
  getAuthWhoAmI,
  listAdminUsers,
  postAdminUserMfaReset,
  postAdminPasswordChange,
  postAuthChangePassword,
  putAdminHttpsSettings,
  updateAdminUser,
} from '../../api/gdcAdmin'
import { persistSession, type SessionRole } from '../../auth/session'
import { clearAdminSettingsSnapshot } from './admin-settings-session-cache'
import { AdminSettingsPage } from './admin-settings-page'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminHttpsSettings: vi.fn(),
  listAdminUsers: vi.fn(),
  getAdminSystemInfo: vi.fn(async () => ({
    app_env: 'test',
    app_version: '0.0.0',
    app_name: 'gdc',
    python_version: '3.12',
    database_reachable: true,
    database_url_masked: 'postgres://***',
    platform: 'linux',
    uptime_seconds: 10,
    database_version: 'PostgreSQL',
    timezone: 'UTC',
    server_time_utc: '2026-01-01T00:00:00Z',
  })),
  getAuthWhoAmI: vi.fn(async () => ({ role: 'ADMINISTRATOR', username: 'admin' })),
  getAuthMfaStatus: vi.fn(async () => ({ enabled: false })),
  createAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  postAdminUserMfaReset: vi.fn(),
  postAdminPasswordChange: vi.fn(),
  postAuthChangePassword: vi.fn(),
  putAdminHttpsSettings: vi.fn(),
  downloadAdminSupportBundle: vi.fn(),
}))

vi.mock('./admin-network-settings-page', () => ({
  AdminNetworkSettingsPage: () => (
    <section aria-labelledby="admin-network-heading">
      <h2 id="admin-network-heading">Network / Reverse Proxy Settings</h2>
    </section>
  ),
}))

vi.mock('./admin-settings-operational', () => ({
  AdminOperationalDashboard: () => (
    <div>
      <h3 id="admin-health-heading">Health monitoring</h3>
    </div>
  ),
}))

vi.mock('./admin-retention-settings', () => ({
  AdminRetentionSettings: () => (
    <section aria-labelledby="admin-retention-heading">
      <h3 id="admin-retention-heading">Retention / cleanup</h3>
    </section>
  ),
}))

vi.mock('./admin-maintenance-center', () => ({
  AdminMaintenanceCenter: () => <h3>Maintenance Center</h3>,
}))

vi.mock('./admin-display-timezone-settings', () => ({
  AdminDisplayTimezoneSettings: () => (
    <section aria-labelledby="admin-display-timezone-heading">
      <h3 id="admin-display-timezone-heading">Display timezone</h3>
    </section>
  ),
}))

vi.mock('./admin-dev-validation-panel', () => ({
  AdminDevValidationPanel: () => null,
}))

vi.mock('../../lib/feature-flags', () => ({
  isDevValidationLabUiEnabled: () => false,
}))

const httpsFixture = {
  enabled: false,
  certificate_ip_addresses: [] as string[],
  certificate_dns_names: [] as string[],
  redirect_http_to_https: false,
  certificate_valid_days: 365,
  current_access_url: 'http://localhost/',
  https_active: false,
  certificate_not_after: null,
  restart_required_after_save: false,
  http_listener_active: true,
  https_listener_active: false,
  redirect_http_to_https_effective: false,
  proxy_status: 'ok' as const,
  proxy_health_ok: true,
  proxy_last_reload_at: null,
  proxy_last_reload_ok: true,
  proxy_last_reload_detail: null,
  proxy_fallback_to_http_last: false,
  browser_http_url: 'http://localhost/',
  browser_https_url: null,
}

const usersFixture = [
  {
    id: 1,
    username: 'admin',
    role: 'ADMINISTRATOR',
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 2,
    username: 'ops',
    role: 'OPERATOR',
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    last_login_at: null,
  },
]

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminSettingsPage />
    </MemoryRouter>,
  )
}

describe('AdminSettingsPage Access & security modernization', () => {
  beforeEach(() => {
    clearAdminSettingsSnapshot()
    localStorage.clear()
    localStorage.setItem('gdc_platform_ui_role', 'ADMINISTRATOR')
    vi.mocked(getAdminHttpsSettings).mockResolvedValue(httpsFixture)
    vi.mocked(listAdminUsers).mockResolvedValue(usersFixture)
    vi.mocked(putAdminHttpsSettings).mockResolvedValue({
      ok: true,
      restart_required: false,
      certificate_not_after: null,
      message: 'HTTPS settings saved.',
      proxy_reload_applied: true,
      proxy_https_effective: false,
      proxy_fallback_to_http: false,
    })
    vi.mocked(postAdminPasswordChange).mockResolvedValue(undefined)
    vi.mocked(postAuthChangePassword).mockReset()
    vi.mocked(postAuthChangePassword).mockResolvedValue({ ok: true, message: 'Password updated.' })
    vi.mocked(postAdminPasswordChange).mockClear()
    vi.mocked(postAdminUserMfaReset).mockReset()
    vi.mocked(postAdminUserMfaReset).mockResolvedValue(undefined)
    vi.mocked(createAdminUser).mockResolvedValue({
      id: 3,
      username: 'viewer1',
      role: 'VIEWER',
      status: 'ACTIVE',
      created_at: '2026-01-03T00:00:00Z',
      last_login_at: null,
    })
    vi.mocked(updateAdminUser).mockImplementation(async (_id, body) => ({
      ...usersFixture[1],
      ...body,
      role: body.role ?? usersFixture[1].role,
      status: body.status ?? usersFixture[1].status,
    }))
    vi.mocked(deleteAdminUser).mockResolvedValue(undefined)
  })

  it('renders current-state → configuration → safeguards hierarchy for HTTPS', async () => {
    renderPage()

    expect(await screen.findByTestId('admin-https-panel')).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-current-state')).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-configuration')).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-safeguards')).toHaveTextContent(/At least one IP or DNS SAN/i)
    expect(screen.getByTestId('admin-https-status-badge')).toHaveTextContent('HTTP only')
    expect(screen.getByLabelText('Current access URL')).toHaveValue('http://localhost/')
    expect(screen.getByLabelText('Enable HTTPS')).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-save')).toBeDisabled()
  })

  it('preserves HTTPS save payload semantics', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('admin-https-panel')

    await user.click(screen.getByLabelText('Enable HTTPS'))
    await user.clear(screen.getByLabelText('Certificate IP addresses (SAN)'))
    await user.type(screen.getByLabelText('Certificate IP addresses (SAN)'), '10.0.0.5')
    await user.click(screen.getByLabelText('Redirect HTTP to HTTPS'))

    expect(screen.getByTestId('admin-https-save')).toBeEnabled()
    await user.click(screen.getByTestId('admin-https-save'))

    await waitFor(() => {
      expect(putAdminHttpsSettings).toHaveBeenCalledWith({
        enabled: true,
        certificate_ip_addresses: ['10.0.0.5'],
        certificate_dns_names: [],
        redirect_http_to_https: true,
        certificate_valid_days: 365,
        regenerate_certificate: true,
      })
    })
  })

  it('keeps password validation and submit hierarchy', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('admin-password-panel')

    expect(screen.getByRole('heading', { name: 'Password Management' })).toBeInTheDocument()
    expect(screen.getByLabelText('Target account username')).toHaveValue('admin')

    await user.clear(screen.getByLabelText('New password'))
    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    await user.click(screen.getByTestId('admin-password-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8 characters/i)
    expect(postAdminPasswordChange).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('New password'))
    await user.type(screen.getByLabelText('New password'), 'long-enough')
    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('Confirm new password'), 'mismatch!!')
    await user.click(screen.getByTestId('admin-password-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i)
    expect(postAdminPasswordChange).not.toHaveBeenCalled()

    await user.type(within(screen.getByTestId('admin-password-panel')).getByLabelText('Current password'), 'old-secret')
    await user.clear(screen.getByLabelText('New password'))
    await user.type(screen.getByLabelText('New password'), 'long-enough')
    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('Confirm new password'), 'long-enough')
    await user.click(screen.getByTestId('admin-password-submit'))

    await waitFor(() => {
      expect(postAdminPasswordChange).toHaveBeenCalledWith({
        username: 'admin',
        current_password: 'old-secret',
        new_password: 'long-enough',
        confirm_password: 'long-enough',
      })
    })
  })

  it('does not expose localStorage testing instructions in product UI', async () => {
    renderPage()
    await screen.findByTestId('admin-users-panel')

    expect(screen.getByTestId('admin-users-role-note')).toHaveTextContent(/Viewer sessions remain read-only/i)
    expect(screen.queryByText(/localStorage/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/gdc_platform_ui_role/i)).not.toBeInTheDocument()
  })

  it('preserves last-active-administrator protection and row actions', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId('admin-users-table')

    const adminRow = screen.getByTestId('admin-user-row-admin')
    expect(within(adminRow).queryByRole('button', { name: /Edit user admin/i })).not.toBeInTheDocument()
    expect(within(adminRow).getByText('Protected')).toBeInTheDocument()

    const opsRow = screen.getByTestId('admin-user-row-ops')
    expect(within(opsRow).getByRole('button', { name: /Edit user ops/i })).toBeInTheDocument()
    expect(within(opsRow).getByRole('button', { name: /Delete user ops/i })).toBeInTheDocument()

    await user.click(within(opsRow).getByRole('button', { name: /Edit user ops/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Username')).toBeDisabled()
  })

  it('protects an enrolled account MFA reset with typed target and administrator password', async () => {
    const user = userEvent.setup()
    vi.mocked(listAdminUsers).mockResolvedValue([
      usersFixture[0], { ...usersFixture[1], mfa_enabled: true },
    ])
    renderPage()
    const row = await screen.findByTestId('admin-user-row-ops')
    await user.click(within(row).getByRole('button', { name: 'Reset MFA for ops' }))
    const dialog = await screen.findByTestId('admin-mfa-reset-dialog')
    expect(dialog).toHaveTextContent('invalidates its existing sessions and recovery codes')
    const submit = within(dialog).getByRole('button', { name: 'Reset MFA and revoke sessions' })
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Current Administrator password'), 'actual-admin-password')
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText('Type the exact username to confirm'), 'ops')
    expect(submit).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('admin-mfa-reset-dialog')).not.toBeInTheDocument()
    expect(postAdminUserMfaReset).not.toHaveBeenCalled()

    await user.click(within(row).getByRole('button', { name: 'Reset MFA for ops' }))
    const confirmed = screen.getByTestId('admin-mfa-reset-dialog')
    await user.type(within(confirmed).getByLabelText('Type the exact username to confirm'), 'ops')
    await user.type(within(confirmed).getByLabelText('Current Administrator password'), 'actual-admin-password')
    await user.click(within(confirmed).getByRole('button', { name: 'Reset MFA and revoke sessions' }))
    await waitFor(() => {
      expect(postAdminUserMfaReset).toHaveBeenCalledWith(2, {
        confirm_username: 'ops',
        current_password: 'actual-admin-password',
      })
    })
    await waitFor(() => {
      expect(screen.queryByTestId('admin-mfa-reset-dialog')).not.toBeInTheDocument()
    })
  })

  it('does not expose MFA reset to an Operator even when another account has MFA enabled', async () => {
    vi.mocked(listAdminUsers).mockResolvedValue([
      usersFixture[0], { ...usersFixture[1], mfa_enabled: true },
    ])
    localStorage.setItem('gdc_platform_ui_role', 'OPERATOR')
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role: 'OPERATOR', username: 'ops' } as never)
    renderPage()
    const row = await screen.findByTestId('admin-user-row-ops')
    expect(within(row).queryByRole('button', { name: 'Reset MFA for ops' })).not.toBeInTheDocument()
    expect(postAdminUserMfaReset).not.toHaveBeenCalled()
  })

  it('blocks local account mutations for Operator sessions', async () => {
    localStorage.setItem('gdc_platform_ui_role', 'OPERATOR')
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role: 'OPERATOR', username: 'ops' } as never)

    renderPage()
    await screen.findByTestId('admin-settings-operator-banner')
    await screen.findByTestId('admin-users-table')

    expect(screen.getByTestId('admin-users-create')).toBeDisabled()
    // F-202: changing your own password stays available to every role.
    expect(screen.getByTestId('admin-password-submit')).toBeEnabled()
    const opsRow = screen.getByTestId('admin-user-row-ops')
    expect(within(opsRow).queryByRole('button', { name: /Edit user ops/i })).not.toBeInTheDocument()
    expect(within(opsRow).queryByRole('button', { name: /Delete user ops/i })).not.toBeInTheDocument()
    expect(within(opsRow).getByText('Administrator only')).toBeInTheDocument()
  })

  it.each([
    'CONNECTOR_OPERATOR',
    'GOVERNANCE_OPERATOR',
    'GOVERNANCE_REVIEWER',
    'GOVERNANCE_APPROVER',
    'GOVERNANCE_AUDITOR',
  ] as SessionRole[])('blocks account-admin mutations for %s sessions', async (role) => {
    persistSession({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'specialized-user', role, status: 'ACTIVE' },
    })
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role, username: 'specialized-user' } as never)

    renderPage()
    await screen.findByTestId('admin-users-table')

    expect(screen.getByTestId('admin-users-create')).toBeDisabled()
    expect(screen.getByTestId('admin-password-submit')).toBeEnabled()
    const opsRow = screen.getByTestId('admin-user-row-ops')
    expect(within(opsRow).queryByRole('button', { name: /Edit user ops/i })).not.toBeInTheDocument()
    expect(within(opsRow).queryByRole('button', { name: /Delete user ops/i })).not.toBeInTheDocument()
  })

  it('disables Access & security mutations for Viewer sessions', async () => {
    localStorage.setItem('gdc_platform_ui_role', 'VIEWER')
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role: 'VIEWER', username: 'viewer' } as never)

    renderPage()
    await screen.findByTestId('admin-settings-readonly-banner')

    expect(screen.getByTestId('admin-https-save')).toBeDisabled()
    expect(screen.getByTestId('admin-password-submit')).toBeEnabled()
    expect(screen.getByTestId('admin-users-create')).toBeDisabled()
    expect(await screen.findByLabelText('Enable HTTPS')).toBeDisabled()
  })

  it('shows Governance-only roles why the Administration surface is disabled instead of a raw 403 (F-195)', async () => {
    persistSession({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'gov-user', role: 'GOVERNANCE_OPERATOR', status: 'ACTIVE' },
    })
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role: 'GOVERNANCE_OPERATOR', username: 'gov-user' } as never)
    vi.mocked(getAdminHttpsSettings).mockRejectedValue(new Error('403: [ROLE_FORBIDDEN] This endpoint requires the Administrator role.'))
    vi.mocked(listAdminUsers).mockRejectedValue(new Error('403: [ROLE_FORBIDDEN] This endpoint requires the Administrator role.'))

    renderPage()

    expect(await screen.findByTestId('admin-settings-governance-role-banner')).toHaveTextContent(/only use Governance pages/i)
    expect(await screen.findByText(/visible to Administrators only, so your role cannot view them/i)).toBeInTheDocument()
    expect(screen.queryByText(/Could not load admin settings: 403/i)).not.toBeInTheDocument()
    expect(await screen.findByTestId('admin-https-unavailable')).toHaveTextContent(/Administrators only/i)
    expect(screen.getByTestId('admin-users-empty')).toHaveTextContent(/visible to Administrators only/i)
    expect(screen.queryByText(/Create a local account/i)).not.toBeInTheDocument()
  })

  describe('self-service password change for every role (F-202)', () => {
    const NON_ADMIN_ROLES = [
      'OPERATOR',
      'CONNECTOR_OPERATOR',
      'VIEWER',
      'GOVERNANCE_OPERATOR',
      'GOVERNANCE_REVIEWER',
      'GOVERNANCE_APPROVER',
      'GOVERNANCE_AUDITOR',
    ] as SessionRole[]

    function signInAs(role: SessionRole, username: string) {
      persistSession({
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        user: { username, role, status: 'ACTIVE' },
      })
      vi.mocked(getAuthWhoAmI).mockResolvedValue({ role, username } as never)
    }

    async function fillPasswordForm(user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm: string) {
      const panel = within(await screen.findByTestId('admin-password-panel'))
      await user.type(panel.getByLabelText('Current password'), current)
      await user.type(panel.getByLabelText('New password'), next)
      await user.type(panel.getByLabelText('Confirm new password'), confirm)
    }

    it.each(NON_ADMIN_ROLES)('lets %s change its own password through the self-service endpoint', async (role) => {
      const user = userEvent.setup()
      signInAs(role, 'self-user')
      renderPage()

      const panel = within(await screen.findByTestId('admin-password-panel'))
      const target = panel.getByLabelText('Target account username')
      expect(target).toHaveValue('self-user')
      expect(target).toBeDisabled()
      expect(panel.getByLabelText('Current password')).toBeEnabled()
      expect(panel.getByLabelText('New password')).toBeEnabled()

      await fillPasswordForm(user, 'old-secret', 'long-enough', 'long-enough')
      await user.click(screen.getByTestId('admin-password-submit'))

      await waitFor(() => {
        expect(postAuthChangePassword).toHaveBeenCalledWith({
          current_password: 'old-secret',
          new_password: 'long-enough',
          confirm_new_password: 'long-enough',
        })
      })
      expect(postAdminPasswordChange).not.toHaveBeenCalled()
      expect(await screen.findByText(/Sign in again with your new password/i)).toBeInTheDocument()
      // The API revoked every session of this account, so the browser session ends with a hint for sign-in.
      expect(localStorage.getItem('gdc_platform_session_v1')).toBeNull()
      expect(sessionStorage.getItem('gdc_post_password_change')).toBe('1')
    })

    it('keeps client-side validation for the self-service path and sends nothing', async () => {
      const user = userEvent.setup()
      signInAs('VIEWER', 'viewer-user')
      renderPage()

      await fillPasswordForm(user, 'old-secret', 'short', 'short')
      await user.click(screen.getByTestId('admin-password-submit'))
      expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8 characters/i)

      await user.clear(screen.getByLabelText('New password'))
      await user.type(screen.getByLabelText('New password'), 'long-enough')
      await user.clear(screen.getByLabelText('Confirm new password'))
      await user.type(screen.getByLabelText('Confirm new password'), 'mismatch!!')
      await user.click(screen.getByTestId('admin-password-submit'))
      expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i)

      expect(postAuthChangePassword).not.toHaveBeenCalled()
      expect(postAdminPasswordChange).not.toHaveBeenCalled()
    })

    it('shows the server error and keeps the session when the current password is wrong', async () => {
      const user = userEvent.setup()
      signInAs('OPERATOR', 'ops-user')
      vi.mocked(postAuthChangePassword).mockRejectedValue(
        new Error('400: [USER_AUTH_FAILED] Current password is incorrect.'),
      )
      renderPage()

      await fillPasswordForm(user, 'wrong-secret', 'long-enough', 'long-enough')
      await user.click(screen.getByTestId('admin-password-submit'))

      expect(await screen.findByRole('alert')).toHaveTextContent(/Current password is incorrect/i)
      expect(localStorage.getItem('gdc_platform_session_v1')).not.toBeNull()
    })

    it('defaults an administrator\'s target to the signed-in account and keeps the admin endpoint', async () => {
      const user = userEvent.setup()
      signInAs('ADMINISTRATOR', 'second-admin')
      renderPage()

      const target = within(await screen.findByTestId('admin-password-panel')).getByLabelText(
        'Target account username',
      )
      expect(target).toHaveValue('second-admin')
      expect(target).toBeEnabled()

      await fillPasswordForm(user, 'old-secret', 'long-enough', 'long-enough')
      await user.click(screen.getByTestId('admin-password-submit'))

      await waitFor(() => {
        expect(postAdminPasswordChange).toHaveBeenCalledWith({
          username: 'second-admin',
          current_password: 'old-secret',
          new_password: 'long-enough',
          confirm_password: 'long-enough',
        })
      })
      expect(postAuthChangePassword).not.toHaveBeenCalled()
    })
  })
})
