import {
  ArrowRight,
  ExternalLink,
  Loader2,
  MoreVertical,
  Play,
  RefreshCw,
  Server,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { formatThroughputEps } from '../../lib/observability-format'
import { NAV_PATH, logsExplorerPath, routeEditPath, streamRuntimePath } from '../../config/nav-paths'
import { StatusBadge } from '../shell/status-badge'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { DestinationOperationalHealthPanel } from './destination-operational-health-panel'
import { relativeShort } from '../routes/routes-overview-helpers'
import { useDestinationDetailData } from './use-destination-detail-data'
import type { DestinationUiHealth } from './destination-runtime-metrics'
import { extractCapacityConfig } from './destination-mini-charts'

type MainTab = 'overview' | 'routes' | 'delivery' | 'health' | 'failures'

function healthToneFromUi(h: DestinationUiHealth): 'success' | 'warning' | 'error' | 'neutral' {
  switch (h) {
    case 'Healthy':
      return 'success'
    case 'Warning':
    case 'Idle':
      return 'warning'
    case 'Critical':
      return 'error'
    default:
      return 'neutral'
  }
}

function deliveryActivityTone(s: 'SUCCESS' | 'RETRY' | 'FAILED'): 'success' | 'warning' | 'error' {
  switch (s) {
    case 'SUCCESS':
      return 'success'
    case 'RETRY':
      return 'warning'
    case 'FAILED':
      return 'error'
    default: {
      const _e: never = s
      return _e
    }
  }
}

function failureBadgeClass(code: string): string {
  switch (code) {
    case 'RATE_LIMIT':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-900 dark:text-amber-200'
    default:
      return 'border-red-500/40 bg-red-500/15 text-red-900 dark:text-red-200'
  }
}

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2.5 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">{hint}</p> : null}
    </div>
  )
}

