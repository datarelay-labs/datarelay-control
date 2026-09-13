import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceQuarantine from '../../api/gdcGovernanceQuarantine'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcStreams from '../../api/gdcStreams'
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
  related_replay: [],
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

function renderPage() {
  return render(
    <MemoryRouter>
      <QuarantineCenterPage />
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

  it('renders quarantine table', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 1,
      quarantine_events: [sampleEntry],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-center-page')).toBeInTheDocument()
    expect(await screen.findByTestId('quarantine-table')).toBeInTheDocument()
    expect(await screen.findByTestId('quarantine-row-42')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-row-42')).toHaveTextContent('Malop API')
    expect(screen.getByTestId('quarantine-row-42')).toHaveTextContent('QUARANTINED')
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

  it('opens investigation drawer with root cause strip', async () => {
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
    expect(screen.getByTestId('quarantine-section-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-section-why')).toBeInTheDocument()
    expect(screen.getByTestId('quarantine-action-release')).toBeInTheDocument()
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

  it('renders filters', async () => {
    vi.spyOn(gdcGovernanceQuarantine, 'fetchGovernanceQuarantineEvents').mockResolvedValue({
      window: '24h',
      total: 0,
      quarantine_events: [],
    })

    renderPage()

    expect(await screen.findByTestId('quarantine-filters')).toBeInTheDocument()
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
})
