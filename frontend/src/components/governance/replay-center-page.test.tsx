import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcGovernanceReplay from '../../api/gdcGovernanceReplay'
import * as gdcStreams from '../../api/gdcStreams'
import { NAV_PATH } from '../../config/nav-paths'
import { PERSONA_STORAGE_KEY } from '../../utils/persona-mode'
import { persistTestSession } from '../../lib/governance-rbac'
import { ReplayCenterPage } from './replay-center-page'

const sampleEntry: gdcGovernanceReplay.GovernanceReplayEntry = {
  id: 7,
  policy_id: 1,
  policy_name: 'Customer PII Policy',
  stream_id: 10,
  stream_name: 'Malop API',
  status: 'PENDING',
  created_at: '2026-06-06T10:00:00Z',
  completed_at: null,
  outcome: null,
  event_count: 1,
  correlation_id: 'q-42',
}

const failedEntry: gdcGovernanceReplay.GovernanceReplayEntry = {
  ...sampleEntry,
  id: 8,
  status: 'FAILED',
  outcome: 'Failure',
  completed_at: '2026-06-06T11:00:00Z',
}

const sampleDetail: gdcGovernanceReplay.GovernanceReplayDetailResponse = {
  entry: sampleEntry,
  policy_summary: {
    policy_id: 1,
    policy_name: 'Customer PII Policy',
    policy_status: 'ACTIVE',
    policy_version: 3,
  },
  correlation_id: 'q-42',
  source: {
    origin: 'Quarantine recovery',
    violation: { violation_id: 'q-42', status: 'QUARANTINED', reason: 'Response rule matched' },
    quarantine: {
      quarantine_event_id: 42,
      status: 'quarantined',
      quarantine_reason: 'policy:Customer PII Policy',
      created_at: '2026-06-06T09:00:00Z',
    },
  },
  timeline: [
    { step: 'replay_created', label: 'Replay created', event_time: '2026-06-06T10:00:00Z' },
  ],
  outcome: null,
  error_type: null,
  error_message: null,
  can_execute: true,
}

function SearchParamsProbe() {
  const [params] = useSearchParams()
  return <div data-testid="search-params">{params.toString()}</div>
}

