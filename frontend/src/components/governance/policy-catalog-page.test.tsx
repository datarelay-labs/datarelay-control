import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyCatalogPage } from './policy-catalog-page'
import type { GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'

const samplePolicy: GovernancePolicyEntry = {
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

vi.mock('../../api/gdcGovernancePolicies', () => ({
  fetchGovernancePolicies: vi.fn(async () => ({ policies: [samplePolicy] })),
  deleteGovernancePolicy: vi.fn(async () => true),
  createGovernancePolicy: vi.fn(),
  updateGovernancePolicy: vi.fn(),
  fetchPolicyAssignments: vi.fn(async () => ({ policy_id: 1, assignments: [] })),
  updatePolicyAssignments: vi.fn(),
  fetchPolicyPreview: vi.fn(),
  previewPolicyJson: vi.fn(async () => ({
    policy_id: 0,
    policy_json: samplePolicy.policy_json,
    rules: [{ condition_text: 'classification = RESTRICTED', action_text: 'quarantine', combined: 'IF classification = RESTRICTED THEN quarantine' }],
    summary: 'IF classification = RESTRICTED THEN quarantine',
  })),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => []),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <PolicyCatalogPage />
    </MemoryRouter>,
  )
}

describe('PolicyCatalogPage', () => {
  beforeEach(() => {
    clearTestSession()
  })

  it('shows runtime enforcement notice', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    renderPage()
    expect(await screen.findByTestId('policy-runtime-notice')).toBeInTheDocument()
    expect(screen.getByText('Preview only')).toBeInTheDocument()
    expect(screen.getByText(/Runtime enforcement not enabled/i)).toBeInTheDocument()
  })

  it('allows governance operator to create policies', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    renderPage()
    expect(await screen.findByTestId('policy-catalog-new')).toBeInTheDocument()
    expect(screen.queryByTestId('policy-catalog-delete-1')).not.toBeInTheDocument()
  })

  it('connector operator is read-only (no new/delete)', async () => {
    persistTestSession('CONNECTOR_OPERATOR')
    renderPage()
    expect(await screen.findByTestId('policy-catalog-table')).toBeInTheDocument()
    expect(screen.queryByTestId('policy-catalog-new')).not.toBeInTheDocument()
    expect(screen.queryByTestId('policy-catalog-delete-1')).not.toBeInTheDocument()
    expect(await screen.findByTestId('policy-catalog-view-1')).toHaveTextContent('View')
    expect(screen.getByText(/Read-only — policy edits require Governance Operator role/i)).toBeInTheDocument()
  })

  it('connector operator opens view-only editor without save', async () => {
    persistTestSession('CONNECTOR_OPERATOR')
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('policy-catalog-view-1'))
    expect(await screen.findByTestId('policy-editor-drawer')).toBeInTheDocument()
    expect(screen.getByText('View policy')).toBeInTheDocument()
    expect(screen.queryByTestId('policy-editor-save')).not.toBeInTheDocument()
    expect(screen.getByTestId('policy-editor-name')).toBeDisabled()
  })
})
