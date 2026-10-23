import { act, render, screen, waitFor } from '@testing-library/react'
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

  it('ignores late revision responses from the previously selected stream', async () => {
    let finishOld!: (value: typeof versions) => void
    const oldPending = new Promise<typeof versions>((resolve) => { finishOld = resolve })
    vi.mocked(getAdminConfigVersions)
      .mockImplementationOnce(() => oldPending)
      .mockResolvedValueOnce({ total: 0, items: [] })
    const props = { runtimeStatus: 'STOPPED' as const, canRestore: false, restoreBlocked: false, onRestored: vi.fn() }
    const { rerender } = render(<StreamConfigurationRevisions streamId={10} {...props} />)
    await waitFor(() => expect(getAdminConfigVersions).toHaveBeenCalledTimes(1))
    rerender(<StreamConfigurationRevisions streamId={11} {...props} />)
    await waitFor(() => expect(getAdminConfigVersions).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No saved Stream revisions are available yet.')).toBeInTheDocument()
    await act(async () => { finishOld(versions) })
    expect(screen.queryByText('Review v10')).not.toBeInTheDocument()
    expect(screen.getByText('No saved Stream revisions are available yet.')).toBeInTheDocument()
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
    expect(screen.getByText('Reviewed revision → Current configuration')).toBeInTheDocument()
    expect(screen.getByText('polling_interval: 30 → 60')).toBeInTheDocument()
    expect(screen.getByText(/Administrator permission is required to restore/)).toBeInTheDocument()
    expect(screen.queryByTestId('stream-revision-restore-confirm')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel review' }))
    expect(screen.queryByTestId('stream-revision-restore-preview')).not.toBeInTheDocument()
  })

  it('explains an empty scoped comparison and preserves the observed restore blockers', async () => {
    const user = userEvent.setup()
    const onRestored = vi.fn()
    vi.mocked(getAdminSafeRollbackPreview).mockResolvedValue({
      ...safePreview,
      changed_fields: [],
      blockers: [
        'unsupported',
        'unauthorized',
        'mfa_required',
        'backup_missing',
        'recovery_unavailable',
        'out_of_band_required',
        'audit_unavailable',
      ],
      may_submit_to_product_authority: false,
    })
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

    expect(await screen.findByText(/This review compares only Enabled and Polling interval/)).toBeInTheDocument()
    expect(screen.getByText(/Names and other Stream settings are not compared/)).toBeInTheDocument()
    expect(screen.getByText('No differences in the compared settings. Other settings may still differ.')).toBeInTheDocument()
    expect(screen.queryByText('Reviewed revision → Current configuration')).not.toBeInTheDocument()
    expect(screen.getByText(/Restore blocked: unsupported, unauthorized, mfa required/)).toBeInTheDocument()
    expect(screen.getByText('Current safety review does not authorize this restore.')).toBeInTheDocument()
    const restore = screen.getByTestId('stream-revision-restore-confirm')
    expect(restore).toBeDisabled()
    await user.click(restore)
    await user.click(screen.getByRole('button', { name: 'Cancel review' }))

    expect(screen.queryByTestId('stream-revision-restore-preview')).not.toBeInTheDocument()
    expect(applyAdminConfigSnapshot).not.toHaveBeenCalled()
    expect(onRestored).not.toHaveBeenCalled()
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
