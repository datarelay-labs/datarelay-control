import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAdminConfigSnapshot,
  getAdminConfigVersions,
  getAdminSafeRollbackPreview,
} from '../../api/gdcAdmin'
import { StreamConfigurationRevisions } from './stream-configuration-revisions'

vi.mock('../../api/gdcAdmin', () => ({
  getAdminConfigVersions: vi.fn(),
  getAdminSafeRollbackPreview: vi.fn(),
  applyAdminConfigSnapshot: vi.fn(),
}))

const versions = {
  total: 2,
  items: [
    {
      id: 72,
      version: 12,
      entity_type: 'STREAM_CONFIG',
      entity_id: 10,
      entity_name: 'Orders',
      changed_by: 'admin',
      changed_at: '2026-10-14T09:00:00Z',
      summary: 'Current save',
    },
    {
      id: 71,
      version: 10,
      entity_type: 'STREAM_CONFIG',
      entity_id: 10,
      entity_name: 'Orders',
      changed_by: 'admin',
      changed_at: '2026-10-14T08:00:00Z',
      summary: 'Earlier save',
    },
  ],
}

const safePreview = {
  entity_type: 'STREAM_CONFIG',
  source_version_row_id: 71,
  source_version: 10,
  current_version: 12,
  expected_version: 12,
  target: 'after' as const,
  changed_fields: [{ path: 'polling_interval', before: '30', after: '60' }],
  from_fingerprint: 'current',
  to_fingerprint: 'earlier',
  blockers: [],
  may_submit_to_product_authority: true,
  product_apply_required: true,
}

describe('StreamConfigurationRevisions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAdminConfigVersions).mockResolvedValue(versions)
    vi.mocked(getAdminSafeRollbackPreview).mockResolvedValue(safePreview)
    vi.mocked(applyAdminConfigSnapshot).mockResolvedValue({
      applied_target: 'after',
      source_version_row_id: 71,
      source_monotonic_version: 10,
      new_monotonic_version: 13,
      message: 'restored',
    })
  })

  it('shows saved history and keeps restore administrator-only', async () => {
    const user = userEvent.setup()
    render(
      <StreamConfigurationRevisions
        streamId={10}
        runtimeStatus="STOPPED"
        canRestore={false}
        restoreBlocked={false}
        onRestored={vi.fn()}
      />,
    )

    expect(await screen.findByText(/Current saved revision v12/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review v10' }))

    await waitFor(() => expect(getAdminSafeRollbackPreview).toHaveBeenCalledWith(71, 12, 'after'))
    expect(screen.getByText(/Administrator permission is required to restore/)).toBeInTheDocument()
    expect(screen.queryByTestId('stream-revision-restore-confirm')).not.toBeInTheDocument()
  })

  it('restores a reviewed stopped revision without starting runtime', async () => {
    const user = userEvent.setup()
    const onRestored = vi.fn(async () => {})
    render(
      <StreamConfigurationRevisions
        streamId={10}
        runtimeStatus="STOPPED"
        canRestore
        restoreBlocked={false}
        onRestored={onRestored}
      />,
    )

    await screen.findByText(/Current saved revision v12/)
    await user.click(screen.getByRole('button', { name: 'Review v10' }))
    const restore = await screen.findByTestId('stream-revision-restore-confirm')
    expect(restore).toBeEnabled()
    await user.click(restore)

    await waitFor(() =>
      expect(applyAdminConfigSnapshot).toHaveBeenCalledWith(71, {
        target: 'after',
        expected_version: 12,
      }),
    )
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/Runtime was not started/i)).toBeInTheDocument()
  })

  it('blocks restoration while the stream is running or the draft is unconfirmed', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <StreamConfigurationRevisions
        streamId={10}
        runtimeStatus="RUNNING"
        canRestore
        restoreBlocked={false}
        onRestored={vi.fn()}
      />,
    )
    await screen.findByText(/Exact running revision is not reported/)
    await user.click(screen.getByRole('button', { name: 'Review v10' }))
    expect(await screen.findByText(/Stop the Stream before restoring/)).toBeInTheDocument()
    expect(screen.getByTestId('stream-revision-restore-confirm')).toBeDisabled()

    rerender(
      <StreamConfigurationRevisions
        streamId={10}
        runtimeStatus="STOPPED"
        canRestore
        restoreBlocked
        onRestored={vi.fn()}
      />,
    )
    expect(await screen.findByText(/Save or discard the local draft before restoring/)).toBeInTheDocument()
    expect(screen.getByTestId('stream-revision-restore-confirm')).toBeDisabled()
  })
})
