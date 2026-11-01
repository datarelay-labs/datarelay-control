import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyCatalogPage } from './policy-catalog-page'
import { PolicyEditorDrawer } from './policy-editor-drawer'
import type { GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { PERSONA_STORAGE_KEY } from '../../utils/persona-mode'

const basePolicy: GovernancePolicyEntry = {
  id: 1,
  name: 'Customer Data Protection',
  description: 'PII',
  category: 'DATA_PROTECTION',
  status: 'DRAFT',
  policy_json: {
    conditions: [{ field: 'classification', operator: 'equals', value: 'RESTRICTED' }],
    actions: [{ type: 'quarantine' }],
  },
  version: 1,
  assigned_stream_count: 0,
  assigned_stream_ids: [],
  created_at: '2026-06-05T12:00:00Z',
  updated_at: '2026-06-05T12:00:00Z',
}

const previewMock = {
  policy_id: 0,
  policy_json: basePolicy.policy_json,
  rules: [
    {
      condition_text: 'classification = RESTRICTED',
      action_text: 'quarantine',
      combined: 'IF classification = RESTRICTED THEN quarantine',
    },
  ],
  summary: 'IF classification = RESTRICTED THEN quarantine',
}

const impactMock = {
  window: '24h',
  total_events: 0,
  matched_events: 0,
  actions: {},
  streams: [],
  delta: { matched_events_change: null },
  data_available: false,
}

vi.mock('../../api/gdcGovernancePolicies', () => ({
  fetchGovernancePolicies: vi.fn(async () => ({ policies: [basePolicy] })),
  deleteGovernancePolicy: vi.fn(async () => true),
  createGovernancePolicy: vi.fn(),
  updateGovernancePolicy: vi.fn(),
  submitPolicyForReview: vi.fn(async () => ({ policy: { ...basePolicy, status: 'REVIEW' } })),
  activateGovernancePolicy: vi.fn(),
  retireGovernancePolicy: vi.fn(),
  fetchPolicyAssignments: vi.fn(async () => ({ policy_id: 1, assignments: [] })),
  updatePolicyAssignments: vi.fn(),
  fetchPolicyPreview: vi.fn(),
  previewPolicyJson: vi.fn(async () => previewMock),
  previewPolicyImpact: vi.fn(async () => impactMock),
  simulatePolicy: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => []),
}))

