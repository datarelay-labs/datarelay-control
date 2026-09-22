import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceDashboard from '../../api/gdcGovernanceDashboard'
import * as gdcGovernancePolicies from '../../api/gdcGovernancePolicies'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as gdcRuntimeHealth from '../../api/gdcRuntimeHealth'
import { GovernanceDashboardPage } from './governance-dashboard-page'

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
  recent_activity: [
    {
      event_time: '2026-06-06T10:00:00Z',
      event_type: 'VIOLATION_CREATED',
      event_label: 'Violation created',
      policy_id: 1,
      policy_name: 'Customer Data Protection',
      stream_id: 10,
      stream_name: 'Malop API',
      status: 'OPEN',
    },
  ],
}

describe('GovernanceDashboardPage', () => {
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

  it('renders governance overview layout sections', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(screen.getByText('Governance Overview')).toBeInTheDocument()
    expect(screen.getByTestId('governance-posture-overview')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-kpi-strip')).toBeInTheDocument()
    expect(screen.getByTestId('governance-what-happened')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-recent-activity')).toBeInTheDocument()
    expect(screen.getByTestId('governance-recommended-actions')).toBeInTheDocument()
    expect(screen.getByTestId('dashboard-policy-health')).toBeInTheDocument()
    expect(screen.getByTestId('governance-quick-actions')).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
    expect(screen.queryByText('Reject')).not.toBeInTheDocument()
  })

  it('shows KPI values from dashboard summary API', async () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
      expect(screen.getByTestId('dashboard-kpi-pending-approvals')).toHaveTextContent('2')
    })
  })

  it('renders page when summary fails but list APIs succeed', async () => {
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockRejectedValue(
      new Error('Request timed out after 15000ms'),
    )

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(await screen.findByTestId('governance-dashboard-summary-error')).toHaveTextContent(/timed out/i)
    expect(screen.queryByTestId('governance-dashboard-error')).not.toBeInTheDocument()
    expect(await screen.findByTestId('gov-violation-row-v-1')).toBeInTheDocument()
    expect(await screen.findByTestId('gov-policy-row-1')).toBeInTheDocument()
  })

  it('does not block page layout while summary is still loading', async () => {
    let resolveSummary: (value: gdcGovernanceDashboard.GovernanceDashboardSummaryResponse) => void
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSummary = resolve
        }),
    )

    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-dashboard-page')).toBeInTheDocument()
    expect(await screen.findByTestId('gov-violation-row-v-1')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-dashboard-summary-error')).not.toBeInTheDocument()

    resolveSummary!(sampleSummary)
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
    })
  })
})
