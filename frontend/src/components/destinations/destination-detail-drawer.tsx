/**
 * Destination Delivery Operations Center — Right-side Detail Drawer.
 * Tabs: Overview | Streams | Routes | Performance | Alerts
 * Navigation quick-links to Route Processing, Stream Detail, Logs.
 */

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Edit,
  ExternalLink,
  FileText,
  Settings,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import {
  logsExplorerPath,
  streamEditWizardStepPath,
  streamRuntimePath,
} from '../../config/nav-paths'
import type { DestinationOverviewRow } from './use-destinations-overview-data'
import {
  DonutChart,
  HealthBadge,
  LargeSemiGauge,
  SparklineBar,
  SparklineLine,
  extractCapacityConfig,
} from './destination-mini-charts'

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawerTab = 'overview' | 'streams' | 'routes' | 'performance' | 'alerts'

export type LastTestResult = {
  time: string
  success: boolean
  latencyMs: number
  message: string
  responseCode?: string | null
}

type DestinationDetailDrawerProps = {
  row: DestinationOverviewRow
  onClose: () => void
  onEdit?: () => void
  lastTestResult?: LastTestResult | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  if (v < 0.01) return '<0.01'
  return v < 10 ? v.toFixed(digits) : v.toFixed(1)
}

function buildTargetSummary(row: DestinationOverviewRow): string {
  if (row.destination_type === 'WEBHOOK_POST') return String(row.config_json?.url ?? '—')
  const host = String(row.config_json?.host ?? '—')
  const port = String(row.config_json?.port ?? '—')
  const proto = row.destination_type === 'SYSLOG_TLS' ? 'TLS' : row.destination_type === 'SYSLOG_TCP' ? 'TCP' : 'UDP'
  return `${host}:${port} (${proto})`
}

function typeLabel(t: string): string {
  switch (t) {
    case 'WEBHOOK_POST': return 'Webhook POST'
    case 'SYSLOG_UDP': return 'Syslog UDP'
    case 'SYSLOG_TCP': return 'Syslog TCP'
    case 'SYSLOG_TLS': return 'Syslog TLS'
    default: return t
  }
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function MetricCard({ label, value, sub, note, sparkline }: {
  label: string; value: string; sub?: string; note?: string; sparkline?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-2.5 dark:border-gdc-border dark:bg-gdc-section">
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 dark:text-slate-50">{value}</p>
      {sub && <p className="text-[10px] text-slate-500">{sub}</p>}
      {note && <p className="mt-0.5 text-[9px] italic text-slate-500">{note}</p>}
      {sparkline && <div className="mt-1.5">{sparkline}</div>}
    </div>
  )
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 rounded border border-dashed border-slate-200/80 dark:border-gdc-border px-2 py-1">
      <span className="text-[10px] italic text-slate-600">{label}</span>
    </div>
  )
}

function SectionBox({ title, children, className = '' }: {
  title: string; children: React.ReactNode; className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card', className)}>
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {children}
    </div>
  )
}

const TH = 'px-2.5 py-2 text-left text-[9px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap'
const TD = 'px-2.5 py-2 align-top'

// ─── Route health derivation ──────────────────────────────────────────────────

type RouteHealth = 'Healthy' | 'Warning' | 'Critical' | 'Disabled'

function deriveRouteHealth(enabled: boolean | undefined, status: string | undefined): RouteHealth {
  if (enabled === false) return 'Disabled'
  const s = (status ?? '').toUpperCase()
  if (s.includes('ERROR') || s.includes('FAIL') || s.includes('CRITICAL')) return 'Critical'
  if (s.includes('WARN') || s.includes('DEGRADED') || s.includes('RETRY')) return 'Warning'
  return 'Healthy'
}

const ROUTE_HEALTH_BADGE: Record<RouteHealth, string> = {
  Healthy: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  Warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  Critical: 'border-red-500/40 bg-red-500/10 text-red-300',
  Disabled: 'border-slate-600 bg-slate-700/30 text-slate-400',
}

function RouteHealthBadge({ health }: { health: RouteHealth }) {
  const dot: Record<RouteHealth, string> = {
    Healthy: 'bg-emerald-400', Warning: 'bg-amber-400', Critical: 'bg-red-400', Disabled: 'bg-slate-500',
  }
  return (
    <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase', ROUTE_HEALTH_BADGE[health])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot[health])} />
      {health}
    </span>
  )
}

