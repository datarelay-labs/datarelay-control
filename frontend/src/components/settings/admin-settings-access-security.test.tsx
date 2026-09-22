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
  postAdminPasswordChange,
  putAdminHttpsSettings,
  updateAdminUser,
} from '../../api/gdcAdmin'
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
  createAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  postAdminPasswordChange: vi.fn(),
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
      <h3 id="admin-retention-heading">Retention / cleanup policy</h3>
      <h3 id="admin-health-heading">Health monitoring</h3>
    </div>
  ),
}))

vi.mock('./admin-maintenance-center', () => ({
  AdminMaintenanceCenter: () => <h3>Maintenance Center</h3>,
}))

vi.mock('./admin-display-timezone-settings', () => ({
  AdminDisplayTimezoneSettings: () => <div>Display timezone</div>,
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

    await user.type(screen.getByLabelText('Current password'), 'old-secret')
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

  it('disables Access & security mutations for Viewer sessions', async () => {
    localStorage.setItem('gdc_platform_ui_role', 'VIEWER')
    vi.mocked(getAuthWhoAmI).mockResolvedValue({ role: 'VIEWER', username: 'viewer' } as never)

    renderPage()
    await screen.findByTestId('admin-settings-readonly-banner')

    expect(screen.getByTestId('admin-https-save')).toBeDisabled()
    expect(screen.getByTestId('admin-password-submit')).toBeDisabled()
    expect(screen.getByTestId('admin-users-create')).toBeDisabled()
    expect(screen.getByLabelText('Enable HTTPS')).toBeDisabled()
  })
})
