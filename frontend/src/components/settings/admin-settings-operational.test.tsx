import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAdminAlertHistory,
  getAdminAlertSettings,
  getAdminAuditLog,
  getAdminConfigVersions,
  getAdminHealthSummary,
} from '../../api/gdcAdmin'
import { isPlatformAlertingUiEnabled } from '../../lib/feature-flags'
import { AdminOperationalDashboard } from './admin-settings-operational'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminAuditLog: vi.fn(),
  getAdminConfigVersions: vi.fn(),
  getAdminHealthSummary: vi.fn(),
  getAdminAlertSettings: vi.fn(),
  getAdminAlertHistory: vi.fn(),
  postAdminAlertTest: vi.fn(),
  putAdminAlertSettings: vi.fn(),
}))

vi.mock('../../lib/feature-flags', () => ({
  isPlatformAlertingUiEnabled: vi.fn(() => false),
}))

const auditFixture = {
  total: 12,
  items: [
    {
      id: 1,
      created_at: '2026-09-23T12:00:00Z',
      actor_username: 'admin',
      action: 'user.update',
      entity_type: 'user',
      entity_id: 2,
      entity_name: null,
      details: { role: 'OPERATOR' },
    },
  ],
}

const versionsFixture = {
  total: 4,
  items: [
    {
      id: 9,
      version: 3,
      entity_type: 'stream',
      entity_id: 1,
      entity_name: 'main',
      changed_by: 'admin',
      changed_at: '2026-09-23T11:00:00Z',
      summary: null,
    },
  ],
}

const healthFixture = {
  metrics_window_seconds: 3600,
  metrics: [
    {
      key: 'delivery_success',
      label: 'Delivery success',
      available: true,
      value: '99%',
      status: 'good' as const,
      notes: null,
      link_path: '/runtime',
    },
    {
      key: 'queue_depth',
      label: 'Queue depth',
      available: true,
      value: '120',
      status: 'medium' as const,
      notes: 'Elevated',
      link_path: '/runtime',
    },
    {
      key: 'error_rate',
      label: 'Error rate',
      available: true,
      value: '8%',
      status: 'bad' as const,
      notes: 'Investigate',
      link_path: null,
    },
  ],
}

describe('AdminOperationalDashboard operations workspace', () => {
  const setBusy = vi.fn()
  const setPageMsg = vi.fn()
  const setPageErr = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isPlatformAlertingUiEnabled).mockReturnValue(false)
    vi.mocked(getAdminAuditLog).mockResolvedValue(auditFixture)
    vi.mocked(getAdminConfigVersions).mockResolvedValue(versionsFixture)
    vi.mocked(getAdminHealthSummary).mockResolvedValue(healthFixture)
    vi.mocked(getAdminAlertSettings).mockResolvedValue({
      rules: [],
      webhook_url: null,
      slack_webhook_url: null,
      email_to: null,
      channel_status: {},
      notification_delivery: {},
      cooldown_seconds: 600,
      monitor_enabled: false,
    })
    vi.mocked(getAdminAlertHistory).mockResolvedValue({ total: 0, items: [] })
  })

  function renderDash(readOnly = false) {
    return render(
      <MemoryRouter>
        <AdminOperationalDashboard
          reloadToken={0}
          readOnly={readOnly}
          busy={false}
          setBusy={setBusy}
          setPageMsg={setPageMsg}
          setPageErr={setPageErr}
        />
      </MemoryRouter>,
    )
  }

  it('renders audit/config current-state hierarchy with progressive evidence', async () => {
    const user = userEvent.setup()
    renderDash()

    expect(await screen.findByTestId('admin-evidence-current-state')).toHaveTextContent(/12/)
    expect(screen.getByTestId('admin-evidence-current-state')).toHaveTextContent(/4/)
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Config versioning' })).toBeInTheDocument()
    expect(screen.queryByTestId('admin-audit-evidence-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-config-evidence-body')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('admin-audit-evidence-toggle'))
    expect(screen.getByTestId('admin-audit-evidence-body')).toHaveTextContent('user.update')
    expect(screen.getByTestId('admin-audit-full-page-link')).toHaveAttribute('href', '/settings/audit-logs')

    await user.click(screen.getByTestId('admin-config-evidence-toggle'))
    expect(screen.getByTestId('admin-config-evidence-body')).toHaveTextContent(/stream/)
  })

  it('renders health current-state and actionable evidence hierarchy', async () => {
    const user = userEvent.setup()
    renderDash()

    expect(await screen.findByTestId('admin-health-current-state')).toHaveTextContent(/Good/)
    expect(screen.getByTestId('admin-health-actionable')).toBeInTheDocument()
    expect(screen.getByTestId('admin-health-actionable-queue_depth')).toHaveTextContent(/Medium/)
    expect(screen.getByTestId('admin-health-actionable-error_rate')).toHaveTextContent(/Poor/)
    expect(screen.queryByTestId('admin-health-metrics-body')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('admin-health-metrics-toggle'))
    expect(screen.getByTestId('admin-health-metrics-body')).toHaveTextContent(/Delivery success/)
  })

  it('surfaces health load errors without hiding the panel', async () => {
    vi.mocked(getAdminHealthSummary).mockRejectedValue(new Error('health down'))
    renderDash()
    expect(await screen.findByTestId('admin-health-error')).toHaveTextContent(/health down/)
    expect(screen.getByRole('heading', { name: 'Health monitoring' })).toBeInTheDocument()
  })

  it('keeps Alerting gated behind the feature flag', async () => {
    renderDash()
    await screen.findByTestId('admin-health-panel')
    expect(screen.queryByTestId('admin-alerting-panel')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Alerting' })).not.toBeInTheDocument()
    expect(getAdminAlertSettings).not.toHaveBeenCalled()
  })

  it('shows Alerting when the feature flag is enabled and disables manage for read-only', async () => {
    vi.mocked(isPlatformAlertingUiEnabled).mockReturnValue(true)
    vi.mocked(getAdminAlertSettings).mockResolvedValue({
      rules: [{ alert_type: 'delivery_failure', enabled: true, severity: 'WARNING', last_triggered_at: null }],
      webhook_url: 'https://hooks.example/x',
      slack_webhook_url: null,
      email_to: null,
      channel_status: { webhook: 'configured' },
      notification_delivery: { webhook: 'ready' },
      cooldown_seconds: 600,
      monitor_enabled: true,
    })
    renderDash(true)
    expect(await screen.findByTestId('admin-alerting-panel')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Alerting' })).toBeInTheDocument()
    await waitFor(() => expect(getAdminAlertSettings).toHaveBeenCalled())
    expect(screen.getByTestId('admin-manage-alerts')).toBeDisabled()
  })
})
