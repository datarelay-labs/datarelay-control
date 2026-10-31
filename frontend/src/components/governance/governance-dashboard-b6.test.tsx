import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gdcGovernanceDashboard from '../../api/gdcGovernanceDashboard'
import * as gdcGovernanceViolations from '../../api/gdcGovernanceViolations'
import * as operationalSnapshot from '../../api/operationalSnapshot'
import { NAV_PATH } from '../../config/nav-paths'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { GovernanceDashboardPage } from './governance-dashboard-page'
import { GovernanceDashboardPostureOverview } from './governance-dashboard-posture-overview'
import { GovernanceShell } from './governance-shell'

const summary: gdcGovernanceDashboard.GovernanceDashboardSummaryResponse = {
  active_policies: 4,
  policies_in_review: 2,
  open_violations: 7,
  quarantined_events: 5,
  failed_replays: 1,
  notification_failures: 0,
  pending_approvals: 2,
  pending_replays: 3,
  risk: { critical: 3, high: 4, medium: 8, low: 12 },
  policy_health: { healthy: 3, warning: 2, critical: 1 },
  compliance_snapshot: { violations_24h: 6, quarantines_24h: 5, replays_24h: 4 },
  recent_activity: [],
}

describe('Governance posture overview (B6)', () => {
  it('keeps Not verified (unknown family) and shows unmeasured counts as unknown, never 0', () => {
    render(<MemoryRouter><GovernanceDashboardPostureOverview summary={null} /></MemoryRouter>)
    const chip = screen.getByTestId('dashboard-kpi-overall-risk')
    expect(chip).toHaveTextContent('Not verified')
    expect(chip).not.toHaveTextContent('Healthy')
    expect(chip).toHaveAttribute('data-status', 'unknown')
    for (const id of ['violations', 'critical-violations', 'quarantine', 'pending-approvals']) {
      const tile = screen.getByTestId('dashboard-kpi-' + id)
      expect(tile.querySelector('[data-metric-value]'), id).toHaveAttribute('data-unknown', 'true')
      expect(tile, id).toHaveTextContent('—')
    }
    expect(screen.getByTestId('dashboard-kpi-strip')).not.toHaveTextContent('0')
  })

  it('renders a measured summary with the status chip and measured counts', () => {
    render(<MemoryRouter><GovernanceDashboardPostureOverview summary={summary} /></MemoryRouter>)
    expect(screen.getByTestId('dashboard-kpi-overall-risk')).toHaveAttribute('data-status', 'critical')
    expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('7')
    expect(screen.getByTestId('dashboard-kpi-pending-approvals')).toHaveTextContent('2')
    expectOnlySemanticClasses(screen.getByTestId('governance-posture-overview'))
  })

  it('renders a measured zero summary as Healthy with real zeros', () => {
    render(
      <MemoryRouter>
        <GovernanceDashboardPostureOverview
          summary={{ ...summary, open_violations: 0, quarantined_events: 0, pending_approvals: 0,
            risk: { critical: 0, high: 0, medium: 0, low: 0 }, policy_health: { healthy: 3, warning: 0, critical: 0 } }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('dashboard-kpi-overall-risk')).toHaveAttribute('data-status', 'healthy')
    expect(screen.getByTestId('dashboard-kpi-violations')).toHaveTextContent('0')
    expect(screen.getByTestId('dashboard-kpi-violations').querySelector('[data-metric-value]')).not.toHaveAttribute('data-unknown')
  })
})

describe('Governance tabs and dashboard blocks (B6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(gdcGovernanceDashboard, 'fetchGovernanceDashboardSummary').mockResolvedValue(summary)
    vi.spyOn(gdcGovernanceViolations, 'fetchGovernanceViolations').mockResolvedValue({
      window: '24h',
      total: 1,
      violations: [{
        id: 'v-1', policy_id: 1, policy_name: 'PII Detection Policy', stream_id: 10, stream_name: 'Login Stream',
        event_time: new Date(Date.now() - 120_000).toISOString(), severity: 'HIGH', reason: 'PII detected',
        status: 'OPEN', quarantine_event_id: null,
      }],
    })
    vi.spyOn(operationalSnapshot, 'getOperationalSnapshot').mockRejectedValue(new Error('snapshot unavailable'))
  })
  afterEach(() => clearTestSession())

  it('marks the active governance tab with an accent underline instead of a filled violet block', async () => {
    persistTestSession('VIEWER')
    render(<MemoryRouter initialEntries={[NAV_PATH.governance]}><GovernanceShell /></MemoryRouter>)
    const active = await screen.findByTestId('governance-nav-dashboard')
    expect(active).toHaveClass('border-accent', 'text-fg', 'h-control-md')
    expect(active).not.toHaveClass('bg-violet-600')
    expect(active).toHaveAttribute('aria-current', 'page')
    const nav = screen.getByRole('navigation', { name: 'Governance sections' })
    expectOnlySemanticClasses(nav)
  })

  it('shows severity as a status chip and unavailable operational signals as unknown tiles', async () => {
    render(<MemoryRouter><GovernanceDashboardPage /></MemoryRouter>)
    const row = await screen.findByTestId('gov-violation-row-v-1')
    const chip = within(row).getByText('High').closest('[data-status]')
    expect(chip).toHaveAttribute('data-status', 'critical')

    const noData = await screen.findByTestId('gov-issue-no-data')
    expect(noData.querySelector('[data-metric-value]')).toHaveAttribute('data-unknown', 'true')
    expect(noData).toHaveTextContent('Data unavailable')
    expect(noData).toHaveTextContent('—')
  })

  it('uses one SectionHeader per block and the shared secondary button for the workspace link', async () => {
    render(<MemoryRouter><GovernanceDashboardPage /></MemoryRouter>)
    await screen.findByTestId('gov-violation-row-v-1')
    expect(screen.getByRole('heading', { level: 2, name: 'Prioritized investigation path' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Recent open violations' })).toBeInTheDocument()
    expect(screen.queryByText('Investigation targets')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open advanced Governance Workspace' })).toHaveClass('bg-surface-card', 'h-control-md')
    expectOnlySemanticClasses(screen.getByTestId('governance-quick-actions'))
    expectOnlySemanticClasses(screen.getByTestId('governance-what-happened'))
  })
})
