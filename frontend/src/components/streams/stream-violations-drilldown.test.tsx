import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as violationsApi from '../../api/gdcGovernanceViolations'
import * as runtimeApi from '../../api/gdcRuntime'
import * as findingsApi from '../../api/gdcSensitiveFindings'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { StreamViolationsDrilldown } from './stream-violations-drilldown'

// F-184: the stream Violations tab must list the stream's violations and sensitive findings, not
// only an overview card.

const violation: violationsApi.GovernanceViolationEntry = {
  id: 'q-5',
  policy_id: 1,
  policy_name: 'Card data',
  stream_id: 8,
  stream_name: 's8',
  event_time: '2026-10-31T10:00:00Z',
  severity: 'HIGH',
  reason: 'Policy Rule - Card data',
  status: 'QUARANTINED',
  quarantine_event_id: 5,
}

function renderDrilldown() {
  return render(
    <MemoryRouter>
      <StreamViolationsDrilldown streamId={8} canOperate />
    </MemoryRouter>,
  )
}

describe('StreamViolationsDrilldown', () => {
  beforeEach(() => {
    clearTestSession()
    persistTestSession('ADMINISTRATOR', 'admin')
    vi.spyOn(findingsApi, 'fetchStreamSensitiveFindingsSummary').mockResolvedValue(null)
    vi.spyOn(findingsApi, 'fetchStreamSensitiveFindings').mockResolvedValue(null)
    vi.spyOn(runtimeApi, 'searchRuntimeDeliveryLogs').mockResolvedValue({ total_returned: 3, filters: {}, logs: [] } as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it('lists the stream violations with an investigate link', async () => {
    vi.spyOn(violationsApi, 'fetchGovernanceViolations').mockResolvedValue({
      window: '30d',
      total: 1,
      violations: [violation],
    })
    renderDrilldown()
    expect(await screen.findByTestId('stream-violations-list')).toHaveTextContent('Card data')
    expect(screen.getByTestId('stream-violation-open-q-5')).toHaveAttribute('href', '/governance/violations?id=q-5')
    expect(violationsApi.fetchGovernanceViolations).toHaveBeenCalledWith(
      expect.objectContaining({ stream_id: 8, window: '30d' }),
    )
  })

  it('states an empty result without implying a healthy stream when the read failed', async () => {
    vi.spyOn(violationsApi, 'fetchGovernanceViolations').mockResolvedValue(null)
    renderDrilldown()
    expect(await screen.findByTestId('stream-violations-error')).toHaveTextContent(/not evidence/)
    expect(screen.queryByTestId('stream-violations-empty')).not.toBeInTheDocument()
  })

  it('shows an explicit empty state when the read succeeded with no violations', async () => {
    vi.spyOn(violationsApi, 'fetchGovernanceViolations').mockResolvedValue({ window: '30d', total: 0, violations: [] })
    renderDrilldown()
    expect(await screen.findByTestId('stream-violations-empty')).toBeInTheDocument()
  })

  it('shows the silent policy Block count with a link to the blocked events (F-185)', async () => {
    vi.spyOn(violationsApi, 'fetchGovernanceViolations').mockResolvedValue({ window: '30d', total: 0, violations: [] })
    renderDrilldown()
    expect(await screen.findByTestId('stream-policy-blocked-count')).toHaveTextContent('3 policy blocks logged')
    expect(screen.getByTestId('stream-policy-blocked-logs').getAttribute('href')).toContain('stage=policy_blocked')
    expect(runtimeApi.searchRuntimeDeliveryLogs).toHaveBeenCalledWith(
      expect.objectContaining({ stream_id: 8, stage: 'policy_blocked' }),
    )
  })

  it('does not report zero blocks when the log read failed (F-185)', async () => {
    vi.spyOn(violationsApi, 'fetchGovernanceViolations').mockResolvedValue({ window: '30d', total: 0, violations: [] })
    vi.spyOn(runtimeApi, 'searchRuntimeDeliveryLogs').mockResolvedValue(null)
    renderDrilldown()
    expect(await screen.findByTestId('stream-policy-blocked-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-policy-blocked-count')).not.toBeInTheDocument()
  })
})
