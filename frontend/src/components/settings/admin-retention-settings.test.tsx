import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAdminRetentionPolicy,
  postAdminRetentionCleanupRun,
  putAdminRetentionPolicy,
} from '../../api/gdcAdmin'
import { AdminRetentionSettings } from './admin-retention-settings'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminRetentionPolicy: vi.fn(),
  postAdminRetentionCleanupRun: vi.fn(),
  putAdminRetentionPolicy: vi.fn(),
}))

vi.mock('../../lib/platform-timestamps', () => ({
  formatTimestampWithResolvedTimezone: (iso: string) => iso,
}))

const retentionFixture = {
  logs: {
    retention_days: 30,
    enabled: true,
    last_cleanup_at: '2026-09-20T00:00:00Z',
    next_cleanup_at: '2026-09-24T00:00:00Z',
    last_deleted_count: 12,
    last_duration_ms: 40,
    last_status: 'ok',
  },
  runtime_metrics: {
    retention_days: 14,
    enabled: true,
    last_cleanup_at: null,
    next_cleanup_at: null,
    last_deleted_count: null,
    last_duration_ms: null,
    last_status: null,
  },
  preview_cache: {
    retention_days: 7,
    enabled: false,
    last_cleanup_at: null,
    next_cleanup_at: null,
    last_deleted_count: null,
    last_duration_ms: null,
    last_status: null,
  },
  backup_temp: {
    retention_days: 3,
    enabled: true,
    last_cleanup_at: null,
    next_cleanup_at: null,
    last_deleted_count: null,
    last_duration_ms: null,
    last_status: null,
  },
  cleanup_scheduler_active: true,
  cleanup_scheduler_enabled: true,
  cleanup_interval_minutes: 60,
  cleanup_batch_size: 5000,
  scheduler_started_at: '2026-09-01T00:00:00Z',
  scheduler_last_tick_at: '2026-09-23T12:00:00Z',
  scheduler_last_summary: 'ok',
  cleanup_engine_message: 'Operational retention scheduler.',
  delivery_logs_scheduler_metrics: {
    logs_cumulative_deleted_since_process_start: 100,
    logs_category_sweeps: 4,
  },
}

describe('AdminRetentionSettings lifecycle workspace', () => {
  const setBusy = vi.fn()
  const setPageMsg = vi.fn()
  const setPageErr = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAdminRetentionPolicy).mockResolvedValue(retentionFixture)
  })

  function renderPanel(readOnly = false) {
    return render(
      <AdminRetentionSettings
        reloadToken={0}
        readOnly={readOnly}
        busy={false}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />,
    )
  }

  it('renders current-state → policy → cleanup → actions hierarchy under Lifecycle', async () => {
    renderPanel()
    expect(await screen.findByTestId('admin-retention-panel')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Retention / cleanup' })).toBeInTheDocument()
    expect(screen.getByTestId('admin-retention-current-state')).toHaveTextContent(/Running/i)
    expect(screen.getByTestId('admin-retention-policy-summary')).toHaveTextContent(/30 days/)
    expect(screen.getByTestId('admin-retention-cleanup-status')).toBeInTheDocument()
    expect(screen.getByTestId('admin-retention-actions')).toBeInTheDocument()
    expect(screen.getByTestId('admin-retention-dry-run')).toBeInTheDocument()
    expect(screen.getByTestId('admin-retention-run-cleanup')).toBeInTheDocument()
    expect(screen.getByTestId('admin-retention-edit-policy')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-retention-advanced')).not.toBeInTheDocument()
  })

  it('keeps expert evidence behind progressive disclosure', async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByTestId('admin-retention-panel')
    await user.click(screen.getByTestId('admin-retention-advanced-toggle'))
    expect(screen.getByTestId('admin-retention-advanced')).toHaveTextContent(/delivery_logs cleanup metrics/i)
    await user.click(screen.getByRole('button', { name: /Show category details/i }))
    expect(screen.getByRole('columnheader', { name: 'Next cleanup' })).toBeInTheDocument()
  })

  it('disables mutating actions for Viewer read-only sessions', async () => {
    renderPanel(true)
    await screen.findByTestId('admin-retention-panel')
    expect(screen.getByTestId('admin-retention-dry-run')).toBeDisabled()
    expect(screen.getByTestId('admin-retention-run-cleanup')).toBeDisabled()
    expect(screen.getByTestId('admin-retention-edit-policy')).toBeDisabled()
    expect(screen.getByRole('button', { name: /Run cleanup now for Logs/i })).toBeDisabled()
  })

  it('runs dry-run and surfaces last-run evidence', async () => {
    const user = userEvent.setup()
    vi.mocked(postAdminRetentionCleanupRun).mockResolvedValue({
      dry_run: true,
      triggered_at: '2026-09-23T13:00:00Z',
      outcomes: [{ category: 'logs', status: 'ok', deleted_count: 0 } as never],
      policy: retentionFixture,
    })
    renderPanel()
    await screen.findByTestId('admin-retention-panel')
    await user.click(screen.getByTestId('admin-retention-dry-run'))
    await waitFor(() => expect(postAdminRetentionCleanupRun).toHaveBeenCalledWith({ dry_run: true }))
    expect(await screen.findByTestId('admin-retention-last-run')).toHaveTextContent(/dry-run/i)
    expect(setPageMsg).toHaveBeenCalled()
  })

  it('opens policy dialog and saves retention settings', async () => {
    const user = userEvent.setup()
    vi.mocked(putAdminRetentionPolicy).mockResolvedValue(retentionFixture)
    renderPanel()
    await screen.findByTestId('admin-retention-panel')
    await user.click(screen.getByTestId('admin-retention-edit-policy'))
    expect(screen.getByTestId('admin-retention-policy-dialog')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Retention policy')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putAdminRetentionPolicy).toHaveBeenCalled())
    expect(setPageMsg).toHaveBeenCalledWith('Retention policy saved.')
  })

  it('surfaces load errors with alert semantics', async () => {
    vi.mocked(getAdminRetentionPolicy).mockRejectedValue(new Error('retention down'))
    renderPanel()
    expect(await screen.findByRole('alert')).toHaveTextContent(/retention down/i)
  })
})
