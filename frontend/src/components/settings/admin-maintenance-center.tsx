import {
  Activity,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  HardDrive,
  Layers,
  Server,
  Shield,
  Truck,
  Wrench,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAdminMaintenanceHealth, type MaintenanceHealthDto } from '../../api/gdcAdmin'
import type { MigrationIntegrityReportDto } from '../../api/types/gdcApi'
import { BACKUP_RESTORE_RUNBOOK_REPO_PATH, getBackupRestoreRunbookHref } from '../../lib/admin-runbook'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { MigrationIntegrityPanel } from '../runtime/migration-integrity-panel'

const SECTION_STEP = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'

function overallBadgeClass(overall: string) {
  if (overall === 'ERROR') return 'border-rose-500/45 bg-rose-500/12 text-rose-900 dark:text-rose-50'
  if (overall === 'WARN') return 'border-amber-500/45 bg-amber-500/12 text-amber-950 dark:text-amber-50'
  return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-50'
}

function panelBadgeClass(status: string) {
  if (status === 'ERROR') return 'border-rose-500/35 bg-rose-500/[0.09] text-rose-800 dark:text-rose-100'
  if (status === 'WARN') return 'border-amber-500/35 bg-amber-500/[0.09] text-amber-900 dark:text-amber-50'
  return 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-900 dark:text-emerald-50'
}

