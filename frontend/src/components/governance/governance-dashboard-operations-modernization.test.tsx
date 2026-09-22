import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceDashboard from '../../api/gdcGovernanceDashboard'
import * as gdcGovernanceOperations from '../../api/gdcGovernanceOperations'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as gdcRuntimeHealth from '../../api/gdcRuntimeHealth'
import { NAV_PATH } from '../../config/nav-paths'
import { persistTestSession } from '../../lib/governance-rbac'
import { GovernanceDashboardPage } from './governance-dashboard-page'
import {
  deriveGovernancePosture,
  GovernanceDashboardPostureOverview,
} from './governance-dashboard-posture-overview'
import { OperationsCenterPage } from './operations-center-page'

const sampleSummary: gdcGovernanceDashboard.GovernanceDashboardSummaryResponse = {
  active_policies: 4,
  policies_in_review: 2,
  open_violations: 7,
  quarantined_events: 5,
  failed_replays: 1,
  notification_failures: 2,
  pending_approvals: 2,
  pending_replays: 3,
  risk: { critical: 3, high: 4, medium: 8, low: 12 },
  policy_health: { healthy: 3, warning: 2, critical: 1 },
  compliance_snapshot: { violations_24h: 6, quarantines_24h: 5, replays_24h: 4 },
  recent_activity: [],
}

const emptyOpsSummary: gdcGovernanceOperations.GovernanceOperationsSummaryResponse = {
  pending_approvals: 0,
  open_violations: 0,
  quarantined_events: 0,
  pending_replays: 0,
  failed_replays: 0,
  failed_notifications: 0,
  pending_notifications: 0,
}

const populatedOpsSummary: gdcGovernanceOperations.GovernanceOperationsSummaryResponse = {
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
  pending_approvals: [],
  violations: [
    {
      violation_id: 'v-deep-1',
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

describe('GovernanceDashboardPostureOverview', () => {
  it('derives critical posture from backend risk counts only', () => {
    expect(deriveGovernancePosture(sampleSummary)).toBe('critical')
    expect(deriveGovernancePosture({ ...sampleSummary, risk: { critical: 0, high: 0, medium: 0, low: 1 }, policy_health: { healthy: 4, warning: 0, critical: 0 } })).toBe(
      'healthy',
    )
  })

  it('renders calm posture copy and compact investigation counts', () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPostureOverview summary={sampleSummary} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('governance-posture-overview')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-kpi-overall-risk')).toHaveTextContent('Critical')
    expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
    expect(screen.getByTestId('dashboard-kpi-pending-approvals')).toHaveTextContent('2')
    expect(screen.getByLabelText('Governance policy posture')).toBeInTheDocument()
  })

  it('shows loading shell when summary is not ready', () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPostureOverview summary={null} loading />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('governance-posture-overview-loading')).toBeInTheDocument()
  })
})

