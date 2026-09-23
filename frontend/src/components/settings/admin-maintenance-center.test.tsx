import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAdminMaintenanceHealth } from '../../api/gdcAdmin'
import { AdminMaintenanceCenter } from './admin-maintenance-center'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminMaintenanceHealth: vi.fn(() =>
    Promise.resolve({
      generated_at: '2026-05-12T12:00:00Z',
      overall: 'WARN',
      ok: [{ code: 'DB_OK', message: 'ok', panel: 'database' }],
      warn: [{ code: 'DB_LATENCY_HIGH', message: 'slow', panel: 'database' }],
      error: [],
      panels: {
        database: { status: 'WARN', reachable: true, latency_ms: 500, database_url_masked: 'postgresql://****', version_short: 'PostgreSQL' },
        migrations: { status: 'OK', database_revision: 'head', script_heads: ['head'], in_sync: true },
        scheduler: { status: 'OK', startup_scheduler_active_gate: true, supervisor_uptime_seconds: 10, active_worker_count: 1 },
        retention: { status: 'WARN', cleanup_scheduler_enabled: false, cleanup_thread_running: false, cleanup_interval_minutes: 60 },
        storage: { status: 'OK', disk: { path: '/', used_percent: 40, free_bytes: 1e12, total_bytes: 2e12 } },
        destinations: { status: 'OK', window_hours: 1, destinations: [] },
        certificates: { status: 'OK', https_enabled: false, certificate_not_after: null, days_remaining: null },
        recent_failures: { status: 'OK', count_returned: 0, items: [] },
        support_bundle: { status: 'OK', download_method: 'GET', download_path: '/api/v1/admin/support-bundle' },
      },
    }),
  ),
  downloadAdminSupportBundle: vi.fn(() => Promise.resolve()),
}))

describe('AdminMaintenanceCenter', () => {
  it('renders current-state → problem evidence → progressive panel detail hierarchy', async () => {
    const user = userEvent.setup()
    render(<AdminMaintenanceCenter backendRole="ADMINISTRATOR" busy={false} setBusy={() => {}} />)

    expect(await screen.findByTestId('admin-maintenance-panel')).toBeInTheDocument()
    expect(screen.getByTestId('maintenance-current-state')).toHaveTextContent(/WARN/)
    expect(screen.getByTestId('maintenance-overall')).toHaveTextContent('WARN')
    expect(screen.getByTestId('maintenance-problem-evidence')).toBeInTheDocument()
    expect(screen.getByTestId('maintenance-warnings-block')).toBeInTheDocument()
    expect(screen.getByTestId('maintenance-problem-database')).toHaveTextContent(/Database/)
    expect(screen.getByTestId('maintenance-problem-database').className).toMatch(/amber-50/)
    expect(screen.queryByTestId('maintenance-panel-details-body')).not.toBeInTheDocument()
    expect(screen.queryByTestId('maintenance-card-database')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('maintenance-panel-details-toggle'))
    expect(screen.getByTestId('maintenance-panel-details-body')).toBeInTheDocument()
    const card = screen.getByTestId('maintenance-card-database')
    expect(card.className).toMatch(/amber-50/)
    expect(screen.getByTestId('maintenance-card-storage')).toBeInTheDocument()
  })

  it('shows access note for non-administrator', () => {
    render(<AdminMaintenanceCenter backendRole="OPERATOR" busy={false} setBusy={() => {}} />)
    expect(screen.getByTestId('maintenance-access-note')).toBeInTheDocument()
    expect(screen.queryByTestId('maintenance-card-database')).not.toBeInTheDocument()
    expect(screen.queryByTestId('maintenance-current-state')).not.toBeInTheDocument()
  })

  it('preserves refresh fetch behavior', async () => {
    const user = userEvent.setup()
    vi.mocked(getAdminMaintenanceHealth).mockClear()
    render(<AdminMaintenanceCenter backendRole="ADMINISTRATOR" busy={false} setBusy={() => {}} />)
    await screen.findByTestId('maintenance-current-state')
    const before = vi.mocked(getAdminMaintenanceHealth).mock.calls.length
    expect(before).toBeGreaterThanOrEqual(1)
    await user.click(screen.getByTestId('maintenance-refresh'))
    await waitFor(() => expect(getAdminMaintenanceHealth).toHaveBeenCalledTimes(before + 1))
  })
})

describe('AdminMaintenanceCenter runbook shortcut', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shows in-repo runbook path when hosted URL is not set', async () => {
    const user = userEvent.setup()
    vi.stubEnv('VITE_ADMIN_BACKUP_RESTORE_RUNBOOK_URL', '')
    render(<AdminMaintenanceCenter backendRole="ADMINISTRATOR" busy={false} setBusy={() => {}} />)
    await screen.findByTestId('maintenance-current-state')
    expect(screen.queryByTestId('maintenance-runbook-shortcut')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('maintenance-runbook-toggle'))
    expect(await screen.findByTestId('maintenance-runbook-shortcut')).toBeInTheDocument()
    expect(screen.getByText('docs/admin/backup-restore.md')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Backup & Restore Runbook' })).not.toBeInTheDocument()
  })

  it('renders runbook link when VITE_ADMIN_BACKUP_RESTORE_RUNBOOK_URL is set', async () => {
    const user = userEvent.setup()
    vi.stubEnv('VITE_ADMIN_BACKUP_RESTORE_RUNBOOK_URL', 'https://ops.example/docs/backup-restore')
    render(<AdminMaintenanceCenter backendRole="ADMINISTRATOR" busy={false} setBusy={() => {}} />)
    await screen.findByTestId('maintenance-current-state')
    await user.click(screen.getByTestId('maintenance-runbook-toggle'))
    const link = await screen.findByRole('link', { name: 'Backup & Restore Runbook' })
    expect(link).toHaveAttribute('href', 'https://ops.example/docs/backup-restore')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
