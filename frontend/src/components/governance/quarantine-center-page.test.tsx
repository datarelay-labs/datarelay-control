import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceQuarantine from '../../api/gdcGovernanceQuarantine'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcStreams from '../../api/gdcStreams'
import { NAV_PATH } from '../../config/nav-paths'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { QuarantineCenterPage } from './quarantine-center-page'

const sampleEntry: gdcGovernanceQuarantine.GovernanceQuarantineEntry = {
  id: 42,
  policy_id: 1,
  policy_name: 'Customer PII Policy',
  stream_id: 10,
  stream_name: 'Malop API',
  classification: 'RESTRICTED',
  severity: 'HIGH',
  reason: 'Policy Rule — Customer PII Policy',
  status: 'QUARANTINED',
  quarantined_at: '2026-06-06T10:00:00Z',
  violation_id: 'q-42',
}

const sampleDetail: gdcGovernanceQuarantine.GovernanceQuarantineDetailResponse = {
  entry: sampleEntry,
  policy_summary: {
    policy_id: 1,
    policy_name: 'Customer PII Policy',
    policy_status: 'ACTIVE',
    policy_version: 3,
    rule_summary: 'IF classification = RESTRICTED THEN quarantine',
  },
  violation_reason: sampleEntry.reason,
  classification: 'RESTRICTED',
  sensitive_findings: [{ field_path: '$.user.email', sensitivity_class: 'PII', status: 'open' }],
  protection_actions: [{ field_path: '$.user.email', sensitivity_class: 'PII', protection_mode: 'TOKENIZATION' }],
  policy_decision: { action: 'QUARANTINE', summary: 'IF classification = RESTRICTED THEN quarantine' },
  related_replay: [
    {
      replay_event_id: 7,
      status: 'PENDING',
      event_count: 1,
      last_replay_at: null,
    },
  ],
  related_violation: { violation_id: 'q-42', status: 'QUARANTINED', reason: sampleEntry.reason },
  related_quarantine: {
    quarantine_event_id: 42,
    quarantine_source: 'policy',
    event_count: 1,
    created_at: '2026-06-06T10:00:00Z',
    updated_at: '2026-06-06T10:00:00Z',
    released_at: null,
    released_by: null,
  },
  quarantine_metadata: {
    quarantine_event_id: 42,
    quarantine_source: 'policy',
    event_count: 1,
    created_at: '2026-06-06T10:00:00Z',
    updated_at: '2026-06-06T10:00:00Z',
    released_at: null,
    released_by: null,
  },
  root_cause_strip: {
    detected: 'PII',
    action: 'TOKENIZE',
    policy: 'Customer PII Policy',
    result: 'QUARANTINE',
    summary: 'Detected: PII → Action: TOKENIZE → Policy: Customer PII Policy → Result: QUARANTINE',
  },
}

