import { describe, expect, it } from 'vitest'
import { humanizeQuarantineReason } from '../../lib/humanize-quarantine-reason'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuarantinePanel } from './quarantine-panel'
import * as gdcQuarantine from '../../api/gdcQuarantine'
import { beforeEach, vi } from 'vitest'

describe('QuarantinePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineSummary').mockResolvedValue({
      stream_id: 10,
      quarantined_count: 1,
      released_count: 0,
      discarded_count: 0,
      total_count: 1,
      last_released_at: null,
    })
    vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineEvents').mockResolvedValue({
      stream_id: 10,
      event_count: 1,
      events: [
        {
          id: 7,
          stream_id: 10,
          quarantine_reason: 'policy:schema_drift:unknown_sensitive',
          quarantine_source: 'policy',
          status: 'quarantined',
          event_count: 1,
          created_at: '2026-06-14T10:00:00Z',
          updated_at: '2026-06-14T10:00:00Z',
          released_at: null,
          released_by: null,
        },
      ],
    })
  })

  it('shows humanized quarantine reason', async () => {
    render(<QuarantinePanel streamId={10} canOperate={false} />)
    expect(await screen.findByText('Schema Drift Policy — Unknown Sensitive Field')).toBeInTheDocument()
  })

  it('requires confirmation before discard and does not call API on cancel', async () => {
    const user = userEvent.setup()
    const discardSpy = vi.spyOn(gdcQuarantine, 'discardStreamQuarantineEvent').mockResolvedValue({
      id: 7,
      stream_id: 10,
      status: 'discarded',
      outcome: 'discarded',
      message: 'discarded',
    } as never)
    render(<QuarantinePanel streamId={10} canOperate />)
    await waitFor(() => expect(screen.getByTestId('quarantine-event-discard-7')).toBeInTheDocument())
    await user.click(screen.getByTestId('quarantine-event-discard-7'))
    expect(await screen.findByTestId('quarantine-discard-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-discard-dialog').textContent).toMatch(/Permanently discards/i)
    await user.click(screen.getByTestId('quarantine-discard-dialog-cancel'))
    expect(discardSpy).not.toHaveBeenCalled()
  })

  it('confirms release before calling API', async () => {
    const user = userEvent.setup()
    const releaseSpy = vi.spyOn(gdcQuarantine, 'releaseStreamQuarantineEvent').mockResolvedValue({
      id: 7,
      stream_id: 10,
      status: 'released',
      outcome: 'released',
      message: 'released',
    } as never)
    render(<QuarantinePanel streamId={10} canOperate />)
    await waitFor(() => expect(screen.getByTestId('quarantine-event-release-7')).toBeInTheDocument())
    await user.click(screen.getByTestId('quarantine-event-release-7'))
    expect(await screen.findByTestId('quarantine-release-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-release-dialog').textContent).toMatch(/checkpoint/i)
    await user.click(screen.getByTestId('quarantine-release-dialog-confirm'))
    await waitFor(() => expect(releaseSpy).toHaveBeenCalledWith(7))
  })
})

describe('humanizeQuarantineReason manual case', () => {
  it('maps manual source to Manual Quarantine', () => {
    expect(humanizeQuarantineReason('hold', { quarantineSource: 'manual' })).toBe('Manual Quarantine')
  })
})
