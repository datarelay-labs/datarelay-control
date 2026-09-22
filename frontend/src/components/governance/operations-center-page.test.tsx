import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceOperations from '../../api/gdcGovernanceOperations'
import { NAV_PATH } from '../../config/nav-paths'
import { persistTestSession } from '../../lib/governance-rbac'
import { GovernanceShell } from './governance-shell'
import { OperationsCenterPage } from './operations-center-page'

const emptySummary: gdcGovernanceOperations.GovernanceOperationsSummaryResponse = {
  pending_approvals: 0,
  open_violations: 0,
  quarantined_events: 0,
  pending_replays: 0,
  failed_replays: 0,
  failed_notifications: 0,
  pending_notifications: 0,
}

const populatedSummary: gdcGovernanceOperations.GovernanceOperationsSummaryResponse = {
  pending_approvals: 3,
  open_violations: 7,
  quarantined_events: 5,
  pending_replays: 4,
  failed_replays: 2,
  failed_notifications: 1,
  pending_notifications: 0,
}

const populatedQueue: gdcGovernanceOperations.GovernanceOperationsQueueResponse = {
  action_required: [
    {
      priority: 'critical',
      category: 'failed_replays',
      count: 2,
      label: '2 Failed replay jobs',
      recommended_action: 'Execute or retry failed replay jobs',
    },
  ],
  pending_approvals: [
    {
      policy_id: 1,
      policy_name: 'Customer Data Protection',
      approval_status: 'PENDING_REVIEW',
      requester: 'Gov Op',
      submitted_at: '2026-06-06T10:00:00Z',
    },
  ],
  violations: [
    {
      violation_id: 'q-1',
      policy_name: 'Customer Data Protection',
      stream_name: 'Malop API',
      severity: 'HIGH',
      status: 'OPEN',
    },
  ],
  quarantine: [],
  replays: [],
  notifications: [],
}

function mockApis(
  overrides: Partial<{
    summary: gdcGovernanceOperations.GovernanceOperationsSummaryResponse
    queue: gdcGovernanceOperations.GovernanceOperationsQueueResponse
  }> = {},
) {
  vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsSummary').mockResolvedValue(
    overrides.summary ?? emptySummary,
  )
  vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsQueue').mockResolvedValue(
    overrides.queue ?? populatedQueue,
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[NAV_PATH.governanceOperations]}>
      <OperationsCenterPage />
    </MemoryRouter>,
  )
}

describe('OperationsCenterPage', () => {
  beforeEach(() => {
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
  })

  it('renders action queue and action cards', async () => {
    mockApis({ summary: populatedSummary })

    renderPage()

    expect(await screen.findByTestId('operations-center-page')).toBeInTheDocument()
    expect(screen.getByTestId('ops-posture-overview')).toBeInTheDocument()
    expect(screen.getByTestId('ops-action-queue')).toBeInTheDocument()
    expect(screen.getByTestId('gov-action-queue-panel')).toBeInTheDocument()
    expect(screen.getByTestId('ops-queue-approvals-value')).toHaveTextContent('3')
    expect(screen.getByTestId('ops-action-required')).toBeInTheDocument()
    expect(screen.getByTestId('ops-pending-approvals')).toBeInTheDocument()
    expect(screen.getByTestId('ops-approve-1')).toBeInTheDocument()
    expect(screen.getByTestId('ops-violation-actions')).toBeInTheDocument()
  })

  it('blocks viewer role from operations center', async () => {
    persistTestSession('VIEWER')
    mockApis()

    renderPage()

    expect(await screen.findByTestId('operations-unauthorized')).toBeInTheDocument()
  })
})

describe('GovernanceShell navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('shows dashboard first and hides operations for viewer', async () => {
    persistTestSession('VIEWER')
    render(
      <MemoryRouter initialEntries={[NAV_PATH.governance]}>
        <GovernanceShell />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-nav-dashboard')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-nav-operations')).not.toBeInTheDocument()
  })

  it('shows operations tab for governance operator', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    render(
      <MemoryRouter initialEntries={[NAV_PATH.governance]}>
        <GovernanceShell />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-nav-operations')).toBeInTheDocument()
  })
})
