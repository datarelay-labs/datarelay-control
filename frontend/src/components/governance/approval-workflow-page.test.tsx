import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceApprovals from '../../api/gdcGovernanceApprovals'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { ApprovalWorkflowPage } from './approval-workflow-page'

const sampleQueueEntry: gdcGovernanceApprovals.GovernanceApprovalQueueEntry = {
  policy_id: 7,
  policy_name: 'Employee PII Protection',
  policy_status: 'REVIEW',
  approval_status: 'PENDING_REVIEW',
  requester: 'Governance Operator',
  reviewer: null,
  submitted_at: '2026-06-06T09:00:00Z',
  last_action: 'SUBMITTED_FOR_REVIEW',
  last_action_at: '2026-06-06T09:00:00Z',
  last_comment: 'Please review',
  impact_label: 'No impact data',
}

const sampleDetail: gdcGovernanceApprovals.GovernanceApprovalDetailResponse = {
  policy: {
    id: 7,
    name: 'Employee PII Protection',
    description: 'Protect employee PII',
    category: 'DATA_PROTECTION',
    status: 'REVIEW',
    version: 2,
    assigned_stream_count: 1,
    assigned_stream_ids: [10],
  },
  current_status: 'REVIEW',
  approval_status: 'PENDING_REVIEW',
  requester: 'Governance Operator',
  reviewer: null,
  submitted_at: '2026-06-06T09:00:00Z',
  review_comment: 'Please review',
  is_approved: false,
  history: [
    {
      event_time: '2026-06-06T09:00:00Z',
      event_type: 'SUBMITTED_FOR_REVIEW',
      actor: 'Governance Operator',
      comment: 'Please review',
    },
  ],
  impact: { impact_data_available: false, impact_matched_events: null, impact_summary: null, affected_stream_count: 1 },
  simulation: { simulation_available: false, dry_run_summary: null, action_breakdown: {} },
}

const approvedDetail: gdcGovernanceApprovals.GovernanceApprovalDetailResponse = {
  ...sampleDetail,
  approval_status: 'APPROVED',
  is_approved: true,
  reviewer: 'Senior Reviewer',
  history: [
    ...sampleDetail.history,
    {
      event_time: '2026-06-06T10:00:00Z',
      event_type: 'APPROVED',
      actor: 'Senior Reviewer',
      comment: 'Approved',
    },
  ],
}

const draftDetail: gdcGovernanceApprovals.GovernanceApprovalDetailResponse = {
  ...sampleDetail,
  policy: { ...sampleDetail.policy, status: 'DRAFT' },
  current_status: 'DRAFT',
  approval_status: 'DRAFT',
  requester: null,
  submitted_at: null,
  is_approved: false,
  history: [],
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ApprovalWorkflowPage />
    </MemoryRouter>,
  )
}

describe('ApprovalWorkflowPage', () => {
  beforeEach(() => {
    clearTestSession()
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
  })

  it('renders approval queue table', async () => {
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [sampleQueueEntry],
    })

    renderPage()

    expect(await screen.findByTestId('approval-workflow-page')).toBeInTheDocument()
    expect(await screen.findByTestId('approval-table')).toBeInTheDocument()
    expect(await screen.findByTestId('approval-row-7')).toBeInTheDocument()
    expect(screen.getByTestId('approval-row-7')).toHaveTextContent('Employee PII Protection')
  })

  it('shows empty state when queue is empty', async () => {
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 0,
      approvals: [],
    })

    renderPage()

    expect(await screen.findByTestId('approval-empty-state')).toBeInTheDocument()
    expect(screen.getByText(/No policies in the approval queue/i)).toBeInTheDocument()
  })

  it('keeps approval filter menus visually discoverable in light and dark themes', async () => {
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 0,
      approvals: [],
    })

    renderPage()
    await screen.findByTestId('approval-empty-state')

    const filters = [
      screen.getByTestId('approval-filter-window'),
      screen.getByTestId('approval-filter-status'),
      screen.getByTestId('approval-filter-requester'),
      screen.getByTestId('approval-filter-reviewer'),
    ]

    for (const filter of filters) {
      expect(filter).toHaveClass('appearance-none')
      expect(filter).toHaveClass('cursor-pointer')
      expect(filter).toHaveClass('dark:bg-gdc-input')
      expect(filter).toHaveClass('dark:border-gdc-borderStrong')
      expect(filter).toHaveClass('dark:text-gdc-foreground')
    }
  })

  it('opens detail drawer on row click', async () => {
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [sampleQueueEntry],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))

    expect(await screen.findByTestId('approval-detail-drawer')).toBeInTheDocument()
    expect(await screen.findByTestId('approval-section-policy-summary')).toHaveTextContent('Employee PII Protection')
    expect(screen.getByTestId('approval-action-approve')).toBeInTheDocument()
    expect(screen.getByTestId('approval-action-reject')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-action-activate')).not.toBeInTheDocument()
  })

  it('shows activate button when policy is approved', async () => {
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [{ ...sampleQueueEntry, approval_status: 'APPROVED' }],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(approvedDetail)

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))

    expect(await screen.findByTestId('approval-action-activate')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-action-approve')).not.toBeInTheDocument()
  })

  it('shows submit button for draft policy', async () => {
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [{ ...sampleQueueEntry, policy_status: 'DRAFT', approval_status: 'DRAFT' }],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(draftDetail)

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))

    expect(await screen.findByTestId('approval-action-submit')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-action-approve')).not.toBeInTheDocument()
  })

  it('shows read-only banner for connector operator', async () => {
    clearTestSession()
    persistTestSession('CONNECTOR_OPERATOR')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 0,
      approvals: [],
    })

    renderPage()

    expect(await screen.findByTestId('approval-connector-banner')).toBeInTheDocument()
    expect(screen.getByText(/Governance write actions require Governance Operator role/i)).toBeInTheDocument()
  })

  it('hides action buttons for connector operator in drawer', async () => {
    clearTestSession()
    persistTestSession('CONNECTOR_OPERATOR')
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [sampleQueueEntry],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))

    await waitFor(() => {
      expect(screen.getByTestId('approval-detail-drawer')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('approval-action-approve')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-action-reject')).not.toBeInTheDocument()
  })
})
