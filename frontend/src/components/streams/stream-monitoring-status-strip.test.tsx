import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StreamMonitoringStatusStrip } from './stream-monitoring-status-strip'

const baseProps = {
  displayStatus: 'RUNNING' as const,
  backendStreamId: 1,
  hasRuntimeObsApi: true,
  eventsSparkline: [] as number[],
  deliveryPct: null,
  deliveryLabel: null,
  routesTotal: 0,
  routesOk: 0,
  routesErr: 0,
  showCheckpointObservability: false,
  failedLastHour: null,
  errorRate: null,
  lastErrorAt: null,
}

function metricValue(label: string): string {
  return screen.getByText(label).closest('div')?.parentElement?.textContent ?? ''
}

describe('StreamMonitoringStatusStrip measurement', () => {
  it('shows an em dash (not 0 events/sec) for ingest and delivery when nothing was measured', () => {
    render(<StreamMonitoringStatusStrip {...baseProps} events1h={null} runtimeMetrics={null} />)
    expect(metricValue('Ingest Rate')).toContain('—')
    expect(metricValue('Ingest Rate')).not.toContain('0 events/sec')
    expect(metricValue('Delivery Rate')).toContain('—')
    expect(metricValue('Delivery Rate')).not.toContain('0 events/sec')
  })

  it('keeps a measured zero as 0 events/sec', () => {
    render(<StreamMonitoringStatusStrip {...baseProps} events1h={0} runtimeMetrics={null} />)
    expect(metricValue('Ingest Rate')).toContain('0 events/sec')
  })
})

describe('StreamMonitoringStatusStrip', () => {
  it('shows em dash for success rate when no delivery outcomes exist', () => {
    render(
      <StreamMonitoringStatusStrip
        displayStatus="RUNNING"
        backendStreamId={1}
        hasRuntimeObsApi
        events1h={0}
        eventsSparkline={[]}
        deliveryPct={null}
        deliveryLabel={null}
        routesTotal={0}
        routesOk={0}
        routesErr={0}
        showCheckpointObservability={false}
        runtimeMetrics={{
          stream: { id: 1, name: 'A', status: 'RUNNING', last_run_at: null, last_success_at: null, last_error_at: null, last_checkpoint: null },
          kpis: {
            events_last_hour: 0,
            delivered_last_hour: 0,
            failed_last_hour: 0,
            delivery_success_rate: 100,
            avg_latency_ms: 0,
            max_latency_ms: 0,
            error_rate: 0,
          },
          events_over_time: [],
          route_health: [],
          checkpoint_history: [],
          recent_runs: [],
          route_runtime: [],
          recent_route_errors: [],
        }}
        failedLastHour={0}
        errorRate={0}
        lastErrorAt={null}
      />,
    )
    expect(screen.getByText('Success Rate').closest('div')?.parentElement).toHaveTextContent('—')
    expect(screen.getByText('Success Rate').closest('div')?.parentElement).not.toHaveTextContent('100.00%')
  })
})
