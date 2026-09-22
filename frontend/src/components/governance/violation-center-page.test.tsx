import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import { PERSONA_STORAGE_KEY } from '../../hooks/use-persona-mode'
import { ViolationCenterPage } from './violation-center-page'
import * as featureFlags from '../../lib/feature-flags'
import { persistTestSession } from '../../lib/governance-rbac'
import { NAV_PATH } from '../../config/nav-paths'

const sampleViolation: gdcGovernanceViolations.GovernanceViolationEntry = {
  id: 'q-42',
  policy_id: 1,
  policy_name: 'Customer Data Protection',
  stream_id: 10,
  stream_name: 'Malop API',
  event_time: '2026-06-06T10:00:00Z',
  severity: 'HIGH',
  reason: 'Response rule matched: RESTRICTED Rule',
  status: 'QUARANTINED',
  quarantine_event_id: 42,
}

const sampleDetail: gdcGovernanceViolations.GovernanceViolationDetailResponse = {
  violation: sampleViolation,
  policy_summary: {
    policy_id: 1,
    policy_name: 'Customer Data Protection',
    policy_status: 'ACTIVE',
    policy_version: 3,
    rule_summary: 'IF classification = RESTRICTED THEN quarantine',
  },
  related_quarantine: {
    quarantine_event_id: 42,
    status: 'quarantined',
    quarantine_reason: 'policy:RESTRICTED Rule',
    created_at: '2026-06-06T10:00:00Z',
    released_at: null,
  },
  related_replays: [
    {
      replay_event_id: 7,
      status: 'COMPLETED',
      event_count: 3,
      last_replay_at: '2026-06-06T11:00:00Z',
    },
  ],
}

function renderPage(initialEntry = '/governance/violations') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/governance/violations" element={<ViolationCenterPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ViolationCenterPage', () => {
  beforeEach(() => {
    localStorage.setItem(PERSONA_STORAGE_KEY, 'governance')
    persistTestSession('ADMINISTRATOR', 'admin')
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [{ id: 1, name: 'Customer Data Protection' } as gdcGovernancePolicies.GovernancePolicyEntry],
    })
  })

  it('renders SaaS hierarchy and violation table', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [sampleViolation],
    })

    renderPage()

    expect(await screen.findByTestId('violation-center-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Violation Center/i })).toBeInTheDocument()
    expect(screen.getByTestId('violation-scan-summary')).toBeInTheDocument()
    expect(screen.getByTestId('violation-count-high')).toHaveTextContent('1')
    expect(screen.getByTestId('violation-count-open-like')).toHaveTextContent('1')
    expect(await screen.findByTestId('violation-table')).toBeInTheDocument()
    expect(await screen.findByTestId('violation-row-q-42')).toBeInTheDocument()
    expect(screen.getByText('Malop API')).toBeInTheDocument()
    expect(screen.getByTestId('violation-row-q-42')).toHaveTextContent('Quarantined')
    expect(screen.getByTestId('violation-row-q-42')).toHaveAttribute(
      'aria-label',
      'Investigate Customer Data Protection violation on Malop API',
    )
  })

  it('shows empty state when no violations', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    renderPage()

    expect(await screen.findByTestId('violation-empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No policy violations found/i)).toBeInTheDocument()
  })

  it('shows no-match state when filters return empty', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    renderPage()
    const user = userEvent.setup()

    expect(await screen.findByTestId('violation-filters')).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('violation-filter-severity'), 'HIGH')

    expect(await screen.findByTestId('violation-no-match-state')).toBeInTheDocument()
    expect(screen.getByText(/No violations match these filters/i)).toBeInTheDocument()
    expect(screen.getByTestId('violation-clear-filters')).toBeInTheDocument()
  })

  it('renders filters with accessible labels', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    renderPage()

    expect(await screen.findByTestId('violation-filters')).toBeInTheDocument()
    expect(screen.getByLabelText('Time range')).toBeInTheDocument()
    expect(screen.getByLabelText('Policy')).toBeInTheDocument()
    expect(screen.getByLabelText('Severity')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
    expect(screen.getByTestId('violation-filter-window')).toBeInTheDocument()
    expect(screen.getByTestId('violation-filter-policy')).toBeInTheDocument()
    expect(screen.getByTestId('violation-filter-severity')).toBeInTheDocument()
    expect(screen.getByTestId('violation-filter-status')).toBeInTheDocument()
  })

  it('opens detail drawer on row click with policy and related evidence', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [sampleViolation],
    })
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolationDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()

    expect(await screen.findByTestId('violation-row-q-42')).toBeInTheDocument()
    await user.click(screen.getByTestId('violation-row-q-42'))

    await waitFor(() => {
      expect(screen.getByTestId('violation-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('violation-matched-rule')).toHaveTextContent(
      /IF classification = RESTRICTED THEN quarantine/i,
    )
    expect(screen.getByTestId('violation-related-evidence')).toBeInTheDocument()
    expect(screen.getByTestId('violation-related-quarantine-link')).toHaveAttribute(
      'href',
      NAV_PATH.governanceQuarantine,
    )
    expect(screen.getByTestId('violation-related-replay-link')).toHaveAttribute(
      'href',
      NAV_PATH.governanceReplay,
    )
    expect(screen.getByTestId('violation-open-quarantine')).toBeInTheDocument()
    expect(screen.getByTestId('violation-open-replay')).toBeInTheDocument()
    expect(screen.getByTestId('violation-view-logs')).toHaveTextContent(/View delivery records/i)
  })

  it('opens investigation from ?id deep link without requiring a table row click', async () => {
    const detailSpy = vi
      .spyOn(gdcGovernanceViolations, 'fetchGovernanceViolationDetail')
      .mockResolvedValue(sampleDetail)
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    renderPage('/governance/violations?id=q-42')

    await waitFor(() => {
      expect(screen.getByTestId('violation-detail-drawer')).toBeInTheDocument()
    })
    expect(detailSpy).toHaveBeenCalledWith('q-42', expect.any(String))
    expect(screen.getByTestId('violation-matched-rule')).toBeInTheDocument()
    expect(screen.getByTestId('violation-open-quarantine')).toBeInTheDocument()
  })

  it('supports keyboard activation of a violation row', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [sampleViolation],
    })
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolationDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    const row = await screen.findByTestId('violation-row-q-42')
    row.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByTestId('violation-detail-drawer')).toBeInTheDocument()
    })
  })

  it('links policy to approvals in OSS mode instead of Data Protection', async () => {
    vi.spyOn(featureFlags, 'isOssReleaseMode').mockReturnValue(true)
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [sampleViolation],
    })
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolationDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('violation-row-q-42'))
    await waitFor(() => expect(screen.getByTestId('violation-detail-drawer')).toBeInTheDocument())
    const link = screen.getByTestId('violation-open-policy')
    expect(link).toHaveTextContent('View details')
    expect(link).toHaveAttribute('href', '/governance/approvals')
  })

  it('shows read-only banner for viewer sessions', async () => {
    persistTestSession('VIEWER', 'viewer')
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    renderPage()

    expect(await screen.findByTestId('violation-read-only-banner')).toBeInTheDocument()
    expect(within(screen.getByTestId('violation-read-only-banner')).getByText(/Read-only view/i)).toBeInTheDocument()
  })
})