describe('Governance Dashboard modernization', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockResolvedValue(sampleSummary)
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [
        {
          id: 'v-1',
          policy_id: 1,
          policy_name: 'PII Detection Policy',
          stream_id: 10,
          stream_name: 'Login Stream',
          event_time: new Date(Date.now() - 120_000).toISOString(),
          severity: 'HIGH',
          reason: 'PII detected',
          status: 'OPEN',
          quarantine_event_id: null,
        },
      ],
    })
    vi.spyOn(gdcGovernancePolicies, 'fetchGovernancePolicies').mockResolvedValue({
      policies: [
        {
          id: 1,
          name: 'PII Detection Policy',
          description: null,
          category: 'DATA_PROTECTION',
          status: 'ACTIVE',
          policy_json: { conditions: [], actions: [] },
          version: 1,
          assigned_stream_count: 5,
          assigned_stream_ids: [1],
          created_at: '2026-06-01T10:30:00Z',
          updated_at: '2026-06-01T14:30:00Z',
        },
      ],
    })
    vi.spyOn(gdcRuntimeHealth, 'fetchHealthOverview').mockResolvedValue(null)
  })

  it('uses investigation-first hierarchy with English operator path copy', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(screen.getByText(/What needs attention, and where do I investigate/i)).toBeInTheDocument()
    expect(screen.getByTestId('governance-posture-overview')).toBeInTheDocument()
    expect(screen.getByTestId('governance-recommended-actions')).toBeInTheDocument()
    expect(screen.getByTestId('gov-action-critical-violations')).toHaveTextContent(/Review 3 critical violations/i)
    expect(screen.queryByText(/위반을 검토하세요/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\(요약\)/)).not.toBeInTheDocument()
  })

  it('preserves violation deep-link continuity on Investigate', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    const investigate = await screen.findByTestId('gov-investigate-v-1')
    expect(investigate).toHaveAttribute('href', `${NAV_PATH.governanceViolations}?id=v-1`)
  })

  it('keeps empty recent-violations state accessible', async () => {
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    const table = await screen.findByTestId('gov-recent-violations-table')
    expect(within(table).getByText(/No recent open violations/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Recent violations')).toBeInTheDocument()
  })

  it('surfaces summary error without blocking investigation targets', async () => {
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockRejectedValue(
      new Error('Request timed out after 15000ms'),
    )

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-summary-error')).toHaveAttribute('role', 'alert')
    expect(await screen.findByTestId('gov-violation-row-v-1')).toBeInTheDocument()
  })
})

describe('Operations Center modernization', () => {
  beforeEach(() => {
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
  })

  it('renders queue posture then prioritized action queue', async () => {
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsSummary').mockResolvedValue(populatedOpsSummary)
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsQueue').mockResolvedValue(populatedQueue)

    render(
      <MemoryRouter initialEntries={[NAV_PATH.governanceOperations]}>
        <OperationsCenterPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('operations-center-page')).toBeInTheDocument()
    expect(screen.getByText(/What should I act on first/i)).toBeInTheDocument()
    expect(screen.getByTestId('ops-posture-overview')).toBeInTheDocument()
    expect(screen.getByTestId('ops-posture-label')).toHaveTextContent('Needs recovery')
    expect(screen.getByTestId('ops-action-queue')).toBeInTheDocument()
    expect(screen.getByTestId('ops-queue-approvals-value')).toHaveTextContent('3')
  })

  it('deep-links Investigate to violation id', async () => {
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsSummary').mockResolvedValue(populatedOpsSummary)
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsQueue').mockResolvedValue(populatedQueue)

    render(
      <MemoryRouter initialEntries={[NAV_PATH.governanceOperations]}>
        <OperationsCenterPage />
      </MemoryRouter>,
    )

    const investigate = await screen.findByTestId('ops-investigate-v-deep-1')
    expect(investigate).toHaveAttribute('href', `${NAV_PATH.governanceViolations}?id=v-deep-1`)
  })

  it('shows empty attention and clear posture when queues are idle', async () => {
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsSummary').mockResolvedValue(emptyOpsSummary)
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsQueue').mockResolvedValue({
      action_required: [],
      pending_approvals: [],
      violations: [],
      quarantine: [],
      replays: [],
      notifications: [],
    })

    render(
      <MemoryRouter initialEntries={[NAV_PATH.governanceOperations]}>
        <OperationsCenterPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('ops-posture-label')).toHaveTextContent('Clear')
    })
    expect(screen.getByTestId('ops-action-required-empty')).toBeInTheDocument()
    expect(screen.getByLabelText('Action Queue')).toBeInTheDocument()
  })

  it('renders load failure with alert semantics', async () => {
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsSummary').mockRejectedValue(new Error('ops down'))
    vi.spyOn(gdcGovernanceOperations, 'fetchGovernanceOperationsQueue').mockRejectedValue(new Error('ops down'))

    render(
      <MemoryRouter initialEntries={[NAV_PATH.governanceOperations]}>
        <OperationsCenterPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('ops-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('ops-error')).toHaveTextContent(/ops down/i)
  })
})