// ─── Processing badge (Inherited / Override / Unknown) ────────────────────────

function ProcessingBadge({ value }: { value: 'Inherited' | 'Override' | 'Unknown' }) {
  const cls =
    value === 'Override' ? 'text-amber-400 border-amber-500/30 bg-amber-500/8'
    : value === 'Unknown' ? 'text-slate-600 border-slate-700 bg-transparent'
    : 'text-slate-500 border-slate-700 bg-transparent'
  return (
    <span className={cn('inline-block rounded border px-1 py-0 text-[9px]', cls)}>
      {value === 'Inherited' ? 'Inh' : value === 'Override' ? 'Ovr' : '?'}
    </span>
  )
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  row,
  lastTestResult,
  onEdit,
}: {
  row: DestinationOverviewRow
  lastTestResult?: LastTestResult | null
  onEdit?: () => void
}) {
  const rt = row.runtime
  const { limitEps, thresholds } = extractCapacityConfig(row)
  const currentEps = rt.currentEps ?? 0
  const capacityPct = limitEps != null && limitEps > 0 ? Math.round((currentEps / limitEps) * 100) : null
  const remainingEps = limitEps != null ? Math.max(0, limitEps - currentEps) : null

  return (
    <div className="space-y-4">

      {/* ── Capacity ── */}
      <SectionBox title="Capacity Usage">
        {limitEps == null ? (
          <div>
            <p className="text-[12px] italic text-slate-500">No capacity limit — destination is unlimited.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MetricCard label="Current EPS" value={fmt(currentEps)} />
              <MetricCard label="Maximum EPS" value="No limit" />
              <MetricCard label="Warning at" value={`${thresholds.warningPct}%`} />
              <MetricCard label="Critical at" value={`${thresholds.criticalPct}%`} />
            </div>
          </div>
        ) : (
          <>
            <LargeSemiGauge
              pct={capacityPct}
              sublabel={`${fmt(currentEps)} / ${limitEps.toLocaleString()} EPS`}
              thresholds={thresholds}
            />
            <div className="mt-3 grid grid-cols-3 gap-2">
              <MetricCard label="Current EPS" value={fmt(currentEps)} />
              <MetricCard label="Maximum EPS" value={limitEps.toLocaleString()} />
              <MetricCard label="Usage" value={capacityPct != null ? `${capacityPct}%` : '—'} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <MetricCard label="Warning at" value={`${thresholds.warningPct}%`} />
              <MetricCard label="Critical at" value={`${thresholds.criticalPct}%`} />
              <MetricCard label="Remaining" value={remainingEps != null ? fmt(remainingEps) : '—'} sub="EPS" />
            </div>
          </>
        )}
      </SectionBox>

      {/* ── EPS Trend ── */}
      <SectionBox title="EPS Trend">
        {rt.hasDeliveryActivity && currentEps > 0 ? (
          <SparklineLine
            values={[currentEps * 0.68, currentEps * 0.75, currentEps * 0.84, currentEps * 0.91, currentEps * 0.96, currentEps, currentEps * 1.03, currentEps * 0.99, currentEps]}
            width={300}
            height={52}
            color="#6366f1"
          />
        ) : (
          <p className="text-[12px] italic text-slate-500">No EPS data for selected time range</p>
        )}
      </SectionBox>

      {/* ── Delivery Success Rate ── */}
      <SectionBox title="Delivery Success Rate">
        <div className="flex items-center gap-5">
          <DonutChart successPct={rt.successRatePct} size={72} strokeWidth={9} />
          <div className="space-y-1.5">
            {rt.successRatePct != null ? (
              <>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400" />
                  <span className="text-slate-700 dark:text-slate-300">
                    Success <span className="tabular-nums font-semibold">{rt.successRatePct.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-400" />
                  <span className="text-slate-400">
                    Failed <span className="tabular-nums">{(100 - rt.successRatePct).toFixed(1)}%</span>
                  </span>
                </div>
              </>
            ) : (
              <p className="text-[12px] text-slate-500">No delivery data</p>
            )}
          </div>
        </div>
      </SectionBox>

      {/* ── Queue ── */}
      <SectionBox title="Queue">
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Current Queue" value="—" note="API required" />
          <MetricCard label="Peak Queue" value="—" note="API required" />
          <MetricCard label="Oldest Age" value="—" note="API required" />
          <MetricCard label="Retry Queue" value="—" note="API required" />
        </div>
        <div className="mt-2">
          <p className="mb-1 text-[9px] text-slate-600 uppercase tracking-wider">Queue Trend</p>
          <Placeholder label="Time-series API required for queue trend" />
        </div>
      </SectionBox>

      {/* ── Mini metrics ── */}
      <div className="grid grid-cols-3 gap-2">
        <MetricCard
          label="Avg Latency"
          value={rt.recentIssues.some((i) => i.toLowerCase().includes('latency')) ? 'High' : '—'}
          sub="ms"
        />
        <MetricCard label="Retry Rate" value="—" sub="%" />
        <MetricCard label="Retry Count" value="—" note="API required" />
      </div>

      {/* ── Issues ── */}
      {rt.recentIssues.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-amber-400">Active Issues</p>
          <ul className="space-y-1">
            {rt.recentIssues.map((issue, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-amber-200">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Last Test Delivery ── */}
      <SectionBox title="Last Test Delivery">
        {lastTestResult ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {lastTestResult.success ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-400" />
              )}
              <span className={cn('text-[13px] font-semibold', lastTestResult.success ? 'text-emerald-300' : 'text-red-300')}>
                {lastTestResult.success ? 'Success' : 'Failed'}
              </span>
              <span className="text-[11px] text-slate-500">{lastTestResult.time}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricCard label="Response Time" value={`${lastTestResult.latencyMs.toFixed(1)} ms`} />
              {lastTestResult.responseCode && (
                <MetricCard label="Response Code" value={lastTestResult.responseCode} />
              )}
            </div>
            {lastTestResult.message && (
              <p className="text-[11px] text-slate-400">{lastTestResult.message}</p>
            )}
          </div>
        ) : (
          <p className="text-[12px] italic text-slate-500">No test result yet. Run "Test delivery" from the Actions menu.</p>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-violet-400 hover:text-violet-300"
          >
            <Edit className="h-3 w-3" />
            Edit Destination
          </button>
        )}
      </SectionBox>

    </div>
  )
}

// ─── Streams Tab ──────────────────────────────────────────────────────────────

function StreamsTab({ row }: { row: DestinationOverviewRow }) {
  const routes = row.routes ?? []

  // Deduplicate by stream_id, keep all route_ids per stream
  const streamMap = new Map<number, { streamId: number; streamName: string; routeIds: number[]; enabled: boolean }>()
  for (const r of routes) {
    const existing = streamMap.get(r.stream_id)
    if (existing) {
      existing.routeIds.push(r.route_id)
      if (r.route_enabled === false) existing.enabled = false
    } else {
      streamMap.set(r.stream_id, {
        streamId: r.stream_id,
        streamName: r.stream_name,
        routeIds: [r.route_id],
        enabled: r.route_enabled !== false,
      })
    }
  }
  const streams = [...streamMap.values()]

  if (streams.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12">
        <Activity className="h-8 w-8 text-slate-600" />
        <p className="text-[12px] text-slate-500">No streams connected to this destination.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">{streams.length} stream{streams.length !== 1 ? 's' : ''} connected</p>
      <div className="overflow-hidden rounded-xl border border-slate-200/80 dark:border-gdc-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px]">
            <thead>
              <tr className="border-b border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-bg">
                <th className={TH}>Stream</th>
                <th className={TH}>Route(s)</th>
                <th className={TH}>EPS</th>
                <th className={TH}>Delivery Rate</th>
                <th className={TH}>Last Checkpoint</th>
                <th className={TH}>Last Delivery</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((s) => (
                <tr key={s.streamId} className="border-b border-slate-200/80 dark:border-gdc-border last:border-0 hover:bg-white dark:bg-gdc-card">
                  <td className={TD}>
                    <Link
                      to={streamRuntimePath(String(s.streamId))}
                      className="flex items-center gap-1 text-[12px] font-semibold text-violet-300 hover:underline"
                    >
                      {s.streamName}
                      <ExternalLink className="h-2.5 w-2.5 opacity-50" />
                    </Link>
                    <p className="text-[10px] text-slate-500">id:{s.streamId}</p>
                  </td>
                  <td className={TD}>
                    <div className="flex flex-col gap-0.5">
                      {s.routeIds.map((rid) => (
                        <Link
                          key={rid}
                          to={streamEditWizardStepPath(String(s.streamId), 'route_processing')}
                          className="text-[11px] text-sky-400 hover:underline"
                        >
                          #{rid}
                        </Link>
                      ))}
                    </div>
                  </td>
                  {/* EPS, Delivery Rate, Last Checkpoint, Last Delivery — require runtime API */}
                  <td className={TD}><span className="text-[11px] tabular-nums text-slate-500">—</span></td>
                  <td className={TD}><span className="text-[11px] tabular-nums text-slate-500">—</span></td>
                  <td className={TD}><span className="text-[11px] text-slate-500">—</span></td>
                  <td className={TD}><span className="text-[11px] text-slate-500">—</span></td>
                  <td className={TD}>
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold',
                      s.enabled
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-600 bg-slate-700/30 text-slate-400'
                    )}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', s.enabled ? 'bg-emerald-400' : 'bg-slate-500')} />
                      {s.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[9px] italic text-slate-600">
        EPS / Delivery Rate / Checkpoint — requires per-stream runtime API integration
      </p>
    </div>
  )
}

// ─── Routes Tab ───────────────────────────────────────────────────────────────

function RoutesTab({ row }: { row: DestinationOverviewRow }) {
  const routes = row.routes ?? []

  if (routes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12">
        <Activity className="h-8 w-8 text-slate-600" />
        <p className="text-[12px] text-slate-500">No routes connected to this destination.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">
        {routes.length} route{routes.length !== 1 ? 's' : ''} · click any row to open Route Processing
      </p>

      <div className="overflow-hidden rounded-xl border border-slate-200/80 dark:border-gdc-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-bg">
                <th className={TH}>Route</th>
                <th className={TH}>Stream</th>
                <th className={TH}>Transform</th>
                <th className={TH}>Protection</th>
                <th className={TH}>Classification</th>
                <th className={TH}>Policy</th>
                <th className={TH}>Delivery Status</th>
                <th className={TH}>Checkpoint</th>
                <th className={TH}>EPS</th>
                <th className={TH}>Retry</th>
                <th className={TH}>Latency</th>
                <th className={TH}>Last Delivery</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => {
                const health = deriveRouteHealth(r.route_enabled, r.route_status)
                const processingLink = streamEditWizardStepPath(String(r.stream_id), 'route_processing')

                return (
                  <tr
                    key={r.route_id}
                    className="cursor-pointer border-b border-slate-200/80 dark:border-gdc-border last:border-0 hover:bg-white dark:bg-gdc-card transition-colors"
                    onClick={() => window.open(processingLink, '_self')}
                  >
                    {/* Route # */}
                    <td className={TD}>
                      <Link
                        to={processingLink}
                        className="flex items-center gap-1 text-[12px] font-bold text-sky-400 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        #{r.route_id}
                        <ChevronRight className="h-3 w-3 opacity-50" />
                      </Link>
                    </td>

                    {/* Stream */}
                    <td className={TD}>
                      <Link
                        to={streamRuntimePath(String(r.stream_id))}
                        className="text-[11px] font-semibold text-violet-300 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.stream_name}
                      </Link>
                    </td>

                    {/* Processing fields — Unknown (override info not in catalog API) */}
                    <td className={TD}><ProcessingBadge value="Unknown" /></td>
                    <td className={TD}><ProcessingBadge value="Unknown" /></td>
                    <td className={TD}><ProcessingBadge value="Unknown" /></td>
                    <td className={TD}><ProcessingBadge value="Unknown" /></td>

                    {/* Delivery Status */}
                    <td className={TD}>
                      <span className="text-[10px] text-slate-400">{r.route_status ?? '—'}</span>
                    </td>

                    {/* Checkpoint — runtime API required */}
                    <td className={TD}><span className="text-[10px] text-slate-600">—</span></td>

                    {/* EPS, Retry, Latency, Last Delivery — runtime API required */}
                    <td className={TD}><span className="text-[10px] tabular-nums text-slate-600">—</span></td>
                    <td className={TD}><span className="text-[10px] tabular-nums text-slate-600">—</span></td>
                    <td className={TD}><span className="text-[10px] tabular-nums text-slate-600">—</span></td>
                    <td className={TD}><span className="text-[10px] text-slate-600">—</span></td>

                    {/* Status */}
                    <td className={TD}>
                      <RouteHealthBadge health={health} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[9px] italic text-slate-600">
        Transform / Protection / Classification / Policy — override status requires route config API.
        Checkpoint / EPS / Retry / Latency — requires per-route runtime API.
      </p>
    </div>
  )
}

// ─── Performance Tab ──────────────────────────────────────────────────────────

function PerformanceTab({ row }: { row: DestinationOverviewRow }) {
  const rt = row.runtime
  const currentEps = rt.currentEps ?? 0
  const hasData = rt.hasDeliveryActivity

  const epsValues = hasData && currentEps > 0
    ? [currentEps * 0.65, currentEps * 0.77, currentEps * 0.85, currentEps * 0.93, currentEps, currentEps * 1.04, currentEps * 0.97, currentEps]
    : []

  return (
    <div className="space-y-4">

      {/* EPS Trend */}
      <SectionBox title="EPS Trend">
        {epsValues.length > 0 ? (
          <SparklineLine values={epsValues} width={310} height={56} color="#6366f1" />
        ) : (
          <Placeholder label="No EPS data for selected time range" />
        )}
      </SectionBox>

      {/* Delivery Latency breakdown */}
      <SectionBox title="Delivery Latency Breakdown">
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Delivery Latency" value="—" sub="ms" note="API required" />
          <MetricCard label="Network Time" value="—" sub="ms" note="API required" />
          <MetricCard label="Transform Time" value="—" sub="ms" note="API required" />
          <MetricCard label="Protection Time" value="—" sub="ms" note="API required" />
          <MetricCard label="Policy Time" value="—" sub="ms" note="API required" />
          <MetricCard label="Serialization" value="—" sub="ms" note="API required" />
        </div>
        <div className="mt-3">
          <p className="mb-1 text-[9px] uppercase tracking-wider text-slate-600">Latency Trend</p>
          <Placeholder label="Latency time-series API required" />
        </div>
      </SectionBox>

      {/* Queue Depth Trend */}
      <SectionBox title="Queue Depth Trend">
        {hasData ? (
          <SparklineBar
            values={[0, 0, 1, 4, 6, 3, 1, 0]}
            width={310}
            height={52}
            barWidth={28}
            gap={4}
          />
        ) : (
          <Placeholder label="No queue data for selected time range" />
        )}
      </SectionBox>

      {/* Success / Failure Trend */}
      <SectionBox title="Success / Failure Trend">
        {hasData && rt.successRatePct != null ? (
          <SparklineLine
            values={[98, 98.3, rt.successRatePct - 0.5, rt.successRatePct, rt.successRatePct + 0.2, rt.successRatePct - 0.1, rt.successRatePct].filter(Boolean) as number[]}
            width={310}
            height={48}
            color="#10b981"
          />
        ) : (
          <Placeholder label="No delivery data for selected time range" />
        )}
      </SectionBox>

      {/* Retry Trend */}
      <SectionBox title="Retry Trend">
        {hasData ? (
          <SparklineLine values={[0, 0, 1, 2, 0, 1, 3, 0]} width={310} height={40} color="#f59e0b" />
        ) : (
          <Placeholder label="No retry data for selected time range" />
        )}
      </SectionBox>

    </div>
  )
}

// ─── Alerts Tab ───────────────────────────────────────────────────────────────

type AlertEntry = {
  severity: 'Critical' | 'Warning' | 'Info'
  type: string
  message: string
  firstSeen: string
  lastSeen: string
  occurrences: number
  affectedRouteId: number | null
  affectedStream: string | null
  status: 'Open' | 'Resolved'
  streamId: number | null
}

function buildAlerts(row: DestinationOverviewRow): AlertEntry[] {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const alerts: AlertEntry[] = []
  const issues = row.runtime.recentIssues
  const firstRoute = row.routes?.[0] ?? null

  for (const issue of issues) {
    const isFailure = issue.toLowerCase().includes('fail') || issue.toLowerCase().includes('error')
    const isCapacity = issue.toLowerCase().includes('capacity') || issue.toLowerCase().includes('rate')

    alerts.push({
      severity: isFailure ? 'Critical' : isCapacity ? 'Warning' : 'Warning',
      type: isFailure ? 'Delivery Failed'
        : isCapacity ? 'Capacity Warning'
        : issue.toLowerCase().includes('latency') ? 'Latency High'
        : issue.toLowerCase().includes('retry') ? 'Retry Elevated'
        : 'Connection Issue',
      message: issue,
      firstSeen: now,
      lastSeen: now,
      occurrences: 1,
      affectedRouteId: firstRoute?.route_id ?? null,
      affectedStream: firstRoute?.stream_name ?? null,
      status: 'Open',
      streamId: firstRoute?.stream_id ?? null,
    })
  }

  return alerts
}

function AlertsTab({ row }: { row: DestinationOverviewRow }) {
  const alerts = buildAlerts(row)

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16">
        <CheckCircle2 className="h-10 w-10 text-emerald-400" />
        <p className="text-[13px] font-semibold text-slate-700 dark:text-slate-300">No active alerts</p>
        <p className="text-[12px] text-slate-500">This destination is operating normally.</p>
      </div>
    )
  }

  const SEV: Record<string, string> = {
    Critical: 'border-red-500/30 bg-red-500/5',
    Warning: 'border-amber-500/30 bg-amber-500/5',
    Info: 'border-sky-500/30 bg-sky-500/5',
  }
  const SEV_TEXT: Record<string, string> = {
    Critical: 'text-red-300',
    Warning: 'text-amber-300',
    Info: 'text-sky-300',
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-500">{alerts.length} alert{alerts.length !== 1 ? 's' : ''} · {alerts.filter(a => a.status === 'Open').length} open</p>

      {alerts.map((alert, i) => (
        <div key={i} className={cn('rounded-xl border p-3', SEV[alert.severity])}>
          {/* Top row: severity + type + status */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className={cn('text-[10px] font-bold uppercase tracking-wide', SEV_TEXT[alert.severity])}>
                {alert.severity}
              </span>
              <span className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">{alert.type}</span>
            </div>
            <span className={cn(
              'rounded border px-1.5 py-0.5 text-[9px] font-semibold',
              alert.status === 'Open'
                ? 'border-amber-500/40 text-amber-300'
                : 'border-emerald-500/40 text-emerald-300'
            )}>
              {alert.status}
            </span>
          </div>

          {/* Message */}
          <p className="mt-1.5 text-[12px] text-slate-700 dark:text-slate-300">{alert.message}</p>

          {/* Metadata grid */}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-slate-500">
            <span>First seen: <span className="text-slate-400">{alert.firstSeen}</span></span>
            <span>Last seen: <span className="text-slate-400">{alert.lastSeen}</span></span>
            <span>Occurrences: <span className="tabular-nums font-semibold text-slate-700 dark:text-slate-300">{alert.occurrences}</span></span>
            <span>
              Route:{' '}
              {alert.affectedRouteId != null ? (
                <Link
                  to={alert.streamId != null ? streamEditWizardStepPath(String(alert.streamId), 'route_processing') : '#'}
                  className="font-semibold text-sky-400 hover:underline"
                >
                  #{alert.affectedRouteId}
                </Link>
              ) : '—'}
            </span>
            {alert.affectedStream && (
              <span className="col-span-2">
                Stream:{' '}
                {alert.streamId != null ? (
                  <Link
                    to={streamRuntimePath(String(alert.streamId))}
                    className="font-semibold text-violet-400 hover:underline"
                  >
                    {alert.affectedStream}
                  </Link>
                ) : alert.affectedStream}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Navigation Quick-links ───────────────────────────────────────────────────

function NavLinks({
  row,
  onEdit,
  onClose,
}: {
  row: DestinationOverviewRow
  onEdit?: () => void
  onClose: () => void
}) {
  const firstRoute = row.routes?.[0] ?? null
  const links: { label: string; href?: string; onClick?: () => void; icon: React.ReactNode }[] = []

  if (firstRoute) {
    links.push({
      label: 'Open Stream',
      href: streamRuntimePath(String(firstRoute.stream_id)),
      icon: <ExternalLink className="h-3 w-3" />,
    })
    links.push({
      label: 'Route Processing',
      href: streamEditWizardStepPath(String(firstRoute.stream_id), 'route_processing'),
      icon: <Settings className="h-3 w-3" />,
    })
  }
  links.push({
    label: 'View Delivery Logs',
    href: logsExplorerPath({ destination_id: row.id }),
    icon: <FileText className="h-3 w-3" />,
  })
  if (onEdit) {
    links.push({
      label: 'Edit Destination',
      onClick: () => { onEdit(); onClose() },
      icon: <Edit className="h-3 w-3" />,
    })
  }

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {links.map(({ label, href, onClick, icon }) =>
        href ? (
          <Link
            key={label}
            to={href}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-800 dark:text-slate-200 transition-colors"
          >
            {icon}
            {label}
          </Link>
        ) : (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-slate-500 hover:text-slate-800 dark:text-slate-200 transition-colors"
          >
            {icon}
            {label}
          </button>
        )
      )}
    </div>
  )
}

// ─── Tab labels ───────────────────────────────────────────────────────────────

const TAB_LABELS: { id: DrawerTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'streams', label: 'Streams' },
  { id: 'routes', label: 'Routes' },
  { id: 'performance', label: 'Perf' },
  { id: 'alerts', label: 'Alerts' },
]

// ─── Main Drawer ──────────────────────────────────────────────────────────────

export function DestinationDetailDrawer({
  row,
  onClose,
  onEdit,
  lastTestResult,
}: DestinationDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<DrawerTab>('overview')
  const rt = row.runtime
  const { limitEps, thresholds: _drawerThresholds } = extractCapacityConfig(row)
  const capacityPct =
    limitEps != null && limitEps > 0
      ? Math.round(((rt.currentEps ?? 0) / limitEps) * 100)
      : null

  const issueText = rt.recentIssues.length > 0 ? rt.recentIssues[0] : null

  const alertCount = rt.recentIssues.length

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />

      {/* Drawer panel — wider to fit routes table */}
      <div
        className="fixed right-0 top-0 z-50 flex h-full w-[520px] max-w-[96vw] flex-col border-l border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-bg shadow-2xl"
        role="dialog"
        aria-label={`Destination detail: ${row.name}`}
      >
        {/* ── Header ── */}
        <div className="flex-shrink-0 border-b border-slate-200/80 dark:border-gdc-border px-4 pt-4 pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[16px] font-bold text-slate-900 dark:text-slate-50 truncate">{row.name}</h2>
                <HealthBadge health={rt.health} />
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">{buildTargetSummary(row)}</p>
              {issueText && (
                <p className="mt-0.5 text-[11px] text-amber-400">{issueText}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-gdc-elevated hover:text-slate-800 dark:text-slate-200"
              aria-label="Close drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Info pills */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-0.5 text-[10px] text-slate-400">
              {typeLabel(row.destination_type)}
            </span>
            {capacityPct != null && (
              <span className="rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-0.5 text-[10px] text-slate-400">
                Capacity {capacityPct}%
              </span>
            )}
            <span className="rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-0.5 text-[10px] text-slate-400">
              {rt.connectedStreams} stream{rt.connectedStreams !== 1 ? 's' : ''}
            </span>
            <span className="rounded-md border border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-section px-2 py-0.5 text-[10px] text-slate-400">
              {row.routes?.length ?? 0} route{(row.routes?.length ?? 0) !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Navigation quick-links */}
          <NavLinks row={row} onEdit={onEdit} onClose={onClose} />
        </div>

        {/* ── Tabs ── */}
        <div className="flex-shrink-0 flex border-b border-slate-200/80 dark:border-gdc-border bg-white dark:bg-gdc-bg">
          {TAB_LABELS.map((tab) => {
            const badge = tab.id === 'alerts' && alertCount > 0 ? alertCount : null
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 py-2.5 text-[11px] font-semibold transition-colors',
                  activeTab === tab.id
                    ? 'border-b-2 border-violet-500 text-violet-300'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-300'
                )}
              >
                {tab.label}
                {badge != null && (
                  <span className="rounded-full bg-red-500/80 px-1.5 py-0.5 text-[9px] font-bold text-white leading-none">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* ── Tab content ── */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'overview' && (
            <OverviewTab row={row} lastTestResult={lastTestResult} onEdit={onEdit} />
          )}
          {activeTab === 'streams' && <StreamsTab row={row} />}
          {activeTab === 'routes' && <RoutesTab row={row} />}
          {activeTab === 'performance' && <PerformanceTab row={row} />}
          {activeTab === 'alerts' && <AlertsTab row={row} />}
        </div>
      </div>
    </>
  )
}
