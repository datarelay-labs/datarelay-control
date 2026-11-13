import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamDeduplicationCard } from './stream-deduplication-card'

const fetchDedup = vi.fn()
const saveDedup = vi.fn()

vi.mock('../../api/gdcRuntimeUi', async () => {
  const actual = await vi.importActual<typeof import('../../api/gdcRuntimeUi')>('../../api/gdcRuntimeUi')
  return {
    ...actual,
    fetchStreamDeduplication: (...args: unknown[]) => fetchDedup(...args),
    saveStreamDeduplication: (...args: unknown[]) => saveDedup(...args),
  }
})

const OFF = {
  enabled: false,
  key_field: 'event_id',
  custom_jsonpath: null,
  duplicate_handling: 'skip_duplicate',
  scope: 'current_run',
  window_hours: null,
  last_runtime_duplicate_count: 0,
  last_runtime_dedup_summary: null,
  last_runtime_stats_degraded: false,
}

describe('StreamDeduplicationCard (F-132)', () => {
  beforeEach(() => {
    fetchDedup.mockReset()
    saveDedup.mockReset()
  })

  it('shows the current state and saves a key on a stopped stream, confirming by read-back', async () => {
    fetchDedup.mockResolvedValueOnce(OFF)
    saveDedup.mockResolvedValueOnce({ ...OFF, enabled: true })
    fetchDedup.mockResolvedValueOnce({ ...OFF, enabled: true, key_field: 'id' })
    render(<StreamDeduplicationCard streamId={7} running={false} />)

    await waitFor(() => expect(screen.getByTestId('stream-dedup-state')).toHaveTextContent('Off'))
    fireEvent.change(screen.getByTestId('stream-dedup-key-input'), { target: { value: 'id' } })
    fireEvent.click(screen.getByTestId('stream-dedup-save'))

    await waitFor(() => expect(screen.getByTestId('stream-dedup-message')).toHaveTextContent('saved and confirmed'))
    expect(saveDedup).toHaveBeenCalledWith(7, expect.objectContaining({ enabled: true, key_field: 'id' }))
    expect(screen.getByTestId('stream-dedup-state')).toHaveTextContent('On · key id')
  })

  it('follows the stop-first rule on a running stream', async () => {
    fetchDedup.mockResolvedValueOnce(OFF)
    render(<StreamDeduplicationCard streamId={7} running />)
    await waitFor(() => expect(screen.getByTestId('stream-dedup-blocked')).toHaveTextContent('Stop the stream'))
    expect(screen.getByTestId('stream-dedup-key-input')).toBeDisabled()
    expect(screen.getByTestId('stream-dedup-save')).toBeDisabled()
  })
})