export function DestinationDetailPage() {
  const { destinationId = '' } = useParams<{ destinationId: string }>()
  const backendDestinationNumericId = useMemo(
    () => (/^\d+$/.test(String(destinationId)) ? Number(destinationId) : null),
    [destinationId],
  )

  const runtime = useDestinationDetailData(backendDestinationNumericId)
  const [mainTab, setMainTab] = useState<MainTab>('overview')
  const [moreOpen, setMoreOpen] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)
  const moreRef = useRef<HTMLDivElement>(null)

  const displayName = runtime.destination?.name ?? `Destination #${destinationId}`
  const subtitle =
    runtime.destination != null
      ? `${runtime.destination.destination_type.replace(/_/g, ' ')} destination`
      : 'Destination endpoint for downstream delivery'

  const tabs: { key: MainTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'routes', label: `Routes (${runtime.connectedRoutes.length})` },
    { key: 'delivery', label: 'Delivery' },
    { key: 'health', label: 'Health' },
    { key: 'failures', label: `Failures (${runtime.failed24h})` },
  ]

  const cfg = runtime.destination?.config_json ?? {}
  const host = typeof cfg.host === 'string' ? cfg.host : typeof cfg.url === 'string' ? String(cfg.url) : '—'
  const port = cfg.port != null ? String(cfg.port) : '—'
  const capacitySource = runtime.destination ?? runtime.listRow
  const { limitEps: capacityLimitEps, thresholds: capacityThresholds } = extractCapacityConfig(
    capacitySource ?? {},
  )
  const capacityUsagePct =
    capacityLimitEps != null && capacityLimitEps > 0 && runtime.currentEps != null
      ? Math.round((runtime.currentEps / capacityLimitEps) * 100)
      : null

  async function onTestConnection() {
    const result = await runtime.runConnectivityTest()
    setTestMessage(`${result.success ? 'Success' : 'Failed'}: ${result.message}`)
  }

  if (backendDestinationNumericId == null) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-[13px] text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100">
        Invalid destination id. Open a destination from the Destinations list.
      </div>
    )
  }

  if (runtime.loading && runtime.destination == null) {
    return (
      <p className="inline-flex items-center gap-2 p-6 text-[12px] text-slate-600 dark:text-gdc-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading destination…
      </p>
    )
  }

  if (runtime.error && runtime.destination == null) {
    return (
      <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 px-4 py-6 dark:border-red-900/40 dark:bg-red-950/30">
        <p className="text-[13px] font-semibold text-red-900 dark:text-red-100">Failed to load destination</p>
        <p className="text-[12px] text-red-800 dark:text-red-200">{runtime.error}</p>
        <button
          type="button"
          onClick={() => void runtime.refresh()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 text-[12px] font-semibold text-red-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">{displayName}</h2>
            <StatusBadge tone={healthToneFromUi(runtime.uiHealth)} className="uppercase">
              {runtime.uiHealth}
            </StatusBadge>
          </div>
          <p className="max-w-2xl text-[13px] text-slate-600 dark:text-gdc-muted">{subtitle}</p>
          {runtime.error ? (
            <p className="text-[12px] font-medium text-amber-800 dark:text-amber-300">
              Partial runtime data: {runtime.error}
            </p>
          ) : null}
          {testMessage ? <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{testMessage}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void onTestConnection()}
            disabled={runtime.testBusy}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-800 shadow-sm hover:bg-slate-50 disabled:opacity-70 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
          >
            {runtime.testBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" aria-hidden />}
            Test Connection
          </button>
          <Link
            to={NAV_PATH.destinations}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200/90 bg-white px-3 text-[12px] font-semibold text-slate-800 shadow-sm dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
          >
            Back to list
          </Link>
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] font-semibold text-slate-700 shadow-sm dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
            >
              <MoreVertical className="h-4 w-4" aria-hidden />
              More
            </button>
            {moreOpen ? (
              <div className="absolute right-0 z-30 mt-1 w-52 rounded-md border border-slate-200/90 bg-white py-1 shadow-lg dark:border-gdc-border dark:bg-gdc-card">
                <Link
                  to={logsExplorerPath({ destination_id: backendDestinationNumericId })}
                  className="block px-3 py-2 text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover"
                  onClick={() => setMoreOpen(false)}
                >
                  View delivery logs
                </Link>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover"
                  onClick={() => {
                    setMoreOpen(false)
                    void runtime.refresh()
                  }}
                >
                  Refresh runtime data
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200/80 pb-px dark:border-gdc-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setMainTab(t.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-[12px] font-semibold transition-colors',
              mainTab === t.key
                ? 'border-slate-900 text-slate-900 dark:border-slate-100 dark:text-slate-50'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mainTab === 'health' ? (
        <DestinationOperationalHealthPanel
          destinationId={backendDestinationNumericId}
          preload={{
            healthRow: runtime.healthRow,
            failuresAnalytics: runtime.failuresAnalytics,
          }}
        />
      ) : null}

      {mainTab === 'overview' ? (
        <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div className="flex min-w-0 flex-col gap-4">
            <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" aria-label="Destination KPI summary">
              <KpiCard
                label="Success rate (24h)"
                value={runtime.successRatePct != null ? `${runtime.successRatePct}%` : '—'}
              />
              <KpiCard
                label="Current throughput"
                value={runtime.currentEps != null ? `${formatThroughputEps(runtime.currentEps)} EPS` : '—'}
                hint="From operational snapshot (1m window)"
              />
              <KpiCard
                label="Maximum EPS"
                value={capacityLimitEps != null ? capacityLimitEps.toLocaleString() : 'No limit'}
                hint={
                  capacityLimitEps != null
                    ? `Warn ${capacityThresholds.warningPct}% · Critical ${capacityThresholds.criticalPct}%`
                    : 'Configured capacity not set'
                }
              />
              <KpiCard
                label="Capacity usage"
                value={capacityUsagePct != null ? `${capacityUsagePct}%` : '—'}
                hint={
                  capacityLimitEps != null && runtime.currentEps != null
                    ? `${formatThroughputEps(runtime.currentEps)} / ${capacityLimitEps.toLocaleString()} EPS`
                    : undefined
                }
              />
              <KpiCard label="Failed events (24h)" value={runtime.failed24h.toLocaleString()} />
              <KpiCard
                label="Last delivery"
                value={runtime.lastDeliveryAt ? relativeShort(runtime.lastDeliveryAt) : '—'}
              />
            </section>

            <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Connected streams</h3>
              {runtime.connectedStreams.length === 0 ? (
                <p className="mt-2 text-[12px] text-slate-500">No streams route to this destination.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {runtime.connectedStreams.map((s) => (
                    <li key={s.streamId}>
                      <Link
                        to={streamRuntimePath(String(s.streamId))}
                        className="text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      >
                        {s.streamName}
                      </Link>
                      <span className="ml-2 font-mono text-[10px] text-slate-500">#{s.streamId}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <RoutesTable routes={runtime.connectedRoutes} />
          </div>

          <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-24 xl:self-start">
            <DestinationInfoPanel
              name={runtime.destination?.name ?? displayName}
              typeLabel={runtime.destination?.destination_type ?? '—'}
              host={host}
              port={port}
              enabled={runtime.destination?.enabled ?? false}
              capacityLimitEps={capacityLimitEps}
              capacityUsagePct={capacityUsagePct}
              createdAt={runtime.destination?.created_at?.slice(0, 19).replace('T', ' ') ?? '—'}
              lastUpdated={runtime.destination?.updated_at?.slice(0, 19).replace('T', ' ') ?? '—'}
            />
            <RuntimeHealthSidebar
              uiHealth={runtime.uiHealth}
              lastError={runtime.lastErrorMessage}
              lastDeliveryAt={runtime.lastDeliveryAt}
            />
            <RecentFailuresSidebar
              failures={runtime.recentFailures}
              destinationId={backendDestinationNumericId}
            />
          </aside>
        </div>
      ) : null}

      {mainTab === 'routes' ? <RoutesTable routes={runtime.connectedRoutes} full /> : null}

      {mainTab === 'delivery' ? (
        <DeliveryActivityTable
          rows={runtime.recentActivity}
          destinationId={backendDestinationNumericId}
          emptyMessage="No delivery log entries in the last 24 hours for this destination."
        />
      ) : null}

      {mainTab === 'failures' ? (
        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recent failure events (24h)</h3>
            <p className="mt-1 text-2xl font-bold tabular-nums text-red-700 dark:text-red-300">{runtime.failed24h}</p>
          </section>
          <DeliveryActivityTable
            rows={runtime.recentActivity}
            destinationId={backendDestinationNumericId}
            emptyMessage="No failed delivery events in the last 24 hours."
            failuresOnly
          />
          <RecentFailuresList failures={runtime.recentFailures} />
        </div>
      ) : null}

      {mainTab !== 'overview' && mainTab !== 'routes' && mainTab !== 'delivery' && mainTab !== 'health' && mainTab !== 'failures' ? (
        <section className="rounded-xl border border-dashed border-slate-200/90 bg-slate-50/50 px-4 py-8 text-center dark:border-gdc-border dark:bg-gdc-card">
          <Server className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
          <p className="mt-2 text-[13px] font-semibold text-slate-800 dark:text-slate-200">Tab not available</p>
        </section>
      ) : null}
    </div>
  )
}

function RoutesTable({
  routes,
  full,
}: {
  routes: ReturnType<typeof useDestinationDetailData>['connectedRoutes']
  full?: boolean
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="border-b border-slate-200/70 px-3 py-2 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Routes using this destination</h3>
      </div>
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Route</th>
              <th className={opTh}>Stream</th>
              <th className={opTh}>Delivery mode</th>
              <th className={opTh}>Status</th>
              <th className={cn(opTh, 'tabular-nums')}>EPS (1m)</th>
              <th className={cn(opTh, 'tabular-nums')}>Success (24h)</th>
              <th className={cn(opTh, 'text-right')}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 ? (
              <tr className={opTr}>
                <td className={opTd} colSpan={7}>
                  No routes reference this destination.
                </td>
              </tr>
            ) : (
              (full ? routes : routes.slice(0, 8)).map((r) => (
                <tr key={r.routeId} className={opTr}>
                  <td className={cn(opTd, 'font-medium')}>{r.routeName}</td>
                  <td className={opTd}>
                    <Link
                      to={streamRuntimePath(String(r.streamId))}
                      className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {r.streamName}
                    </Link>
                  </td>
                  <td className={opTd}>{r.deliveryMode}</td>
                  <td className={opTd}>
                    <StatusBadge
                      tone={r.status === 'ACTIVE' ? 'success' : r.status === 'ERROR' ? 'error' : 'warning'}
                      className="uppercase"
                    >
                      {r.status}
                    </StatusBadge>
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>{formatThroughputEps(r.epsAvg)}</td>
                  <td className={cn(opTd, 'tabular-nums')}>
                    {r.successRate24h > 0 ? `${r.successRate24h.toFixed(1)}%` : '—'}
                  </td>
                  <td className={cn(opTd, 'text-right')}>
                    <Link
                      to={routeEditPath(r.routeId)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      View route
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function DeliveryActivityTable({
  rows,
  destinationId,
  emptyMessage,
  failuresOnly,
}: {
  rows: ReturnType<typeof useDestinationDetailData>['recentActivity']
  destinationId: number
  emptyMessage: string
  failuresOnly?: boolean
}) {
  const display = failuresOnly ? rows.filter((r) => r.status === 'FAILED') : rows
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="border-b border-slate-200/70 px-3 py-2 dark:border-gdc-border">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recent delivery activity</h3>
      </div>
      <div className="overflow-x-auto">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Time</th>
              <th className={opTh}>Route</th>
              <th className={opTh}>Status</th>
              <th className={cn(opTh, 'tabular-nums')}>Latency</th>
              <th className={opTh}>Message</th>
            </tr>
          </thead>
          <tbody>
            {display.length === 0 ? (
              <tr className={opTr}>
                <td className={opTd} colSpan={5}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              display.map((row) => (
                <tr key={row.id} className={opTr}>
                  <td className={cn(opTd, 'whitespace-nowrap font-mono text-[11px]')}>{row.time}</td>
                  <td className={opTd}>{row.routeName}</td>
                  <td className={opTd}>
                    <StatusBadge tone={deliveryActivityTone(row.status)} className="uppercase">
                      {row.status}
                    </StatusBadge>
                  </td>
                  <td className={cn(opTd, 'tabular-nums')}>{row.latencyMs} ms</td>
                  <td className={cn(opTd, 'max-w-[320px] truncate text-[11px]')}>{row.message}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-200/80 px-3 py-2 dark:border-gdc-border">
        <Link
          to={logsExplorerPath({ destination_id: destinationId })}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          View all delivery logs
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  )
}

function DestinationInfoPanel({
  name,
  typeLabel,
  host,
  port,
  enabled,
  capacityLimitEps,
  capacityUsagePct,
  createdAt,
  lastUpdated,
}: {
  name: string
  typeLabel: string
  host: string
  port: string
  enabled: boolean
  capacityLimitEps: number | null
  capacityUsagePct: number | null
  createdAt: string
  lastUpdated: string
}) {
  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card" data-testid="destination-info-panel">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Destination info</h3>
      <dl className="mt-3 space-y-2 text-[12px]">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Name</dt>
          <dd className="font-medium text-slate-900 dark:text-slate-100">{name}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Type</dt>
          <dd className="font-mono text-[11px]">{typeLabel}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Host / URL</dt>
          <dd className="max-w-[55%] truncate font-mono text-[11px]">{host}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Port</dt>
          <dd className="font-mono tabular-nums">{port}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Enabled</dt>
          <dd>{enabled ? 'Yes' : 'No'}</dd>
        </div>
        <div className="flex justify-between gap-2" data-testid="destination-capacity-maximum">
          <dt className="text-slate-500">Maximum EPS</dt>
          <dd className="font-medium tabular-nums">
            {capacityLimitEps != null ? capacityLimitEps.toLocaleString() : 'No limit'}
          </dd>
        </div>
        <div className="flex justify-between gap-2" data-testid="destination-capacity-usage">
          <dt className="text-slate-500">Capacity usage</dt>
          <dd className="font-medium tabular-nums">{capacityUsagePct != null ? `${capacityUsagePct}%` : '—'}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Created</dt>
          <dd className="text-[11px]">{createdAt}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Updated</dt>
          <dd className="text-[11px]">{lastUpdated}</dd>
        </div>
      </dl>
    </section>
  )
}

function RuntimeHealthSidebar({
  uiHealth,
  lastError,
  lastDeliveryAt,
}: {
  uiHealth: DestinationUiHealth
  lastError: string | null
  lastDeliveryAt: string | null
}) {
  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Runtime health</h3>
      <div className="mt-3">
        <StatusBadge tone={healthToneFromUi(uiHealth)} className="uppercase">
          {uiHealth}
        </StatusBadge>
        <ul className="mt-3 space-y-1.5 text-[11px]">
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Last activity</span>
            <span className="font-medium">{lastDeliveryAt ? relativeShort(lastDeliveryAt) : '—'}</span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-500">Current throughput</span>
            <span className="font-medium">See KPI strip</span>
          </li>
        </ul>
        {lastError ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100">
            {lastError}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function RecentFailuresSidebar({
  failures,
  destinationId,
}: {
  failures: ReturnType<typeof useDestinationDetailData>['recentFailures']
  destinationId: number
}) {
  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Recent failures</h3>
        <Link
          to={logsExplorerPath({ destination_id: destinationId })}
          className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          View all
        </Link>
      </div>
      <RecentFailuresList failures={failures} compact />
    </section>
  )
}

function RecentFailuresList({
  failures,
  compact,
}: {
  failures: ReturnType<typeof useDestinationDetailData>['recentFailures']
  compact?: boolean
}) {
  if (failures.length === 0) {
    return <p className={cn('text-[12px] text-slate-500', compact ? 'mt-3' : 'px-1 py-2')}>No recent failures in window.</p>
  }
  return (
    <ul className={cn('space-y-3', compact ? 'mt-3' : 'mt-2')}>
      {failures.map((f) => (
        <li key={f.id} className="border-b border-slate-100 pb-3 last:border-0 dark:border-gdc-border">
          <p className="font-mono text-[10px] text-slate-500">{f.at}</p>
          <span
            className={cn(
              'mt-1 inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
              failureBadgeClass(f.code),
            )}
          >
            {f.code}
          </span>
          <p className="mt-1 text-[11px] font-medium text-slate-800 dark:text-slate-200">{f.routeName}</p>
          {f.message ? <p className="text-[11px] text-slate-600 dark:text-gdc-muted">{f.message}</p> : null}
        </li>
      ))}
    </ul>
  )
}