function fmtTs(iso: string | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

type CardDef = {
  key: keyof MaintenanceHealthDto['panels'] | string
  title: string
  icon: typeof Database
  description: string
}

const CARDS: CardDef[] = [
  { key: 'database', title: 'Database', icon: Database, description: 'PostgreSQL connectivity and probe latency.' },
  { key: 'migrations', title: 'Migrations', icon: Server, description: 'Alembic script head vs database stamp.' },
  { key: 'scheduler', title: 'Scheduler', icon: Activity, description: 'Stream scheduler supervisor and workers.' },
  { key: 'retention', title: 'Retention', icon: HardDrive, description: 'Cleanup scheduler and per-category status.' },
  { key: 'destinations', title: 'Destinations', icon: Truck, description: 'Per-destination delivery outcomes (1h).' },
  { key: 'certificates', title: 'Certificates', icon: Shield, description: 'HTTPS listener certificate expiry.' },
  { key: 'recent_failures', title: 'Recent failures', icon: AlertTriangle, description: 'Latest route delivery failures (masked).' },
  { key: 'delivery_logs_indexes', title: 'delivery_logs indexes', icon: Layers, description: 'PostgreSQL index validity / REINDEX maintenance signals.' },
]

type Props = {
  backendRole: import('../../auth/session').SessionRole | null
  busy: boolean
  setBusy: (v: boolean) => void
}

function panelStatus(data: MaintenanceHealthDto, key: string): string {
  const panel = data.panels[key as keyof MaintenanceHealthDto['panels']] as Record<string, unknown> | undefined
  return String(panel?.status ?? 'OK')
}

export function AdminMaintenanceCenter({ backendRole, busy, setBusy: _setBusy }: Props) {
  const [data, setData] = useState<MaintenanceHealthDto | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [panelDetailsOpen, setPanelDetailsOpen] = useState(false)
  const [runbookOpen, setRunbookOpen] = useState(false)
  const runbookHref = getBackupRestoreRunbookHref()

  const load = useCallback(async () => {
    if (backendRole !== 'ADMINISTRATOR') return
    setErr(null)
    try {
      setData(await getAdminMaintenanceHealth())
    } catch (e) {
      setData(null)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [backendRole])

  useEffect(() => {
    void load()
  }, [load])

  const panelCounts = useMemo(() => {
    if (!data) return { ok: 0, warn: 0, error: 0 }
    let ok = 0
    let warn = 0
    let error = 0
    for (const c of CARDS) {
      const st = panelStatus(data, c.key)
      if (st === 'ERROR') error += 1
      else if (st === 'WARN') warn += 1
      else ok += 1
    }
    if (data.panels.storage) {
      const st = String(data.panels.storage.status ?? 'OK')
      if (st === 'ERROR') error += 1
      else if (st === 'WARN') warn += 1
      else ok += 1
    }
    return { ok, warn, error }
  }, [data])

  const problemCards = useMemo(() => {
    if (!data) return []
    return CARDS.filter((c) => {
      const st = panelStatus(data, c.key)
      return st === 'ERROR' || st === 'WARN'
    })
  }, [data])

  function renderPanelBody(c: CardDef, panel: Record<string, unknown> | undefined) {
    if (!panel) return null
    return (
      <div className="mt-2 space-y-1 text-[11px] text-slate-600 dark:text-gdc-mutedStrong">
        {c.key === 'database' ? (
          <>
            <div>Reachable: {String(panel.reachable)}</div>
            {panel.latency_ms != null ? <div>Latency: {String(panel.latency_ms)} ms</div> : null}
          </>
        ) : null}
        {c.key === 'migrations' ? (
          <>
            <div>DB revision: {String(panel.database_revision ?? '—')}</div>
            <div>Script heads: {(panel.script_heads as string[])?.join(', ') || '—'}</div>
          </>
        ) : null}
        {c.key === 'migrations' &&
        panel.migration_integrity != null &&
        (panel.migration_integrity as MigrationIntegrityReportDto).status !== 'ok' ? (
          <div className="mt-2 border-t border-slate-100 pt-2 dark:border-gdc-divider">
            <MigrationIntegrityPanel
              report={panel.migration_integrity as MigrationIntegrityReportDto}
              compact
              className="text-[11px]"
            />
          </div>
        ) : null}
        {c.key === 'scheduler' ? (
          <>
            <div>
              Supervisor uptime (s):{' '}
              {panel.supervisor_uptime_seconds != null ? String(panel.supervisor_uptime_seconds) : '—'}
            </div>
            <div>Workers: {panel.active_worker_count != null ? String(panel.active_worker_count) : '—'}</div>
          </>
        ) : null}
        {c.key === 'retention' ? (
          <>
            <div>Thread running: {String(panel.cleanup_thread_running)}</div>
            <div>Policy enabled: {String(panel.cleanup_scheduler_enabled)}</div>
          </>
        ) : null}
        {c.key === 'destinations' ? (
          <div>Tracked destinations: {Array.isArray(panel.destinations) ? panel.destinations.length : 0}</div>
        ) : null}
        {c.key === 'certificates' ? (
          <>
            <div>HTTPS: {String(panel.https_enabled)}</div>
            {panel.days_remaining != null ? <div>Days left: {String(panel.days_remaining)}</div> : null}
          </>
        ) : null}
        {c.key === 'recent_failures' ? <div>Rows: {String(panel.count_returned ?? 0)}</div> : null}
        {c.key === 'delivery_logs_indexes' ? (
          <>
            <div>Catalog checked: {String(panel.checked)}</div>
            <div>REINDEX suggested: {String(panel.reindex_suggested)}</div>
            {Array.isArray(panel.invalid_indexes) && (panel.invalid_indexes as { name?: string }[]).length ? (
              <div className="mt-1 break-all font-mono text-[10px] text-rose-800 dark:text-rose-100/90">
                Invalid: {(panel.invalid_indexes as { name?: string }[]).map((x) => x.name).join(', ')}
              </div>
            ) : null}
            {panel.error ? <div className="mt-1 text-rose-800 dark:text-rose-100/90">Probe: {String(panel.error)}</div> : null}
          </>
        ) : null}
      </div>
    )
  }

  function renderPanelCard(c: CardDef) {
    if (!data) return null
    const panel = data.panels[c.key as keyof MaintenanceHealthDto['panels']] as Record<string, unknown> | undefined
    const st = String(panel?.status ?? 'OK')
    const Icon = c.icon
    return (
      <div
        key={c.key}
        data-testid={`maintenance-card-${c.key}`}
        className={cn(
          'rounded-xl border p-3 shadow-sm dark:shadow-gdc-control',
          st === 'ERROR'
            ? 'border-rose-300/90 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-950/20'
            : st === 'WARN'
              ? 'border-amber-300/90 bg-amber-50/35 dark:border-amber-500/25 dark:bg-amber-950/20'
              : 'border-slate-200/90 bg-white dark:border-gdc-border dark:bg-gdc-card',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200">
              <Icon className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">{c.title}</h4>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-gdc-muted">{c.description}</p>
            </div>
          </div>
          <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase', panelBadgeClass(st))}>
            {st}
          </span>
        </div>
        {renderPanelBody(c, panel)}
      </div>
    )
  }

  return (
    <section
      className={cn(gdcUi.cardShell, 'overflow-hidden')}
      aria-labelledby="admin-maintenance-heading"
      data-testid="admin-maintenance-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
        <div className="flex min-w-0 gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
            <Wrench className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 id="admin-maintenance-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Maintenance Center
            </h3>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
              Read-only readiness for production operations. Current posture first, then problem evidence, with panel detail
              on demand. Does not modify checkpoints, truncate data, or expose raw secrets. Administrator role required.
            </p>
          </div>
        </div>
        {backendRole === 'ADMINISTRATOR' ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void load()}
            data-testid="maintenance-refresh"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-card"
          >
            Refresh health
          </button>
        ) : null}
      </div>

      <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
        {backendRole !== 'ADMINISTRATOR' ? (
          <p className="text-sm text-slate-600 dark:text-gdc-muted" data-testid="maintenance-access-note">
            Sign in as <span className="font-medium text-slate-800 dark:text-slate-200">Administrator</span> to load
            maintenance diagnostics.
          </p>
        ) : null}

        {err && backendRole === 'ADMINISTRATOR' ? (
          <p
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-500/35 dark:bg-rose-950/40 dark:text-rose-100"
            role="alert"
            data-testid="maintenance-load-error"
          >
            {err}
          </p>
        ) : null}

        {data && backendRole === 'ADMINISTRATOR' ? (
          <>
            <div data-testid="maintenance-current-state" className="space-y-3">
              <p className={SECTION_STEP}>Current readiness</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-gdc-muted">
                <span className="font-medium text-slate-800 dark:text-slate-100">Overall</span>
                <span
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                    overallBadgeClass(data.overall),
                  )}
                  data-testid="maintenance-overall"
                >
                  {data.overall}
                </span>
                <span className="tabular-nums text-slate-500 dark:text-gdc-mutedStrong">
                  Generated {fmtTs(data.generated_at)}
                </span>
              </div>
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Healthy panels</dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                    {panelCounts.ok}
                  </dd>
                </div>
                <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Warnings</dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-amber-900 dark:text-amber-100">
                    {panelCounts.warn}
                  </dd>
                </div>
                <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Errors</dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-rose-900 dark:text-rose-100">
                    {panelCounts.error}
                  </dd>
                </div>
              </dl>
            </div>

            <div
              data-testid="maintenance-problem-evidence"
              className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border"
            >
              <p className={SECTION_STEP}>Problem evidence</p>
              {data.panels.delivery_logs_indexes &&
              (data.panels.delivery_logs_indexes as { reindex_suggested?: boolean }).reindex_suggested ? (
                <div
                  className="rounded-xl border border-rose-300/80 bg-rose-50/80 p-3 text-[12px] text-rose-950 dark:border-rose-500/40 dark:bg-rose-950/35 dark:text-rose-50"
                  data-testid="delivery-logs-reindex-warning"
                >
                  <p className="font-semibold">delivery_logs index maintenance (REINDEX)</p>
                  <p className="mt-1 text-[11px] leading-relaxed">
                    PostgreSQL reports an invalid or not-ready index on <span className="font-mono">delivery_logs</span>.
                    Plan a maintenance window for <span className="font-mono">REINDEX INDEX CONCURRENTLY</span> on the
                    listed index names. The public <span className="font-mono">/health</span> probe returns{' '}
                    <span className="font-mono">degraded</span> while this persists.
                  </p>
                </div>
              ) : null}

              {data.error.length > 0 || data.warn.length > 0 ? (
                <div
                  className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-3 dark:border-amber-500/25 dark:bg-amber-950/25"
                  data-testid="maintenance-warnings-block"
                >
                  <p className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-amber-950 dark:text-amber-50">
                    <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                    Active notices
                  </p>
                  <ul className="space-y-1.5 text-[12px] text-amber-950/90 dark:text-amber-50/90">
                    {data.error.map((n) => (
                      <li key={`e-${n.code}-${n.panel}`} className="flex gap-2">
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />
                        <span>
                          <span className="font-mono text-[11px]">{n.code}</span> — {n.message}
                        </span>
                      </li>
                    ))}
                    {data.warn.map((n) => (
                      <li key={`w-${n.code}-${n.panel}`} className="flex gap-2">
                        <AlertTriangle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300"
                          aria-hidden
                        />
                        <span>
                          <span className="font-mono text-[11px]">{n.code}</span> — {n.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p
                  className="rounded-lg border border-emerald-200/70 bg-emerald-50/50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-500/25 dark:bg-emerald-950/20 dark:text-emerald-50"
                  data-testid="maintenance-no-problems"
                >
                  No active warnings or errors.
                </p>
              )}

              {problemCards.length > 0 ? (
                <ul className="grid gap-2 sm:grid-cols-2" data-testid="maintenance-problem-panels" aria-label="Degraded panels">
                  {problemCards.map((c) => {
                    const st = panelStatus(data, c.key)
                    const Icon = c.icon
                    return (
                      <li
                        key={c.key}
                        data-testid={`maintenance-problem-${c.key}`}
                        className={cn(
                          'flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5',
                          st === 'ERROR'
                            ? 'border-rose-300/90 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-950/20'
                            : 'border-amber-300/90 bg-amber-50/35 dark:border-amber-500/25 dark:bg-amber-950/20',
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-slate-700 dark:text-slate-200" aria-hidden />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{c.title}</p>
                            <p className="text-xs text-slate-600 dark:text-gdc-muted">{c.description}</p>
                          </div>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase',
                            panelBadgeClass(st),
                          )}
                        >
                          {st}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>

            <div
              data-testid="maintenance-panel-details"
              className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className={SECTION_STEP}>Panel detail</p>
                  <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                    Full readiness panels and storage evidence. Expand when you need the complete checklist.
                  </p>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                  aria-expanded={panelDetailsOpen}
                  data-testid="maintenance-panel-details-toggle"
                  onClick={() => setPanelDetailsOpen((v) => !v)}
                >
                  {panelDetailsOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {panelDetailsOpen ? 'Hide panel details' : 'Show panel details'}
                </button>
              </div>

              {panelDetailsOpen ? (
                <div className="space-y-4" data-testid="maintenance-panel-details-body">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{CARDS.map((c) => renderPanelCard(c))}</div>

                  {data.panels.storage ? (
                    <div
                      data-testid="maintenance-card-storage"
                      className="rounded-xl border border-slate-200/90 bg-slate-50/40 p-3 dark:border-gdc-border dark:bg-gdc-section"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <HardDrive className="h-4 w-4 text-slate-600 dark:text-gdc-muted" aria-hidden />
                          <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Disk / storage</span>
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase',
                              panelBadgeClass(String(data.panels.storage.status)),
                            )}
                          >
                            {String(data.panels.storage.status)}
                          </span>
                        </div>
                      </div>
                      {data.panels.storage.disk && typeof data.panels.storage.disk === 'object' ? (
                        <dl className="mt-2 grid gap-1 text-[11px] text-slate-600 dark:text-gdc-mutedStrong sm:grid-cols-3">
                          <div>
                            <dt className="text-slate-500 dark:text-gdc-muted">Used %</dt>
                            <dd>{String((data.panels.storage.disk as { used_percent?: number }).used_percent ?? '—')}</dd>
                          </div>
                          <div>
                            <dt className="text-slate-500 dark:text-gdc-muted">Free (GB)</dt>
                            <dd>
                              {typeof (data.panels.storage.disk as { free_bytes?: number }).free_bytes === 'number'
                                ? ((data.panels.storage.disk as { free_bytes: number }).free_bytes / 1e9).toFixed(1)
                                : '—'}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-500 dark:text-gdc-muted">Path</dt>
                            <dd className="truncate font-mono text-[10px]">
                              {String((data.panels.storage.disk as { path?: string }).path ?? '')}
                            </dd>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                  ) : null}

                  {data.ok.length > 0 ? (
                    <details className="rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card">
                      <summary className="cursor-pointer font-medium text-slate-800 dark:text-slate-100">
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                          Positive signals ({data.ok.length})
                        </span>
                      </summary>
                      <ul className="mt-2 space-y-1 text-slate-600 dark:text-gdc-muted">
                        {data.ok.map((n) => (
                          <li key={`o-${n.code}-${n.panel}`}>
                            <span className="font-mono text-[11px]">{n.code}</span> — {n.message}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="border-t border-slate-100 pt-4 dark:border-gdc-border">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                aria-expanded={runbookOpen}
                data-testid="maintenance-runbook-toggle"
                onClick={() => setRunbookOpen((v) => !v)}
              >
                {runbookOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                )}
                {runbookOpen ? 'Hide runbook shortcut' : 'Show runbook shortcut'}
              </button>
              {runbookOpen ? (
                <div
                  data-testid="maintenance-runbook-shortcut"
                  className="mt-3 flex flex-wrap items-start gap-3 rounded-xl border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section"
                >
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200">
                    <BookOpen className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">
                      Backup & Restore Runbook
                    </h4>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                      PostgreSQL backup and restore procedures, Docker examples, and safety checks. Read-only backup;
                      restore requires explicit shell confirmation and never runs from this UI.
                    </p>
                    <div className="mt-2">
                      {runbookHref ? (
                        <a
                          href={runbookHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
                        >
                          Backup & Restore Runbook
                        </a>
                      ) : (
                        <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
                          Open in repository:{' '}
                          <code className="rounded border border-slate-200 bg-white px-1 py-0.5 font-mono text-[10px] dark:border-gdc-border dark:bg-gdc-card">
                            {BACKUP_RESTORE_RUNBOOK_REPO_PATH}
                          </code>{' '}
                          (from workspace root). To show a link here, set{' '}
                          <code className="font-mono text-[10px]">VITE_ADMIN_BACKUP_RESTORE_RUNBOOK_URL</code> at
                          frontend build time.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}
