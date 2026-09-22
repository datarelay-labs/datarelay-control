import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceAudit from '../../api/gdcGovernanceAudit'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcStreams from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { NAV_PATH } from '../../config/nav-paths'
import { PERSONA_STORAGE_KEY } from '../../utils/persona-mode'
import { AuditTrailPage } from './audit-trail-page'

const sampleEvent: gdcGovernanceAudit.GovernanceAuditEntry = {
  event_time: '2026-06-06T10:00:00Z',
  policy_id: 1,
  policy_name: 'Customer Data Protection',
  stream_id: 10,
  stream_name: 'Malop API',
  event_type: 'QUARANTINE_CREATED',
  status: 'QUARANTINED',
  correlation_id: 'q-42',
}

const openEvent: gdcGovernanceAudit.GovernanceAuditEntry = {
  ...sampleEvent,
  event_type: 'VIOLATION_CREATED',
  status: 'OPEN',
  correlation_id: 'q-41',
}

const sampleDetail: gdcGovernanceAudit.GovernanceAuditDetailResponse = {
  correlation_id: 'q-42',
  policy_id: 1,
  policy_name: 'Customer Data Protection',
  stream_id: 10,
  stream_name: 'Malop API',
  current_status: 'DELIVERED',
  outcome: 'DELIVERED',
  timeline: [
    {
      event_time: '2026-06-06T10:00:00Z',
      event_type: 'VIOLATION_CREATED',
      summary: 'Violation detected',
      actor: 'System',
    },
    {
      event_time: '2026-06-06T10:00:00Z',
      event_type: 'QUARANTINE_CREATED',
      summary: 'Quarantined',
      actor: 'System',
    },
    {
      event_time: '2026-06-06T10:05:00Z',
      event_type: 'QUARANTINE_RELEASED',
      summary: 'Released',
      actor: 'operator@gdc',
    },
    {
      event_time: '2026-06-06T10:06:00Z',
      event_type: 'REPLAY_COMPLETED',
      summary: 'Replay completed',
      actor: 'operator@gdc',
    },
  ],
  related_violation: {
    violation_id: 'q-42',
    status: 'REPLAYED',
    reason: 'Response rule matched',
  },
  related_quarantine: {
    quarantine_event_id: 42,
    status: 'released',
  },
  related_replay: {
    replay_event_id: 7,
    status: 'replayed',
    event_count: 2,
  },
}

function SearchParamsProbe() {
  const [params] = useSearchParams()
  return <div data-testid="search-params">{params.toString()}</div>
}

