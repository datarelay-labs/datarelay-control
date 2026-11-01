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
    persistTestSession('GOVERNANCE_REVIEWER')
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
    persistTestSession('GOVERNANCE_APPROVER')
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

  it('does not offer Activate to a role that cannot activate and says who can (F-204)', async () => {
    persistTestSession('GOVERNANCE_REVIEWER')
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [{ ...sampleQueueEntry, approval_status: 'APPROVED' }],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(approvedDetail)

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))

    expect(await screen.findByTestId('approval-activate-role-note')).toHaveTextContent(/Governance Approver/)
    expect(screen.queryByTestId('approval-action-activate')).not.toBeInTheDocument()
  })

  it('shows a readable error when an approval action is refused (F-204)', async () => {
    persistTestSession('GOVERNANCE_APPROVER')
    const user = userEvent.setup()
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({
      window: '24h',
      total: 1,
      approvals: [{ ...sampleQueueEntry, approval_status: 'APPROVED' }],
    })
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(approvedDetail)
    vi.spyOn(gdcGovernanceApprovals, 'activateGovernanceApproval').mockRejectedValue(new Error('Policy activation is not permitted for this role'))

    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))
    await user.click(await screen.findByTestId('approval-action-activate'))

    expect(await screen.findByTestId('approval-action-error')).toHaveTextContent(/Action failed: Policy activation is not permitted/)
  })

  it('says a Viewer lacks access instead of showing an empty approval queue (F-204)', async () => {
    persistTestSession('VIEWER')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue({ window: '24h', total: 0, approvals: [] })

    renderPage()

    expect(await screen.findByTestId('approval-access-denied')).toHaveTextContent(/Viewer role does not have access/)
    expect(screen.queryByText(/No policies in the approval queue/i)).not.toBeInTheDocument()
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

describe('ApprovalWorkflowPage separation of duties (F-187)', () => {
  const queue = (approval_status: string) => ({
    window: '24h' as const,
    total: 1,
    approvals: [{ ...sampleQueueEntry, approval_status }],
  })

  beforeEach(() => {
    clearTestSession()
    vi.restoreAllMocks()
  })

  async function openRow() {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('approval-row-7'))
    return user
  }

  it('asks for confirmation before the submitter approves their own policy, and Cancel sends nothing', async () => {
    persistTestSession('GOVERNANCE_REVIEWER', 'Governance Operator')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
    const approve = vi.spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy').mockResolvedValue({
      policy_id: 7,
      policy_status: 'REVIEW',
      approval_status: 'APPROVED',
      event_type: 'APPROVED',
      message: 'Policy approved',
    })

    const user = await openRow()
    expect(await screen.findByTestId('approval-self-approval-note')).toBeInTheDocument()
    await user.click(await screen.findByTestId('approval-action-approve'))

    const dialog = await screen.findByTestId('approval-self-approval-dialog')
    expect(dialog).toHaveTextContent('Approve your own submission?')
    expect(dialog).toHaveTextContent('Employee PII Protection')
    expect(approve).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('approval-self-approval-dialog-cancel'))
    expect(screen.queryByTestId('approval-self-approval-dialog')).not.toBeInTheDocument()
    expect(approve).not.toHaveBeenCalled()
  })

  it('sends the explicit override only after the submitter confirms', async () => {
    persistTestSession('GOVERNANCE_REVIEWER', 'governance operator')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
    const approve = vi.spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy').mockResolvedValue({
      policy_id: 7,
      policy_status: 'REVIEW',
      approval_status: 'APPROVED',
      event_type: 'APPROVED',
      message: 'Policy approved',
    })

    const user = await openRow()
    await user.click(await screen.findByTestId('approval-action-approve'))
    await user.click(await screen.findByTestId('approval-self-approval-dialog-confirm'))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve).toHaveBeenCalledWith(7, '', { allowSelfApproval: true })
    expect(screen.queryByTestId('approval-self-approval-dialog')).not.toBeInTheDocument()
  })

  it('asks for confirmation before the submitter activates their own approved policy', async () => {
    persistTestSession('GOVERNANCE_APPROVER', 'Governance Operator')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('APPROVED'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(approvedDetail)
    const activate = vi.spyOn(gdcGovernanceApprovals, 'activateGovernanceApproval').mockResolvedValue({
      policy_id: 7,
      policy_status: 'ACTIVE',
      approval_status: 'ACTIVATED',
      event_type: 'ACTIVATED',
      message: 'Policy activated',
    })

    const user = await openRow()
    await user.click(await screen.findByTestId('approval-action-activate'))

    expect(await screen.findByTestId('approval-self-approval-dialog')).toHaveTextContent('Activate your own policy?')
    expect(activate).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('approval-self-approval-dialog-confirm'))
    await waitFor(() => expect(activate).toHaveBeenCalledWith(7, '', { allowSelfApproval: true }))
  })

  it('does not interrupt a different user: approve and activate go straight through without an override', async () => {
    persistTestSession('GOVERNANCE_APPROVER', 'someone-else')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
    const approve = vi.spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy').mockResolvedValue({
      policy_id: 7,
      policy_status: 'REVIEW',
      approval_status: 'APPROVED',
      event_type: 'APPROVED',
      message: 'Policy approved',
    })

    const user = await openRow()
    expect(screen.queryByTestId('approval-self-approval-note')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId('approval-action-approve'))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
    expect(approve).toHaveBeenCalledWith(7, '')
    expect(screen.queryByTestId('approval-self-approval-dialog')).not.toBeInTheDocument()
  })

  it('lets the submitter reject their own submission without a dialog', async () => {
    persistTestSession('GOVERNANCE_REVIEWER', 'Governance Operator')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
    const reject = vi.spyOn(gdcGovernanceApprovals, 'rejectGovernancePolicy').mockResolvedValue({
      policy_id: 7,
      policy_status: 'DRAFT',
      approval_status: 'REJECTED',
      event_type: 'REJECTED',
      message: 'Policy returned to draft',
    })

    const user = await openRow()
    await user.click(await screen.findByTestId('approval-action-reject'))

    await waitFor(() => expect(reject).toHaveBeenCalledWith(7, ''))
    expect(screen.queryByTestId('approval-self-approval-dialog')).not.toBeInTheDocument()
  })

  it('falls back to the dialog when the server reports a self-approval the UI did not predict', async () => {
    persistTestSession('GOVERNANCE_REVIEWER', 'alias-of-the-requester')
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
    vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
    const approve = vi
      .spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy')
      .mockRejectedValueOnce(
        new Error('403: [GOVERNANCE_SELF_APPROVAL_FORBIDDEN] you submitted this policy for review'),
      )
      .mockResolvedValue({
        policy_id: 7,
        policy_status: 'REVIEW',
        approval_status: 'APPROVED',
        event_type: 'APPROVED',
        message: 'Policy approved',
      })

    const user = await openRow()
    await user.click(await screen.findByTestId('approval-action-approve'))

    expect(await screen.findByTestId('approval-self-approval-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-action-error')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('approval-self-approval-dialog-confirm'))

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
    expect(approve).toHaveBeenLastCalledWith(7, '', { allowSelfApproval: true })
  })

  describe('submitter not recorded (fail-closed)', () => {
    const unknownDetail: gdcGovernanceApprovals.GovernanceApprovalDetailResponse = {
      ...sampleDetail,
      requester: null,
      submitted_at: null,
      submitter_unknown: true,
      history: [],
    }
    const approved = {
      policy_id: 7,
      policy_status: 'REVIEW' as const,
      approval_status: 'APPROVED',
      event_type: 'APPROVED' as const,
      message: 'Policy approved',
    }

    it('explains the situation and asks for confirmation before approving; Cancel sends nothing', async () => {
      persistTestSession('GOVERNANCE_REVIEWER', 'someone-else')
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(unknownDetail)
      const approve = vi.spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy').mockResolvedValue(approved)

      const user = await openRow()
      expect(await screen.findByTestId('approval-submitter-unknown-note')).toHaveTextContent('Nobody is recorded')
      expect(screen.queryByTestId('approval-self-approval-note')).not.toBeInTheDocument()
      await user.click(await screen.findByTestId('approval-action-approve'))

      const dialog = await screen.findByTestId('approval-submitter-unknown-dialog')
      expect(dialog).toHaveTextContent('Approve without a recorded submitter?')
      expect(dialog).toHaveTextContent('Employee PII Protection')
      expect(approve).not.toHaveBeenCalled()

      await user.click(screen.getByTestId('approval-submitter-unknown-dialog-cancel'))
      expect(screen.queryByTestId('approval-submitter-unknown-dialog')).not.toBeInTheDocument()
      expect(approve).not.toHaveBeenCalled()
    })

    it('sends the explicit override only after the user confirms approving', async () => {
      persistTestSession('GOVERNANCE_REVIEWER', 'someone-else')
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(unknownDetail)
      const approve = vi.spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy').mockResolvedValue(approved)

      const user = await openRow()
      await user.click(await screen.findByTestId('approval-action-approve'))
      await user.click(await screen.findByTestId('approval-submitter-unknown-dialog-confirm'))

      await waitFor(() => expect(approve).toHaveBeenCalledTimes(1))
      expect(approve).toHaveBeenCalledWith(7, '', { allowSelfApproval: true })
    })

    it('asks for confirmation before activating an approved policy with no recorded submitter', async () => {
      persistTestSession('GOVERNANCE_APPROVER', 'someone-else')
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('APPROVED'))
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue({
        ...unknownDetail,
        approval_status: 'APPROVED',
        is_approved: true,
      })
      const activate = vi.spyOn(gdcGovernanceApprovals, 'activateGovernanceApproval').mockResolvedValue({
        policy_id: 7,
        policy_status: 'ACTIVE',
        approval_status: 'ACTIVATED',
        event_type: 'ACTIVATED',
        message: 'Policy activated',
      })

      const user = await openRow()
      await user.click(await screen.findByTestId('approval-action-activate'))

      expect(await screen.findByTestId('approval-submitter-unknown-dialog')).toHaveTextContent(
        'Activate without a recorded submitter?',
      )
      expect(activate).not.toHaveBeenCalled()
      await user.click(screen.getByTestId('approval-submitter-unknown-dialog-confirm'))
      await waitFor(() => expect(activate).toHaveBeenCalledWith(7, '', { allowSelfApproval: true }))
    })

    it('lets the reviewer reject without any confirmation', async () => {
      persistTestSession('GOVERNANCE_REVIEWER', 'someone-else')
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(unknownDetail)
      const reject = vi.spyOn(gdcGovernanceApprovals, 'rejectGovernancePolicy').mockResolvedValue({
        policy_id: 7,
        policy_status: 'DRAFT',
        approval_status: 'REJECTED',
        event_type: 'REJECTED',
        message: 'Policy returned to draft',
      })

      const user = await openRow()
      await user.click(await screen.findByTestId('approval-action-reject'))

      await waitFor(() => expect(reject).toHaveBeenCalledWith(7, ''))
      expect(screen.queryByTestId('approval-submitter-unknown-dialog')).not.toBeInTheDocument()
    })

    it('falls back to the dialog when only the server reports the unknown submitter', async () => {
      persistTestSession('GOVERNANCE_REVIEWER', 'someone-else')
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovals').mockResolvedValue(queue('PENDING_REVIEW'))
      vi.spyOn(gdcGovernanceApprovals, 'fetchGovernanceApprovalDetail').mockResolvedValue(sampleDetail)
      const approve = vi
        .spyOn(gdcGovernanceApprovals, 'approveGovernancePolicy')
        .mockRejectedValueOnce(new Error('403: [GOVERNANCE_SUBMITTER_UNKNOWN] the submitter is not recorded'))
        .mockResolvedValue(approved)

      const user = await openRow()
      await user.click(await screen.findByTestId('approval-action-approve'))

      expect(await screen.findByTestId('approval-submitter-unknown-dialog')).toBeInTheDocument()
      expect(screen.queryByTestId('approval-action-error')).not.toBeInTheDocument()
      await user.click(screen.getByTestId('approval-submitter-unknown-dialog-confirm'))
      await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
      expect(approve).toHaveBeenLastCalledWith(7, '', { allowSelfApproval: true })
    })
  })
})
