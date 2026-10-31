import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StreamFlowTimeline, type FlowTimelineStage } from './stream-flow-timeline'
import { StreamIssueRail } from './stream-issue-rail'
import { StreamRuntimeDiagnosisOverview } from './stream-runtime-diagnosis-overview'
import { StreamWhyPanel } from './stream-why-panel'
import { StreamsGroupKpiStrip } from './streams-group-kpi-strip'
import { StreamsOperationsSummaryStrip } from './streams-operations-summary-strip'
import type { StreamIssueContext } from '../../lib/stream-issue-context'
import type { StreamsPageKpi } from '../../lib/stream-console-metrics'

/**
 * Light-theme contrast: the WARNING state must use the semantic text-status-warning alias
 * (token-driven, passes >= 4.5:1 in both themes) instead of raw amber palette text such as
 * text-amber-600 (3.19:1 on white).
 */
function expectSemanticWarning(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  const cls = el!.getAttribute('class') ?? ''
  expect(cls).toContain('text-status-warning')
  expect(cls).not.toMatch(/text-amber-/)
}

describe('Stream runtime warning state uses semantic status-warning tokens', () => {
  it('Issue rail low-success chip and recent-error icon', () => {
    const ctx: StreamIssueContext = {
      id: '42',
      status: 'RUNNING',
      connectorName: 'Webhook',
      deliveryPctKnown: true,
      deliveryPct: 80,
      routesError: 0,
      lastActivityRelative: '1m ago',
      recentErrors: [{ message: 'upstream 429' }],
    }
    render(
      <MemoryRouter>
        <StreamIssueRail ctx={ctx} numericId={42} controlBusy={false} runOnceBusy={false} onRunOnce={vi.fn()} onStop={vi.fn()} />
      </MemoryRouter>,
    )
    const chip = screen.getByText('Low success rate')
    expectSemanticWarning(chip)
    expect(chip.className).toContain('bg-status-warning-subtle')
    expect(chip.className).toContain('border-status-warning-border')
    expect(chip.className).not.toMatch(/(?:bg|border)-amber-/)
    const icon = screen.getAllByText('upstream 429').find((n) => n.tagName === 'SPAN')!.previousElementSibling
    expectSemanticWarning(icon)
  })

  it('Why panel warning badge and recommended-action icons', () => {
    const ctx: StreamIssueContext = {
      id: '42',
      status: 'RUNNING',
      connectorName: 'Webhook',
      deliveryPctKnown: true,
      deliveryPct: 80,
      routesError: 0,
      lastActivityRelative: '1m ago',
      recentErrors: [],
    }
    render(
      <StreamWhyPanel
        ctx={ctx}
        issues={[{ key: 'schema-drift', label: 'Schema drift', tone: 'warning', detail: 'Open drift findings' }]}
        whyChain={[]}
      />,
    )
    const badge = screen.getByText('Warning')
    expectSemanticWarning(badge)
    expect(badge.className).not.toMatch(/(?:bg|border)-amber-/)
    const action = screen.getByText('Acknowledge or resolve open schema drift findings.')
    expectSemanticWarning(action.previousElementSibling)
  })

  it('Diagnosis overview attention card', () => {
    render(
      <MemoryRouter>
        <StreamRuntimeDiagnosisOverview
          diagnosis={{
            whatHappened: 'Delivery is delayed.',
            causes: [{ key: 'destination', label: 'Destination', tone: 'attention', detail: 'Rate limited' }],
            nextSteps: [],
          }}
          evidence={null}
        />
      </MemoryRouter>,
    )
    const card = screen.getByTestId('stream-diagnosis-cause-destination')
    expectSemanticWarning(card)
    expect(card.className).toContain('bg-status-warning-subtle')
    expect(card.className).not.toMatch(/(?:bg|border)-amber-/)
  })

  it('Flow timeline warn stage bubble, status label and attention note', () => {
    const stages: FlowTimelineStage[] = [
      { key: 'source', label: 'Source', shortLabel: 'Source', status: 'ok' },
      { key: 'delivery', label: 'Delivery', shortLabel: 'Delivery', status: 'warn', detail: 'Retrying' },
    ]
    render(
      <MemoryRouter>
        <StreamFlowTimeline stages={stages} />
      </MemoryRouter>,
    )
    const timeline = screen.getByTestId('stream-flow-timeline')
    const bubble = timeline.querySelector('span[title^="Delivery:"]')
    expectSemanticWarning(bubble)
    const note = screen.getByText(/Delivery: needs attention/)
    expectSemanticWarning(note)
    const statusLabel = Array.from(timeline.querySelectorAll('span')).find(
      (s) => s.className.includes('text-center text-[10px]') && s.className.includes('text-status-warning'),
    )
    expect(statusLabel).toBeTruthy()
    expect(timeline.innerHTML).not.toMatch(/text-amber-/)
  })

  it('Streams KPI strip warning value and icon', () => {
    const kpi = {
      totalGroups: 1,
      totalStreams: 3,
      healthyGroups: 0,
      warningGroups: 1,
      criticalGroups: 0,
      totalIssues: 0,
      healthyPct: '0%',
      warningPct: '100%',
      criticalPct: '0%',
      healthyStreams: 0,
      warningStreams: 2,
      criticalStreams: 0,
      noDataStreams: 1,
      healthyStreamsPct: '0%',
      warningStreamsPct: '66.7%',
      criticalStreamsPct: '0%',
      totalEpsLabel: '—',
      runningStreams: 3,
    } as StreamsPageKpi
    render(<StreamsGroupKpiStrip kpi={kpi} />)
    const card = screen.getByTestId('streams-kpi-warning')
    expectSemanticWarning(screen.getByText('2'))
    const iconWrap = card.querySelector('svg')!.parentElement
    expectSemanticWarning(iconWrap)
    expect(iconWrap!.className).toContain('bg-status-warning-subtle')
  })

  it('Streams operations summary warning icon', () => {
    render(<StreamsOperationsSummaryStrip summary={{ healthy: 0, warning: 2, critical: 0, issues: 2, unknown: 0 }} />)
    const card = screen.getByTestId('streams-ops-summary-warning')
    const iconWrap = card.querySelector('svg')!.parentElement
    expectSemanticWarning(iconWrap)
    expect(iconWrap!.className).toContain('bg-status-warning-subtle')
  })
})