function renderPage(initialEntries = ['/governance/audit']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/governance/audit"
          element={
            <>
              <SearchParamsProbe />
              <AuditTrailPage />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AuditTrailPage', () => {
  beforeEach(() => {
    localStorage.setItem(PERSONA_STORAGE_KEY, 'governance')
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [{ id: 1, name: 'Customer Data Protection' } as gdcGovernancePolicies.GovernancePolicyEntry],
    })
    vi.spyOn(gdcStreams, 'fetchStreamsList').mockResolvedValue([
      { id: 10, name: 'Malop API' } as StreamRead,
    ])
  })

  it('renders lifecycle-first hierarchy and audit table', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 2,
      events: [sampleEvent, openEvent],
    })

    renderPage()

    expect(await screen.findByTestId('audit-trail-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Governance Audit/i })).toBeInTheDocument()
    expect(screen.getByTestId('audit-scan-summary')).toBeInTheDocument()
    expect(screen.getByTestId('audit-count-quarantined')).toHaveTextContent('1')
    expect(screen.getByTestId('audit-count-open-like')).toHaveTextContent('1')
    expect(screen.getByTestId('audit-filters-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('audit-table')).toBeInTheDocument()
    const row = await screen.findByTestId('audit-row-q-42-QUARANTINE_CREATED')
    expect(row).toHaveTextContent('Malop API')
    expect(row).toHaveTextContent('q-42')
    expect(row).toHaveTextContent('Quarantined')
  })

  it('shows empty state when no events', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      events: [],
    })

    renderPage()

    expect(await screen.findByTestId('audit-empty-state')).toBeInTheDocument()
    expect(screen.getByText('No governance audit events found')).toBeInTheDocument()
  })

  it('shows no-match state when filters exclude all events', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      events: [],
    })

    renderPage()
    const user = userEvent.setup()

    await user.selectOptions(await screen.findByTestId('audit-filter-status'), 'FAILED')

    expect(await screen.findByTestId('audit-no-match-state')).toBeInTheDocument()
    expect(screen.getByTestId('audit-no-match-clear')).toBeInTheDocument()
  })

  it('shows error state when audit APIs are unavailable', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue(null)

    renderPage()

    expect(await screen.findByTestId('audit-error')).toHaveTextContent('Governance audit APIs unavailable.')
  })

  it('opens timeline drawer with status, outcome, and exact-id related links', async () => {
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      events: [sampleEvent],
    })
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditDetail').mockResolvedValue(sampleDetail)

    renderPage()
    await user.click(await screen.findByTestId('audit-row-q-42-QUARANTINE_CREATED'))

    expect(await screen.findByTestId('audit-detail-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('audit-section-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('audit-section-why')).toBeInTheDocument()
    expect(screen.getByTestId('audit-section-related')).toBeInTheDocument()
    expect(screen.getByTestId('audit-detail-correlation')).toHaveTextContent('q-42')
    expect(screen.getByTestId('audit-detail-status')).toHaveTextContent('Delivered')
    expect(screen.getByTestId('audit-detail-outcome')).toHaveTextContent('DELIVERED')
    expect(screen.getAllByText('Violation detected').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Replay completed').length).toBeGreaterThan(0)
    expect(screen.getAllByText('By operator@gdc').length).toBeGreaterThan(0)

    expect(screen.getByTestId('audit-open-violations')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceViolations}?id=q-42`,
    )
    expect(screen.getByTestId('audit-open-quarantine')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceQuarantine}?id=42`,
    )
    expect(screen.getByTestId('audit-open-replay')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceReplay}?id=7`,
    )
    expect(screen.getByTestId('audit-related-violation-link')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceViolations}?id=q-42`,
    )
    expect(screen.getByTestId('audit-related-quarantine-link')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceQuarantine}?id=42`,
    )
    expect(screen.getByTestId('audit-related-replay-link')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceReplay}?id=7`,
    )
    expect(screen.getByTestId('search-params')).toHaveTextContent('correlation=q-42')
  })

  it('opens investigation from ?correlation deep link without requiring a table row click', async () => {
    const detailSpy = vi
      .spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditDetail')
      .mockResolvedValue(sampleDetail)
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      events: [],
    })

    renderPage(['/governance/audit?correlation=q-42'])

    await waitFor(() => {
      expect(screen.getByTestId('audit-detail-drawer')).toBeInTheDocument()
    })
    expect(detailSpy).toHaveBeenCalledWith('q-42', '7d')
    expect(screen.getByTestId('audit-detail-correlation')).toHaveTextContent('q-42')
  })

  it('synchronizes open/close URL with ?correlation while preserving unrelated params', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      events: [sampleEvent],
    })
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditDetail').mockResolvedValue(sampleDetail)

    renderPage(['/governance/audit?window=7d'])
    const user = userEvent.setup()

    await waitFor(() => {
      expect(screen.getByTestId('search-params')).toHaveTextContent('window=7d')
    })

    await user.click(await screen.findByTestId('audit-row-q-42-QUARANTINE_CREATED'))
    await waitFor(() => {
      expect(screen.getByTestId('audit-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('search-params').textContent).toMatch(/correlation=q-42/)
    expect(screen.getByTestId('search-params').textContent).toMatch(/window=7d/)

    await user.click(screen.getByTestId('audit-detail-close'))
    await waitFor(() => {
      expect(screen.queryByTestId('audit-detail-drawer')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('search-params').textContent).not.toMatch(/correlation=/)
    expect(screen.getByTestId('search-params').textContent).toMatch(/window=7d/)
  })

  it('supports keyboard activation of an audit row', async () => {
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      events: [sampleEvent],
    })
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    const row = await screen.findByTestId('audit-row-q-42-QUARANTINE_CREATED')
    row.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByTestId('audit-detail-drawer')).toBeInTheDocument()
    expect(screen.getByTestId('search-params')).toHaveTextContent('correlation=q-42')
  })

  it('closes drawer', async () => {
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      events: [sampleEvent],
    })
    vi.spyOn(gdcGovernanceAudit, 'fetchGovernanceAuditDetail').mockResolvedValue(sampleDetail)

    renderPage()
    await user.click(await screen.findByTestId('audit-row-q-42-QUARANTINE_CREATED'))
    await screen.findByTestId('audit-detail-drawer')
    await user.click(screen.getByTestId('audit-detail-close'))

    await waitFor(() => {
      expect(screen.queryByTestId('audit-detail-drawer')).not.toBeInTheDocument()
    })
  })
})
