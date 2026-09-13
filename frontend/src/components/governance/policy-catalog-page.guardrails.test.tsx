import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PolicyCatalogPage } from './policy-catalog-page'
import type { GovernancePolicyEntry } from '../../api/gdcGovernancePolicies'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'

const retiredPolicy: GovernancePolicyEntry = {
  id: 9,
  name: 'Retired Customer Protection',
  description: 'PII',
  category: 'DATA_PROTECTION',
  status: 'RETIRED',
  policy_json: {
    conditions: [{ field: 'classification', operator: 'equals', value: 'RESTRICTED' }],
    actions: [{ type: 'quarantine' }],
  },
  version: 2,
  assigned_stream_count: 2,
  assigned_stream_ids: [10, 11],
  created_at: '2026-06-05T12:00:00Z',
  updated_at: '2026-06-05T12:00:00Z',
}

vi.mock('../../api/gdcGovernancePolicies', () => ({
  fetchGovernancePolicies: vi.fn(async () => ({ policies: [retiredPolicy] })),
  deleteGovernancePolicy: vi.fn(async () => true),
  createGovernancePolicy: vi.fn(),
  updateGovernancePolicy: vi.fn(),
  fetchPolicyAssignments: vi.fn(async () => ({ policy_id: 9, assignments: [] })),
  updatePolicyAssignments: vi.fn(),
  fetchPolicyPreview: vi.fn(),
  previewPolicyJson: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: vi.fn(async () => []),
}))

describe('PolicyCatalogPage dangerous action guardrails', () => {
  beforeEach(() => {
    clearTestSession()
    persistTestSession('GOVERNANCE_OPERATOR')
  })

  it('shows dependency-aware delete dialog for retired policies', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <PolicyCatalogPage />
      </MemoryRouter>,
    )

    const deleteBtn = await screen.findByTestId('policy-catalog-delete-9')
    await user.click(deleteBtn)

    expect(await screen.findByTestId('policy-delete-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('policy-delete-dialog-impact')).toBeInTheDocument()
    expect(screen.getByTestId('policy-delete-dialog-dependencies')).toHaveTextContent('Assigned streams: 2')
    expect(screen.getByTestId('policy-delete-dialog-confirm')).toHaveTextContent('Delete policy')
  })
})
