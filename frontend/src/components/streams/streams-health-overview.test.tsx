import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StreamsPageKpi } from '../../lib/stream-console-metrics'
import type { StreamOperationsSummary } from '../../lib/streams-console-operations'
import { StreamsHealthOverview } from './streams-health-overview'

function kpi(overrides: Partial<StreamsPageKpi> = {}): StreamsPageKpi {
  return {
    totalGroups: 1,
    totalStreams: 2,
    healthyGroups: 0,
    warningGroups: 0,
    criticalGroups: 0,
    totalIssues: 0,
    healthyPct: '0.0%',
    warningPct: '0.0%',
    criticalPct: '0.0%',
    healthyStreams: 0,
    warningStreams: 0,
    criticalStreams: 0,
    noDataStreams: 0,
    healthyStreamsPct: '0.0%',
    warningStreamsPct: '0.0%',
    criticalStreamsPct: '0.0%',
    totalEpsLabel: '—',
    runningStreams: 0,
    ...overrides,
  }
}

function summary(overrides: Partial<StreamOperationsSummary> = {}): StreamOperationsSummary {
  return { healthy: 0, warning: 0, critical: 0, issues: 0, unknown: 0, ...overrides }
}

function mount(k: StreamsPageKpi, s: StreamOperationsSummary, groups = 1) {
  return render(<StreamsHealthOverview kpi={k} summary={s} groupCount={groups} />)
}

describe('StreamsHealthOverview posture', () => {
  it('reads Healthy and the calm sentence only when every stream is healthy and none lacks data', () => {
    mount(kpi({ healthyStreams: 2, totalStreams: 2 }), summary({ healthy: 2 }))
    expect(screen.getByTestId('streams-health-posture')).toHaveTextContent('Healthy')
    expect(screen.getByTestId('streams-health-overview')).toHaveTextContent('All stream groups are operating normally')
  })

  it('never says all groups operate normally while streams are stopped or without data', () => {
    mount(kpi({ healthyStreams: 1, noDataStreams: 1, totalStreams: 2 }), summary({ healthy: 1 }))
    expect(screen.getByTestId('streams-health-overview')).not.toHaveTextContent('All stream groups are operating normally')
    expect(screen.getByTestId('streams-health-overview')).toHaveTextContent('1 stopped or without data')
  })

  it('reads Not verified (neutral unknown token) when an active stream has no verdict, even next to healthy ones', () => {
    mount(kpi({ healthyStreams: 1, noDataStreams: 1, totalStreams: 2 }), summary({ healthy: 1, unknown: 1 }))
    const posture = screen.getByTestId('streams-health-posture')
    expect(posture).toHaveTextContent('Not verified')
    expect(posture).toHaveClass('text-status-unknown')
    expect(screen.getByTestId('streams-health-overview')).toHaveClass('bg-status-unknown-subtle')
    expect(screen.getByTestId('streams-health-overview')).toHaveTextContent('1 active stream not observed yet')
    expect(screen.getByTestId('streams-ops-summary-unknown')).toHaveTextContent('1')
  })

  it('keeps Critical and Warning ahead of Not verified (Unknown never masks a confirmed problem)', () => {
    mount(kpi({ criticalStreams: 1, noDataStreams: 1, totalStreams: 2 }), summary({ critical: 1, unknown: 1 }))
    expect(screen.getByTestId('streams-health-posture')).toHaveTextContent('Critical')
  })

  it('keeps Warning ahead of Not verified', () => {
    mount(kpi({ warningStreams: 1, noDataStreams: 1, totalStreams: 2 }), summary({ warning: 1, unknown: 1 }))
    expect(screen.getByTestId('streams-health-posture')).toHaveTextContent('Warning')
  })

  it('shows No active streams (neutral, not Healthy) when there is nothing active to judge', () => {
    mount(kpi({ totalStreams: 0, totalGroups: 0 }), summary(), 0)
    const posture = screen.getByTestId('streams-health-posture')
    expect(posture).toHaveTextContent('No active streams')
    expect(posture).not.toHaveTextContent('Healthy')
    expect(posture).toHaveClass('text-status-unknown')
  })

  it('shows No active streams when every stream is stopped or paused', () => {
    mount(kpi({ noDataStreams: 3, totalStreams: 3 }), summary())
    expect(screen.getByTestId('streams-health-posture')).toHaveTextContent('No active streams')
  })
})