function renderPage(initialEntries = ['/governance/replay']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/governance/replay"
          element={
            <>
              <SearchParamsProbe />
              <ReplayCenterPage />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ReplayCenterPage', () => {
  beforeEach(() => {
    localStorage.setItem(PERSONA_STORAGE_KEY, 'governance')
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [{ id: 1, name: 'Customer PII Policy' } as gdcGovernancePolicies.GovernancePolicyEntry],
    })
    vi.spyOn(gdcStreams, 'fetchStreamsList').mockResolvedValue([{ id: 10, name: 'Malop API' } as gdcStreams.StreamRead])
  })

  it('renders investigation-first hierarchy and replay table', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage()

    expect(await screen.findByTestId('replay-center-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Replay Center/i })).toBeInTheDocument()
    expect(screen.getByTestId('replay-scan-summary')).toBeInTheDocument()
    expect(screen.getByTestId('replay-count-queue')).toHaveTextContent('1')
    expect(screen.getByTestId('replay-filters-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('replay-table')).toBeInTheDocument()
    expect(await screen.findByTestId('replay-row-7')).toBeInTheDocument()
    expect(screen.getByTestId('replay-row-7')).toHaveTextContent('Malop API')
    expect(screen.getByTestId('replay-row-7')).toHaveTextContent('Pending')
  })

  it('shows empty state when no events', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      replay_events: [],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage()

    expect(await screen.findByTestId('replay-empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No replay events found/i)).toBeInTheDocument()
  })

  it('shows no-match state when filters exclude all events', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      replay_events: [],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage(['/governance/replay?status=FAILED'])

    expect(await screen.findByTestId('replay-no-match-state')).toBeInTheDocument()
    expect(screen.getByTestId('replay-no-match-clear')).toBeInTheDocument()
  })

  it('opens detail drawer with source, timeline, and exact-id navigation', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByTestId('replay-row-7'))

    await waitFor(() => {
      expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('replay-section-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('replay-related-evidence')).toBeInTheDocument()
    expect(screen.getByTestId('replay-audit-link')).toHaveTextContent('q-42')
    expect(screen.getByTestId('replay-action-execute')).toBeInTheDocument()
    expect(screen.getByTestId('replay-open-violation')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceViolations}?id=q-42`,
    )
    expect(screen.getByTestId('replay-open-quarantine')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceQuarantine}?id=42`,
    )
    expect(screen.getByTestId('replay-related-violation-link')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceViolations}?id=q-42`,
    )
    expect(screen.getByTestId('search-params')).toHaveTextContent('id=7')
  })

  it('opens investigation from ?id deep link without requiring a table row click', async () => {
    const detailSpy = vi
      .spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail')
      .mockResolvedValue(sampleDetail)
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      replay_events: [],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage(['/governance/replay?id=7'])

    await waitFor(() => {
      expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument()
      expect(screen.getByTestId('replay-action-execute')).toBeInTheDocument()
    })
    expect(detailSpy).toHaveBeenCalledWith(7, '30d')
  })

  it('synchronizes open/close URL with ?id while preserving ?status', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [failedEntry],
      queue_count: 0,
      failed_count: 1,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue({
      ...sampleDetail,
      entry: failedEntry,
      can_execute: true,
    })

    renderPage(['/governance/replay?status=FAILED'])
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByTestId('search-params')).toHaveTextContent('status=FAILED')
    })

    await user.click(await screen.findByTestId('replay-row-8'))
    await waitFor(() => {
      expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('search-params').textContent).toMatch(/id=8/)
    expect(screen.getByTestId('search-params').textContent).toMatch(/status=FAILED/)

    await user.click(screen.getByTestId('replay-detail-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('replay-detail-drawer')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('search-params').textContent).not.toMatch(/id=/)
    expect(screen.getByTestId('search-params').textContent).toMatch(/status=FAILED/)
  })

  it('supports keyboard activation of a replay row', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    const row = await screen.findByTestId('replay-row-7')
    row.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument()
    })
  })

  it('bulk execute selected replays', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 2,
      replay_events: [sampleEntry, failedEntry],
      queue_count: 1,
      failed_count: 1,
      recent_count: 0,
    })
    const bulkSpy = vi.spyOn(gdcGovernanceReplay, 'bulkExecuteGovernanceReplay').mockResolvedValue({
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { id: 7, outcome: 'replayed', message: 'ok' },
        { id: 8, outcome: 'replayed', message: 'ok' },
      ],
    })

    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByTestId('replay-select-7'))
    await user.click(await screen.findByTestId('replay-select-8'))
    await user.click(await screen.findByTestId('replay-bulk-execute'))

    expect(await screen.findByTestId('replay-center-execute-dialog')).toBeInTheDocument()
    expect(bulkSpy).not.toHaveBeenCalled()
    await user.type(screen.getByTestId('replay-center-execute-dialog-type-name'), 'REPLAY')
    await user.click(screen.getByTestId('replay-center-execute-dialog-confirm'))

    await waitFor(() => {
      expect(bulkSpy).toHaveBeenCalledWith([7, 8])
    })
  })

  it('shows connector read-only banner without bulk actions', async () => {
    persistTestSession('CONNECTOR_OPERATOR')
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage()

    expect(await screen.findByTestId('replay-read-only-banner')).toBeInTheDocument()
    expect(screen.queryByTestId('replay-bulk-execute')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-select-all')).not.toBeInTheDocument()
  })

  it('hides execute action for viewer sessions on deep link', async () => {
    persistTestSession('VIEWER', 'viewer')
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)

    renderPage(['/governance/replay?id=7'])

    expect(await screen.findByTestId('replay-read-only-banner')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument())
    expect(screen.queryByTestId('replay-action-execute')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-bulk-execute')).not.toBeInTheDocument()
  })

  it('applies status filter from query param and coexists with ?id', async () => {
    const fetchSpy = vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      replay_events: [],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)

    renderPage(['/governance/replay?status=FAILED&id=7'])

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }))
    })
    expect(await screen.findByTestId('replay-filter-status')).toHaveValue('FAILED')
    await waitFor(() => {
      expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('search-params').textContent).toMatch(/status=FAILED/)
    expect(screen.getByTestId('search-params').textContent).toMatch(/id=7/)
  })

  it('renders filters with accessible labels', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      replay_events: [],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })

    renderPage()

    expect(await screen.findByTestId('replay-filters')).toBeInTheDocument()
    expect(screen.getByLabelText('Time range')).toBeInTheDocument()
    expect(screen.getByLabelText('Policy')).toBeInTheDocument()
    expect(screen.getByLabelText('Stream')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
  })

  it('links delivery-failure jobs to the failing Route records, not the quarantine stage (E-115)', async () => {
    const deliveryEntry = { ...sampleEntry, route_id: 22, destination_id: 5 }
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [deliveryEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue({
      ...sampleDetail,
      entry: deliveryEntry,
      source: { origin: 'Delivery failure recovery', violation: null, quarantine: null },
    })

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-row-7'))

    const href = (await screen.findByTestId('replay-view-logs')).getAttribute('href') ?? ''
    expect(href).toContain('stream_id=10')
    expect(href).toContain('route_id=22')
    expect(href).not.toContain('quarantine_event_created')
  })

  it('keeps the quarantine-stage Logs link for quarantine recoveries', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-row-7'))
    expect((await screen.findByTestId('replay-view-logs')).getAttribute('href')).toContain('quarantine_event_created')
  })

  it('bulk dialog dependency line has no stray plural suffix (E-115)', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 2,
      replay_events: [sampleEntry, failedEntry],
      queue_count: 1,
      failed_count: 1,
      recent_count: 0,
    })
    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-select-7'))
    await user.click(await screen.findByTestId('replay-select-8'))
    await user.click(await screen.findByTestId('replay-bulk-execute'))

    const deps = await screen.findByTestId('replay-center-execute-dialog-dependencies')
    expect(deps.textContent).toContain('Selected replay jobs: 2')
    expect(deps.textContent).not.toContain('2s')
  })

  it('discards a pending job from the drawer after confirmation (E-116)', async () => {
    const events = {
      window: '24h' as const,
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    }
    const fetchSpy = vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue(events)
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue({ ...sampleDetail, can_discard: true })
    const discardSpy = vi
      .spyOn(gdcGovernanceReplay, 'discardGovernanceReplay')
      .mockResolvedValue({ id: 7, outcome: 'discarded', message: 'Replay job discarded; no events were delivered.' })

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-row-7'))
    await user.click(await screen.findByTestId('replay-action-discard'))

    expect(await screen.findByTestId('replay-center-discard-dialog')).toBeInTheDocument()
    expect(discardSpy).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('replay-center-discard-dialog-confirm'))

    await waitFor(() => expect(discardSpy).toHaveBeenCalledWith(7))
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(1))
  })

  it('offers no discard action to read-only roles or for non-discardable jobs', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue({ ...sampleDetail, can_discard: false })
    renderPage(['/governance/replay?id=7'])
    await waitFor(() => expect(screen.getByTestId('replay-detail-drawer')).toBeInTheDocument())
    expect(screen.queryByTestId('replay-action-discard')).not.toBeInTheDocument()
  })

  it('bulk discard requires typing DISCARD', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 2,
      replay_events: [sampleEntry, failedEntry],
      queue_count: 1,
      failed_count: 1,
      recent_count: 0,
    })
    const bulkSpy = vi.spyOn(gdcGovernanceReplay, 'bulkDiscardGovernanceReplay').mockResolvedValue({
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { id: 7, outcome: 'discarded', message: 'ok' },
        { id: 8, outcome: 'discarded', message: 'ok' },
      ],
    })
    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-select-7'))
    await user.click(await screen.findByTestId('replay-select-8'))
    await user.click(await screen.findByTestId('replay-bulk-discard'))
    await user.type(await screen.findByTestId('replay-center-discard-dialog-type-name'), 'DISCARD')
    await user.click(screen.getByTestId('replay-center-discard-dialog-confirm'))
    await waitFor(() => expect(bulkSpy).toHaveBeenCalledWith([7, 8]))
  })

  it('requires an explicit override when the events were already delivered (E-113)', async () => {
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [sampleEntry],
      queue_count: 1,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue(sampleDetail)
    const execSpy = vi
      .spyOn(gdcGovernanceReplay, 'executeGovernanceReplay')
      .mockResolvedValueOnce({
        id: 7,
        outcome: 'failed',
        message: 'These events were already delivered to this destination.',
        error_code: 'REPLAY_ALREADY_DELIVERED',
      })
      .mockResolvedValueOnce({ id: 7, outcome: 'replayed', message: 'ok' })

    renderPage(['/governance/replay?id=7'])
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-action-execute'))
    await user.click(await screen.findByTestId('replay-center-execute-dialog-confirm'))

    await waitFor(() => expect(execSpy).toHaveBeenCalledTimes(1))
    expect(execSpy).toHaveBeenLastCalledWith(7)
    const dialog = await screen.findByTestId('replay-center-execute-dialog')
    expect(dialog).toHaveTextContent('already delivered')
    expect(screen.getByTestId('replay-center-execute-dialog-confirm')).toHaveTextContent(/Replay anyway/)

    await user.click(screen.getByTestId('replay-center-execute-dialog-confirm'))
    await waitFor(() => expect(execSpy).toHaveBeenCalledTimes(2))
    expect(execSpy).toHaveBeenLastCalledWith(7, { allowRedelivery: true })
  })

  it('explains superseded jobs and shows the repeat count (E-113, E-114)', async () => {
    const superseded = {
      ...sampleEntry,
      status: 'DISCARDED' as const,
      outcome: 'Discarded' as const,
      occurrence_count: 5,
      status_note: 'These events were later delivered to this destination automatically.',
    }
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      replay_events: [superseded],
      queue_count: 0,
      failed_count: 0,
      recent_count: 0,
    })
    vi.spyOn(gdcGovernanceReplay, 'fetchGovernanceReplayDetail').mockResolvedValue({
      ...sampleDetail,
      entry: superseded,
      can_execute: false,
      can_discard: false,
    })
    renderPage()
    expect(await screen.findByTestId('replay-occurrences-7')).toHaveTextContent('\u00d75')
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('replay-row-7'))
    expect(await screen.findByTestId('replay-status-note')).toHaveTextContent('delivered to this destination automatically')
    expect(screen.queryByTestId('replay-action-execute')).not.toBeInTheDocument()
    expect(screen.queryByTestId('replay-action-discard')).not.toBeInTheDocument()
  })
})