describe('Policy lifecycle UI', () => {
  beforeEach(async () => {
    localStorage.setItem(PERSONA_STORAGE_KEY, 'governance')
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.clearAllMocks()
    const policies = await import('../../api/gdcGovernancePolicies')
    vi.mocked(policies.fetchGovernancePolicies).mockResolvedValue({ policies: [basePolicy] })
    vi.mocked(policies.submitPolicyForReview).mockResolvedValue({
      policy: { ...basePolicy, status: 'REVIEW' },
    })
    vi.mocked(policies.previewPolicyJson).mockResolvedValue(previewMock)
    vi.mocked(policies.previewPolicyImpact).mockResolvedValue(impactMock)
    vi.mocked(policies.fetchPolicyAssignments).mockResolvedValue({ policy_id: 1, assignments: [] })
    const streams = await import('../../api/gdcStreams')
    vi.mocked(streams.fetchStreamsList).mockResolvedValue([])
  })

  afterEach(() => {
    clearTestSession()
  })

  it('renders status badge labels in catalog', async () => {
    const { fetchGovernancePolicies } = await import('../../api/gdcGovernancePolicies')
    vi.mocked(fetchGovernancePolicies).mockResolvedValue({ policies: [basePolicy] })
    render(
      <MemoryRouter>
        <PolicyCatalogPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('policy-status-badge-DRAFT')).toHaveTextContent('Draft')
  })

  it('shows submit for review lifecycle button on draft policy', async () => {
    render(<PolicyEditorDrawer open policy={basePolicy} onClose={() => {}} onSaved={() => {}} />)
    expect(await screen.findByTestId('policy-editor-lifecycle')).toBeInTheDocument()
    expect(screen.getByTestId('policy-editor-status-badge')).toHaveTextContent('Draft')
    expect(screen.getByTestId('policy-lifecycle-submit-review')).toHaveTextContent('Submit for Review')
  })

  it('shows activate button on review policy', async () => {
    render(
      <PolicyEditorDrawer
        open
        policy={{ ...basePolicy, status: 'REVIEW' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(await screen.findByTestId('policy-lifecycle-activate')).toHaveTextContent('Activate')
    expect(screen.getByTestId('policy-editor-status-badge')).toHaveTextContent('Review')
  })

  it('shows retire button on active policy without save', async () => {
    render(
      <PolicyEditorDrawer
        open
        policy={{ ...basePolicy, status: 'ACTIVE' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(await screen.findByTestId('policy-lifecycle-retire')).toHaveTextContent('Retire')
    expect(screen.queryByTestId('policy-editor-save')).not.toBeInTheDocument()
  })

  it('retired policy is view-only with no lifecycle action', async () => {
    render(
      <PolicyEditorDrawer
        open
        policy={{ ...basePolicy, status: 'RETIRED' }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(await screen.findByTestId('policy-editor-status-badge')).toHaveTextContent('Retired')
    expect(screen.getByText(/Retired policies are view-only/i)).toBeInTheDocument()
    expect(screen.queryByTestId('policy-lifecycle-submit-review')).not.toBeInTheDocument()
    expect(screen.queryByTestId('policy-lifecycle-activate')).not.toBeInTheDocument()
    expect(screen.queryByTestId('policy-lifecycle-retire')).not.toBeInTheDocument()
    expect(screen.queryByTestId('policy-editor-save')).not.toBeInTheDocument()
  })

  it('catalog delete only shown for retired policies', async () => {
    const { fetchGovernancePolicies } = await import('../../api/gdcGovernancePolicies')
    vi.mocked(fetchGovernancePolicies).mockResolvedValue({
      policies: [
        basePolicy,
        { ...basePolicy, id: 2, name: 'Active Policy', status: 'ACTIVE' },
        { ...basePolicy, id: 3, name: 'Retired Policy', status: 'RETIRED' },
      ],
    })
    render(
      <MemoryRouter>
        <PolicyCatalogPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('policy-catalog-delete-3')).toBeInTheDocument()
    expect(screen.queryByTestId('policy-catalog-delete-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('policy-catalog-delete-2')).not.toBeInTheDocument()
  })

  it('lifecycle submit for review calls API', async () => {
    const onSaved = vi.fn()
    const user = userEvent.setup()
    const { submitPolicyForReview } = await import('../../api/gdcGovernancePolicies')
    vi.mocked(submitPolicyForReview).mockResolvedValue({
      policy: { ...basePolicy, status: 'REVIEW' },
    })
    render(<PolicyEditorDrawer open policy={basePolicy} onClose={() => {}} onSaved={onSaved} />)
    await user.click(await screen.findByTestId('policy-lifecycle-submit-review'))
    expect(submitPolicyForReview).toHaveBeenCalledWith(1)
    expect(onSaved).toHaveBeenCalled()
  })

  describe('activate separation of duties (F-187)', () => {
    const reviewPolicy = { ...basePolicy, status: 'REVIEW' as const }

    async function activateMock() {
      const { activateGovernancePolicy } = await import('../../api/gdcGovernancePolicies')
      return vi.mocked(activateGovernancePolicy)
    }

    it('confirms before activating a policy the user submitted, then retries with the explicit override', async () => {
      const activate = await activateMock()
      activate
        .mockRejectedValueOnce(new Error('403: [GOVERNANCE_SELF_APPROVAL_FORBIDDEN] you submitted this policy'))
        .mockResolvedValue({ policy: { ...basePolicy, status: 'ACTIVE' } })
      const onSaved = vi.fn()
      const user = userEvent.setup()
      render(<PolicyEditorDrawer open policy={reviewPolicy} onClose={() => {}} onSaved={onSaved} />)

      await user.click(await screen.findByTestId('policy-lifecycle-activate'))

      const dialog = await screen.findByTestId('policy-activate-override-dialog')
      expect(dialog).toHaveTextContent('Activate your own policy?')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(activate).toHaveBeenCalledTimes(1)
      expect(activate).toHaveBeenLastCalledWith(1)
      expect(onSaved).not.toHaveBeenCalled()

      await user.click(screen.getByTestId('policy-activate-override-dialog-confirm'))

      await waitFor(() => expect(activate).toHaveBeenCalledTimes(2))
      expect(activate).toHaveBeenLastCalledWith(1, { allowSelfApproval: true })
      await waitFor(() => expect(onSaved).toHaveBeenCalled())
      expect(screen.queryByTestId('policy-activate-override-dialog')).not.toBeInTheDocument()
    })

    it('shows the unknown-submitter wording and sends the override only after confirmation', async () => {
      const activate = await activateMock()
      activate
        .mockRejectedValueOnce(new Error('403: [GOVERNANCE_SUBMITTER_UNKNOWN] the submitter is not recorded'))
        .mockResolvedValue({ policy: { ...basePolicy, status: 'ACTIVE' } })
      const user = userEvent.setup()
      render(<PolicyEditorDrawer open policy={reviewPolicy} onClose={() => {}} onSaved={() => {}} />)

      await user.click(await screen.findByTestId('policy-lifecycle-activate'))

      const dialog = await screen.findByTestId('policy-activate-override-dialog')
      expect(dialog).toHaveTextContent('Activate without a recorded submitter?')
      expect(dialog).toHaveTextContent('Nobody is recorded as the submitter')
      expect(activate).toHaveBeenCalledTimes(1)
      await user.click(screen.getByTestId('policy-activate-override-dialog-confirm'))
      await waitFor(() => expect(activate).toHaveBeenLastCalledWith(1, { allowSelfApproval: true }))
    })

    it('sends nothing more when the override dialog is cancelled', async () => {
      const activate = await activateMock()
      activate.mockRejectedValueOnce(new Error('403: [GOVERNANCE_SUBMITTER_UNKNOWN] not recorded'))
      const onSaved = vi.fn()
      const user = userEvent.setup()
      render(<PolicyEditorDrawer open policy={reviewPolicy} onClose={() => {}} onSaved={onSaved} />)

      await user.click(await screen.findByTestId('policy-lifecycle-activate'))
      await screen.findByTestId('policy-activate-override-dialog')
      await user.click(screen.getByTestId('policy-activate-override-dialog-cancel'))

      expect(screen.queryByTestId('policy-activate-override-dialog')).not.toBeInTheDocument()
      expect(activate).toHaveBeenCalledTimes(1)
      expect(onSaved).not.toHaveBeenCalled()
    })

    it('shows other activate errors as before, without an override dialog', async () => {
      const activate = await activateMock()
      activate.mockRejectedValueOnce(new Error('409: [GOVERNANCE_POLICY_LIFECYCLE] invalid status transition'))
      const user = userEvent.setup()
      render(<PolicyEditorDrawer open policy={reviewPolicy} onClose={() => {}} onSaved={() => {}} />)

      await user.click(await screen.findByTestId('policy-lifecycle-activate'))

      expect(await screen.findByRole('alert')).toHaveTextContent('GOVERNANCE_POLICY_LIFECYCLE')
      expect(screen.queryByTestId('policy-activate-override-dialog')).not.toBeInTheDocument()
    })
  })
})
