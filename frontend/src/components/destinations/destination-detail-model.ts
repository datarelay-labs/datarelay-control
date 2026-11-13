/** View-model types and empty shell for destination detail (API-backed). */

export type DestinationKind = 'SYSLOG_UDP' | 'SYSLOG_TCP' | 'SYSLOG_TLS' | 'WEBHOOK_POST'

export type DestinationHealthState = 'HEALTHY' | 'DEGRADED' | 'ERROR'

export type DestinationRouteRow = {
  routeId: string
  routeName: string
  streamName: string
  deliveryMode: string
  status: 'ACTIVE' | 'PAUSED' | 'ERROR' | 'IDLE' | 'DEGRADED'
  epsAvg: number
  successRate24h: number
}

export type DeliveryActivityRow = {
  id: string
  time: string
  routeName: string
  status: 'SUCCESS' | 'RETRY' | 'FAILED'
  events: number
  latencyMs: number
  message: string
}

export type RecentFailureRow = {
  id: string
  at: string
  code: 'TIMEOUT' | 'CONN_REFUSED' | 'RATE_LIMIT' | 'TLS_HANDSHAKE'
  routeName: string
  failedEvents: number
}

export type DestinationDetailView = {
  id: string
  displayName: string
  subtitle: string
  health: DestinationHealthState
  kind: DestinationKind
  routeCount: number
  kpi: {
    delivery24h: number
    delivery24hTrend: string
    delivery24hTrendUp: boolean
    successRate24h: number
    successRateTrend: string
    successRateTrendUp: boolean
    avgLatencyMs24h: number
    latencyTrendLabel: string
    latencyTrendGood: boolean
    throughputEps: number
    throughputTrend: string
    throughputTrendUp: boolean
    failed24h: number
    failedTrend: string
    failedTrendBad: boolean
  }
  eventsOverTime: ReadonlyArray<{ label: string; success: number; failed: number }>
  latencyOverTime: ReadonlyArray<{ label: string; ms: number }>
  routes: readonly DestinationRouteRow[]
  recentActivity: readonly DeliveryActivityRow[]
  info: {
    name: string
    typeLabel: string
    host: string
    port: string
    protocol: string
    messageFormat: string
    createdAt: string
    createdBy: string
    lastUpdated: string
  }
  healthPanel: {
    summary: string
    lastCheckRelative: string
    uptime7dPct: number
    packetLoss24hPct: number
  }
  recentFailures: readonly RecentFailureRow[]
}

export function emptyDestinationDetail(destinationId: string): DestinationDetailView {
  const label = /^\d+$/.test(destinationId) ? `Destination #${destinationId}` : destinationId
  return {
    id: destinationId,
    displayName: label,
    subtitle: 'Destination endpoint for downstream delivery',
    health: 'DEGRADED',
    kind: 'SYSLOG_UDP',
    routeCount: 0,
    kpi: {
      delivery24h: 0,
      delivery24hTrend: '—',
      delivery24hTrendUp: true,
      successRate24h: 0,
      successRateTrend: '—',
      successRateTrendUp: true,
      avgLatencyMs24h: 0,
      latencyTrendLabel: '—',
      latencyTrendGood: true,
      throughputEps: 0,
      throughputTrend: '—',
      throughputTrendUp: true,
      failed24h: 0,
      failedTrend: '—',
      failedTrendBad: false,
    },
    eventsOverTime: [],
    latencyOverTime: [],
    routes: [],
    recentActivity: [],
    info: {
      name: label,
      typeLabel: '—',
      host: '—',
      port: '—',
      protocol: '—',
      messageFormat: '—',
      createdAt: '—',
      createdBy: '—',
      lastUpdated: '—',
    },
    healthPanel: {
      summary: 'Load operational health from runtime APIs.',
      lastCheckRelative: '—',
      uptime7dPct: 0,
      packetLoss24hPct: 0,
    },
    recentFailures: [],
  }
}

/** Shown when the API confirms the Destination id does not exist (a Retry cannot help). */
export const DESTINATION_NOT_FOUND_MESSAGE = 'Destination not found.'
