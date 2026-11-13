import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StreamRecentIssuesPanel } from './stream-recent-issues-panel'
import type { StreamIssueContext } from '../../lib/stream-issue-context'
import type { OperationalIssue, StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'

const baseline: StreamIssueContext = {
  id: '42',
  status: 'RUNNING',
  connectorName: 'Webhook',
  deliveryPctKnown: false,
  deliveryPct: 0,
  routesError: 0,
  lastActivityRelative: 'Not reported',
  recentErrors: [],
}

function display(
  ctx: StreamIssueContext = baseline,
  governance?: StreamGovernanceSnapshot,
  issues: OperationalIssue[] = [],
) {
  render(
    <MemoryRouter>
      <StreamRecentIssuesPanel
        ctx={ctx}
        issues={issues}
        governance={governance}
        whyChain={[]}
      />
    </MemoryRouter>,
  )
  return screen.getByTestId('stream-recent-issues-panel')
}

describe('Stream Recent Issues: evidence-aware status', () => {
  it('does not promote missing runtime and governance evidence into five green checks', () => {
    const panel = display()
    expect(panel).toHaveTextContent('Delivery outcomes not verified')
    expect(panel).toHaveTextContent('Delivery success rate not verified')
    expect(panel).toHaveTextContent('Expected ingest range not verified')
    expect(panel).toHaveTextContent('Schema drift summary not verified')
    expect(panel).toHaveTextContent('Sensitive findings summary not verified')
    expect(panel.querySelectorAll('[data-evidence-status="unknown"]')).toHaveLength(5)
    expect(panel).not.toHaveTextContent('No delivery failures')
    expect(panel).not.toHaveTextContent('Within healthy threshold')
    expect(panel).not.toHaveTextContent('Ingest within expected range')
    expect(panel).not.toHaveTextContent('No drift detected')
    expect(panel).not.toHaveTextContent('No sensitive findings')
  })

  it('only displays cleared governance checks when actual summary sources are present', () => {
    const gov = {
      schemaDrift: { open_count: 0 },
      sensitive: { open_count: 0 },
    } as unknown as StreamGovernanceSnapshot
    const ctx = { ...baseline, deliveryPctKnown: true, deliveryPct: 95.5 }
    const panel = display(ctx, gov)
    expect(panel).toHaveTextContent('Success rate 95.5%')
    expect(panel).toHaveTextContent('No open schema drift findings in loaded summary')
    expect(panel).toHaveTextContent('No open sensitive findings in loaded summary')
    expect(panel).not.toHaveTextContent('No delivery failures')
    expect(panel.querySelectorAll('[data-evidence-status="unknown"]')).toHaveLength(1)
  })

  it('keeps informational runtime issues neutral rather than showing a healthy green check', () => {
    const panel = display(
      baseline,
      undefined,
      [{ key: 'schema-drift', label: 'Schema summary informational', tone: 'info', detail: 'Summary data is advisory' }],
    )
    expect(panel).toHaveTextContent('Summary data is advisory')
    expect(panel.querySelectorAll('[data-evidence-status="info"]')).toHaveLength(1)
    expect(panel.querySelectorAll('[data-evidence-status="ok"]')).toHaveLength(0)
  })

  it('preserves recorded critical delivery failures, never downgrading to unknown', () => {
    const panel = display(
      { ...baseline, status: 'ERROR', routesError: 1 },
      undefined,
      [{ key: 'destination', label: 'Destination failure', tone: 'critical', detail: 'Route timed out' }],
    )
    expect(panel).toHaveTextContent('Route timed out')
    expect(panel.querySelectorAll('[data-evidence-status="critical"]')).toHaveLength(1)
  })

  it('does not render a lone low-success issue twice for destination and error rate rows', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const panel = display(
        { ...baseline, deliveryPctKnown: true, deliveryPct: 79.4, routesError: 0 },
        undefined,
        [{ key: 'low-success', label: 'Low delivery success', tone: 'warning', detail: 'Success rate 79.4%' }],
      )
      expect(within(panel).getAllByText('Low delivery success')).toHaveLength(1)
      expect(panel).toHaveTextContent('High error rate')
      const duplicateKeyErrors = errorSpy.mock.calls.filter((call) => String(call[0]).includes('same key'))
      expect(duplicateKeyErrors).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
