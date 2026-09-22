import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminSettingsPage } from './admin-settings-page'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminHttpsSettings: vi.fn(async () => ({
    enabled: false,
    certificate_ip_addresses: [],
    certificate_dns_names: [],
    redirect_http_to_https: false,
    certificate_valid_days: 365,
    https_listener_active: false,
  })),
  listAdminUsers: vi.fn(async () => []),
  getAdminSystemInfo: vi.fn(async () => ({
    app_env: 'test',
    app_version: '0.0.0',
    uptime_seconds: 10,
    database_reachable: true,
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
      <h3>Audit log</h3>
      <h3>Config versioning</h3>
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

describe('AdminSettingsPage IA modernization', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('gdc_platform_ui_role', 'ADMINISTRATOR')
  })

  it('shows purpose, section hierarchy, and hub return link', async () => {
    render(
      <MemoryRouter>
        <AdminSettingsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('admin-settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('admin-settings-purpose')).toHaveTextContent(/Review access and operational context/i)
    expect(screen.getByTestId('admin-settings-back-to-hub')).toHaveAttribute('href', '/admin')
    expect(screen.getByTestId('admin-settings-section-nav')).toBeInTheDocument()
    expect(screen.getByTestId('admin-settings-group-access')).toBeInTheDocument()
    expect(screen.getByTestId('admin-settings-group-platform')).toBeInTheDocument()
    expect(screen.getByTestId('admin-settings-group-lifecycle')).toBeInTheDocument()
    expect(screen.getByTestId('admin-settings-group-operations')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'HTTPS / Security' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Password Management' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'User Management' })).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-current-state')).toBeInTheDocument()
    expect(screen.getByTestId('admin-https-configuration')).toBeInTheDocument()
    expect(screen.queryByText(/localStorage/i)).not.toBeInTheDocument()
  })

  it('preserves Viewer read-only framing', async () => {
    localStorage.setItem('gdc_platform_ui_role', 'VIEWER')
    render(
      <MemoryRouter>
        <AdminSettingsPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('admin-settings-readonly-banner')).toHaveTextContent(/Read-only Viewer session/i)
  })
})
