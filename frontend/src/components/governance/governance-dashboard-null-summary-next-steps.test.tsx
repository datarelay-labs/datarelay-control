import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceDashboard from '../../api/gdcGovernanceDashboard'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as operationalSnapshot from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
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
  recent_activity: [],
}

describe('GovernanceDashboardPage next steps when the summary is unavailable', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 0,
      violations: [],
    })
    vi.spyOn(operationalSnapshot, 'getOperationalSnapshot').mockRejectedValue(new Error('snapshot unavailable'))
  })

  it('does not claim zero counts and keeps testids and hrefs when the summary failed to load', async () => {
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockRejectedValue(new Error('summary down'))
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    const critical = await screen.findByTestId('gov-action-critical-violations')
    const pending = screen.getByTestId('gov-action-pending-approvals')
    const quarantine = screen.getByTestId('gov-action-quarantine')
    await waitFor(() => expect(critical).toHaveTextContent(/counts not verified/i))
    for (const row of [critical, pending, quarantine]) {
      expect(row).toHaveTextContent(/governance summary unavailable - counts not verified/i)
      expect(row.textContent ?? '').not.toMatch(/\b0\b/)
    }
    const region = screen.getByTestId('governance-recommended-actions')
    expect(region).not.toHaveTextContent(/0 critical/i)
    expect(region).not.toHaveTextContent(/0 pending/i)
    expect(region).not.toHaveTextContent(/0 quarantined/i)
    expect(critical).toHaveAttribute('href', NAV_PATH.governanceViolations)
    expect(pending).toHaveAttribute('href', NAV_PATH.governanceApprovals)
    expect(quarantine).toHaveAttribute('href', NAV_PATH.governanceQuarantine)
    expect(screen.getByTestId('gov-action-schema-drift')).toBeInTheDocument()
  })

  it('keeps count wording unchanged when the summary exists', async () => {
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockResolvedValue(sampleSummary)
    render(
      <MemoryRouter>
        <GovernanceDashboardPage />
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('gov-action-critical-violations')).toHaveTextContent('Review 3 critical violations'),
    )
    expect(screen.getByTestId('gov-action-pending-approvals')).toHaveTextContent('Process 2 pending approvals')
    expect(screen.getByTestId('gov-action-quarantine')).toHaveTextContent('Review 5 quarantined events')
    expect(screen.getByTestId('governance-recommended-actions')).not.toHaveTextContent(/counts not verified/i)
  })
})