function renderPage(initialEntry = '/governance/quarantine') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/governance/quarantine" element={<QuarantineCenterPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('QuarantineCenterPage', () => {
  beforeEach(() => {
    clearTestSession()
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [{ id: 1, name: 'Customer PII Policy' } as gdcGovernancePolicies.GovernancePolicyEntry],
    })
    vi.spyOn(gdcStreams, 'fetchStreamsList').mockResolvedValue([{ id: 10, name: 'Malop API' } as gdcStreams.StreamRead])
  })

  it('renders SaaS hierarchy and quarantine table', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-center-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Quarantine Center/i })).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-scan-summary')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-count-held')).toHaveTextContent('1')
    expect(screen.getByTestId('quarantine-count-high')).toHaveTextContent('1')
    expect(await screen.findByTestId('quarantine-table')).toBeInTheDocument()
    expect(await screen.findByTestId('quarantine-row-42')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-row-42')).toHaveTextContent('Malop API')
    expect(screen.getByTestId('quarantine-row-42')).toHaveTextContent('Quarantined')
    expect(screen.getByTestId('quarantine-row-42')).toHaveAttribute(
      'aria-label',
      'Investigate Customer PII Policy quarantine on Malop API',
    )
  })

  it('shows empty state when no events', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No quarantined events found/i)).toBeInTheDocument()
  })

  it('shows no-match state when filters return empty', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage()
    const user = userEvent.setup()

    expect(await screen.findByTestId('quarantine-filters')).toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('quarantine-filter-severity'), 'HIGH')

    expect(await screen.findByTestId('quarantine-no-match-state')).toBeInTheDocument()
    expect(screen.getByText(/No quarantined events match these filters/i)).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-clear-filters')).toBeInTheDocument()
  })

  it('opens investigation drawer with root cause strip and related evidence', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()

    await user.click(await screen.findByTestId('quarantine-row-42'))

    await waitFor(() => {
      expect(screen.getByTestId('quarantine-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.getByTestId('quarantine-root-cause-strip')).toHaveTextContent('Detected: PII')
    expect(screen.getByTestId('quarantine-matched-rule')).toHaveTextContent(
      /IF classification = RESTRICTED THEN quarantine/i,
    )
    expect(screen.getByTestId('quarantine-section-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-section-why')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-sensitive-findings')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-protection-actions')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-related-evidence')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-open-violation')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceViolations}?id=q-42`,
    )
    expect(screen.getByTestId('quarantine-related-replay-link')).toHaveAttribute(
      'href',
      `${NAV_PATH.governanceReplay}?id=7`,
    )
    expect(screen.getByTestId('quarantine-view-logs')).toHaveTextContent(/View delivery records/i)
    expect(screen.getByTestId('quarantine-action-release')).toBeInTheDocument()
  })

  it('opens investigation from ?id deep link without requiring a table row click', async () => {
    const detailSpy = vi
      .spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineDetail')
      .mockResolvedValue(sampleDetail)
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage('/governance/quarantine?id=42')

    await waitFor(() => {
      expect(screen.getByTestId('quarantine-detail-drawer')).toBeInTheDocument()
    })
    expect(detailSpy).toHaveBeenCalledWith(42, expect.any(String))
    expect(screen.getByTestId('quarantine-matched-rule')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-action-release')).toBeInTheDocument()
  })

  it('supports keyboard activation of a quarantine row', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineDetail').mockResolvedValue(sampleDetail)

    renderPage()
    const user = userEvent.setup()
    const row = await screen.findByTestId('quarantine-row-42')
    row.focus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.getByTestId('quarantine-detail-drawer')).toBeInTheDocument()
    })
  })

  it('shows connector operator read-only banner', async () => {
    clearTestSession()
    persistTestSession('CONNECTOR_OPERATOR')
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-read-only-banner')).toHaveTextContent(
      /Governance write actions require Governance Operator role/i,
    )
    expect(screen.queryByTestId('quarantine-bulk-release')).not.toBeInTheDocument()
  })

  it('renders filters with accessible labels', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-filters')).toBeInTheDocument()
    expect(screen.getByLabelText('Time range')).toBeInTheDocument()
    expect(screen.getByLabelText('Policy')).toBeInTheDocument()
    expect(screen.getByLabelText('Stream')).toBeInTheDocument()
    expect(screen.getByLabelText('Classification')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-filter-policy')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-filter-stream')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-filter-classification')).toBeInTheDocument()
  })

  it('opens confirmation dialog before discard from investigation drawer', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineDetail').mockResolvedValue(sampleDetail)
    const discardSpy = vi.spyOn(gdcGovernanceQuarantine, 'discardGovernanceQuarantineEvents').mockResolvedValue({
      total: 1,
      succeeded: 1,
      failed: 0,
      results: [{ id: 42, outcome: 'discarded', message: 'ok' }],
    })

    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('quarantine-row-42'))
    await waitFor(() => expect(screen.getByTestId('quarantine-action-discard')).toBeInTheDocument())
    await user.click(screen.getByTestId('quarantine-action-discard'))
    expect(await screen.findByTestId('quarantine-center-discard-dialog')).toBeInTheDocument()
    expect(discardSpy).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('quarantine-center-discard-dialog-confirm'))
    await waitFor(() => expect(discardSpy).toHaveBeenCalled())
  })

  it('hides release and discard actions for viewer sessions', async () => {
    clearTestSession()
    persistTestSession('VIEWER', 'viewer')
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineDetail').mockResolvedValue(sampleDetail)

    renderPage('/governance/quarantine?id=42')

    expect(await screen.findByTestId('quarantine-read-only-banner')).toBeInTheDocument()
    expect(within(screen.getByTestId('quarantine-read-only-banner')).getByText(/Read-only view/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('quarantine-detail-drawer')).toBeInTheDocument())
    expect(screen.queryByTestId('quarantine-action-release')).not.toBeInTheDocument()
    expect(screen.queryByTestId('quarantine-bulk-release')).not.toBeInTheDocument()
  })
})
