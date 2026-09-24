import { ChevronDown, ChevronRight, HardDrive, PlayCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getAdminRetentionPolicy,
  postAdminRetentionCleanupRun,
  putAdminRetentionPolicy,
  type RetentionCleanupCategory,
  type RetentionCleanupRunResponseDto,
  type RetentionPolicyDto,
} from '../../api/gdcAdmin'
import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

type Props = {
  reloadToken: number
  readOnly: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setPageMsg: (v: string | null) => void
  setPageErr: (v: string | null) => void
}

function formatTs(iso: string | null | undefined) {
  if (!iso) return '—'
  return formatTimestampWithResolvedTimezone(iso)
}

function durationLabel(ms: number | null | undefined) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const sec = Math.round((ms / 1000) * 10) / 10
  return `${sec}s`
}

function cleanupStatusBadge(status: string | null | undefined) {
  if (!status) return null
  const cls =
    status === 'ok'
      ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200'
      : status === 'not_applicable'
        ? 'border-slate-300 bg-slate-100 text-slate-600 dark:border-gdc-border dark:bg-gdc-panel dark:text-gdc-muted'
        : status === 'skipped'
          ? 'border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-200'
          : 'border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-200'
  const text =
    status === 'not_applicable' ? 'N/A' : status === 'ok' ? 'OK' : status[0]!.toUpperCase() + status.slice(1)
  return (
    <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', cls)}>
      {text}
    </span>
  )
}

const SECTION_STEP = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'

export function AdminRetentionSettings({
  reloadToken,
  readOnly,
  busy,
  setBusy,
  setPageMsg,
  setPageErr,
}: Props) {
  const [retention, setRetention] = useState<RetentionPolicyDto | null>(null)
  const [retentionErr, setRetentionErr] = useState<string | null>(null)
  const [retentionOpen, setRetentionOpen] = useState(false)
  const [retDraft, setRetDraft] = useState<RetentionPolicyDto | null>(null)
  const [lastCleanupRun, setLastCleanupRun] = useState<RetentionCleanupRunResponseDto | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [categoryDetailsOpen, setCategoryDetailsOpen] = useState(false)

  const load = useCallback(async () => {
    setRetentionErr(null)
    try {
      setRetention(await getAdminRetentionPolicy())
    } catch (e) {
      setRetentionErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  const runCleanupNow = useCallback(
    async (categories?: RetentionCleanupCategory[], dryRun = false) => {
      if (readOnly) return
      setBusy(true)
      setPageErr(null)
      setPageMsg(null)
      try {
        const out = await postAdminRetentionCleanupRun({ categories, dry_run: dryRun })
        setLastCleanupRun(out)
        setRetention(out.policy)
        const summary = out.outcomes.map((o) => `${o.category}:${o.status}(${o.deleted_count})`).join(', ')
        setPageMsg(`Cleanup ${dryRun ? '(dry-run) ' : ''}completed: ${summary || 'no work'}.`)
        void load()
      } catch (e) {
        setPageErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [load, readOnly, setBusy, setPageErr, setPageMsg],
  )

  const saveRetention = async () => {
    if (!retDraft || readOnly) return
    setBusy(true)
    setPageErr(null)
    setPageMsg(null)
    try {
      const body: Record<string, unknown> = {
        logs_retention_days: retDraft.logs.retention_days,
        logs_enabled: retDraft.logs.enabled,
        runtime_metrics_retention_days: retDraft.runtime_metrics.retention_days,
        runtime_metrics_enabled: retDraft.runtime_metrics.enabled,
        preview_cache_retention_days: retDraft.preview_cache.retention_days,
        preview_cache_enabled: retDraft.preview_cache.enabled,
        backup_temp_retention_days: retDraft.backup_temp.retention_days,
        backup_temp_enabled: retDraft.backup_temp.enabled,
        cleanup_scheduler_enabled: retDraft.cleanup_scheduler_enabled,
        cleanup_interval_minutes: retDraft.cleanup_interval_minutes,
        cleanup_batch_size: retDraft.cleanup_batch_size,
      }
      const out = await putAdminRetentionPolicy(body)
      setRetention(out)
      setRetentionOpen(false)
      setPageMsg('Retention policy saved.')
      void load()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const retentionRows = retention
    ? [
        { key: 'logs', cat: 'logs' as RetentionCleanupCategory, label: 'Logs', b: retention.logs },
        {
          key: 'metrics',
          cat: 'runtime_metrics' as RetentionCleanupCategory,
          label: 'Runtime metrics',
          b: retention.runtime_metrics,
        },
        {
          key: 'preview',
          cat: 'preview_cache' as RetentionCleanupCategory,
          label: 'Preview cache',
          b: retention.preview_cache,
        },
        {
          key: 'backup',
          cat: 'backup_temp' as RetentionCleanupCategory,
          label: 'Backup temp',
          b: retention.backup_temp,
        },
      ]
    : []

  return (
    <section
      className={cn(gdcUi.cardShell, 'overflow-hidden')}
      aria-labelledby="admin-retention-heading"
      data-testid="admin-retention-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
        <div className="flex min-w-0 gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
            <HardDrive className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 id="admin-retention-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Retention / cleanup
            </h3>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
              Review scheduler posture and per-category retention, then dry-run or run cleanup. Policy edit stays separate
              from cleanup actions.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
        {retentionErr ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
          >
            Retention policy could not be loaded: {retentionErr}
          </div>
        ) : null}

        <div data-testid="admin-retention-current-state" className="space-y-3">
          <p className={SECTION_STEP}>Current scheduler posture</p>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Thread</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                {retention?.cleanup_scheduler_active ? 'Running' : 'Not running'}
              </dd>
            </div>
            <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Policy</dt>
              <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
                {retention?.cleanup_scheduler_enabled ? 'Enabled' : 'Disabled'}
              </dd>
            </div>
            <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Interval</dt>
              <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                {retention?.cleanup_interval_minutes ?? '—'}m
              </dd>
            </div>
            <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
              <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Last sweep</dt>
              <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                {formatTs(retention?.scheduler_last_tick_at)}
              </dd>
            </div>
          </dl>
          {retention?.cleanup_engine_message ? (
            <p className="text-sm text-slate-600 dark:text-gdc-muted">{retention.cleanup_engine_message}</p>
          ) : null}
        </div>

        <div
          data-testid="admin-retention-policy-summary"
          className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border"
        >
          <p className={SECTION_STEP}>Policy summary</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {retentionRows.map((row) => (
              <div key={row.key} className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{row.label}</p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                  {row.b.retention_days} days
                </p>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-gdc-muted">
                  {row.b.enabled ? 'Cleanup enabled' : 'Cleanup off'}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div
          data-testid="admin-retention-cleanup-status"
          className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className={SECTION_STEP}>Cleanup status</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                Last-run evidence per category. Open details for next schedule and duration.
              </p>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-200 dark:hover:bg-gdc-rowHover"
              aria-expanded={categoryDetailsOpen}
              onClick={() => setCategoryDetailsOpen((v) => !v)}
            >
              {categoryDetailsOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
              {categoryDetailsOpen ? 'Hide category details' : 'Show category details'}
            </button>
          </div>

          <ul className="grid gap-2 sm:grid-cols-2" aria-label="Per-category last cleanup">
            {retentionRows.map((row) => (
              <li
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200/80 px-3 py-2.5 dark:border-gdc-border"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{row.label}</p>
                  <p className="text-xs tabular-nums text-slate-600 dark:text-gdc-muted">
                    Last {formatTs(row.b.last_cleanup_at)}
                    {row.b.last_deleted_count != null ? ` · deleted ${row.b.last_deleted_count}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {cleanupStatusBadge(row.b.last_status) ?? (
                    <span className="text-xs text-slate-500 dark:text-gdc-muted">—</span>
                  )}
                  <button
                    type="button"
                    disabled={readOnly || busy}
                    aria-label={`Run cleanup now for ${row.label}`}
                    onClick={() => void runCleanupNow([row.cat], false)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold',
                      readOnly || busy
                        ? 'cursor-not-allowed border-slate-200 text-slate-400 dark:border-gdc-border dark:text-gdc-muted'
                        : 'border-gdc-primary/40 text-gdc-primary hover:bg-gdc-primary/10 dark:text-violet-200',
                    )}
                  >
                    <PlayCircle className="h-3.5 w-3.5" aria-hidden /> Run
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {categoryDetailsOpen ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-gdc-border">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <caption className="sr-only">Retention category cleanup schedule and last result details</caption>
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                    <th className="px-3 py-2">Data type</th>
                    <th className="px-3 py-2">Next cleanup</th>
                    <th className="px-3 py-2">Duration</th>
                    <th className="px-3 py-2">Deleted</th>
                  </tr>
                </thead>
                <tbody>
                  {retentionRows.map((row) => (
                    <tr key={row.key} className="border-b border-slate-50 dark:border-gdc-border/60">
                      <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-50">{row.label}</td>
                      <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-gdc-muted">
                        {formatTs(row.b.next_cleanup_at)}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-gdc-muted">
                        {durationLabel(row.b.last_duration_ms ?? null)}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-slate-900 dark:text-slate-50">
                        {row.b.last_deleted_count ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {lastCleanupRun ? (
            <p
              role="status"
              className="rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-2 text-xs text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted"
              data-testid="admin-retention-last-run"
            >
              Last operator run at {formatTs(lastCleanupRun.triggered_at)} (
              {lastCleanupRun.dry_run ? 'dry-run' : 'live'}):{' '}
              {lastCleanupRun.outcomes.map((o) => `${o.category}=${o.status}/${o.deleted_count}`).join(', ') ||
                'no work'}
            </p>
          ) : null}
        </div>

        <div
          data-testid="admin-retention-actions"
          className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border"
        >
          <p className={SECTION_STEP}>Operator actions</p>
          <p className="text-sm text-slate-600 dark:text-gdc-muted">
            Dry-run estimates deletes without removing rows. Run cleanup performs live deletes. Edit policy changes
            retention days and scheduler settings.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void runCleanupNow(undefined, true)}
              data-testid="admin-retention-dry-run"
              className={cn(gdcUi.secondaryBtn, readOnly && 'cursor-not-allowed opacity-50')}
            >
              Dry-run all
            </button>
            <button
              type="button"
              disabled={readOnly || busy}
              onClick={() => void runCleanupNow(undefined, false)}
              data-testid="admin-retention-run-cleanup"
              className={cn(
                'rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[13px] font-semibold text-amber-950 shadow-sm hover:bg-amber-500/15 disabled:opacity-50 dark:border-amber-500/35 dark:bg-amber-500/15 dark:text-amber-100',
                readOnly && 'cursor-not-allowed opacity-50',
              )}
            >
              Run cleanup now
            </button>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                setRetDraft(retention)
                setRetentionOpen(true)
              }}
              data-testid="admin-retention-edit-policy"
              className={cn(gdcUi.primaryBtn, readOnly && 'cursor-not-allowed opacity-50')}
            >
              Edit retention policy
            </button>
          </div>
        </div>

        <div className="border-t border-slate-100 pt-4 dark:border-gdc-border">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:text-slate-200 dark:hover:bg-gdc-rowHover"
            aria-expanded={advancedOpen}
            data-testid="admin-retention-advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
            {advancedOpen ? 'Hide advanced details' : 'Show advanced details'}
          </button>
          {advancedOpen ? (
            <div data-testid="admin-retention-advanced" className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Scheduler started</p>
                <p className="mt-1 text-sm tabular-nums text-slate-900 dark:text-slate-50">
                  {formatTs(retention?.scheduler_started_at)}
                </p>
              </div>
              <div className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Batch size</p>
                <p className="mt-1 text-sm tabular-nums text-slate-900 dark:text-slate-50">
                  {retention?.cleanup_batch_size ?? '—'}
                </p>
              </div>
              <div className={cn('rounded-xl px-3 py-3 sm:col-span-2 lg:col-span-1', gdcUi.innerWell)}>
                <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">Last summary</p>
                <p
                  className="mt-1 truncate text-sm text-slate-600 dark:text-gdc-muted"
                  title={retention?.scheduler_last_summary ?? ''}
                >
                  {retention?.scheduler_last_summary ?? '—'}
                </p>
              </div>
              {retention?.delivery_logs_scheduler_metrics ? (
                <div className={cn('rounded-xl px-3 py-3 sm:col-span-2 lg:col-span-3', gdcUi.innerWell)}>
                  <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">
                    delivery_logs cleanup metrics (this API process)
                  </p>
                  <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                    Cumulative rows deleted by scheduled logs sweeps:{' '}
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {retention.delivery_logs_scheduler_metrics.logs_cumulative_deleted_since_process_start ?? 0}
                    </span>{' '}
                    · logs sweeps executed:{' '}
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {retention.delivery_logs_scheduler_metrics.logs_category_sweeps ?? 0}
                    </span>
                    . Policy default for delivery logs is 30 days; batch deletes use the configured batch size.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {retentionOpen && retDraft ? (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-retention-policy-dialog-title"
          data-testid="admin-retention-policy-dialog"
        >
          <div className={cn(gdcUi.modalPanel, 'max-w-lg')}>
            <h4 id="admin-retention-policy-dialog-title" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
              Retention policy
            </h4>
            <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">{retDraft.cleanup_engine_message}</p>
            <div className="mt-4 space-y-3">
              <div className={cn('rounded-lg border p-3', gdcUi.innerWell)}>
                <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Cleanup scheduler</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className={cn('flex items-center gap-2', gdcUi.formLabel)}>
                    <input
                      type="checkbox"
                      checked={retDraft.cleanup_scheduler_enabled}
                      onChange={(e) =>
                        setRetDraft((d) => (d ? { ...d, cleanup_scheduler_enabled: e.target.checked } : d))
                      }
                    />
                    Enabled
                  </label>
                  <label className={cn('flex items-center gap-2', gdcUi.formLabel)}>
                    Interval (min)
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      className={cn('w-24', gdcUi.input)}
                      value={retDraft.cleanup_interval_minutes}
                      onChange={(e) =>
                        setRetDraft((d) =>
                          d ? { ...d, cleanup_interval_minutes: Number(e.target.value) || 60 } : d,
                        )
                      }
                    />
                  </label>
                  <label className={cn('flex items-center gap-2', gdcUi.formLabel)}>
                    Batch size
                    <input
                      type="number"
                      min={100}
                      max={100000}
                      className={cn('w-28', gdcUi.input)}
                      value={retDraft.cleanup_batch_size}
                      onChange={(e) =>
                        setRetDraft((d) =>
                          d ? { ...d, cleanup_batch_size: Number(e.target.value) || 5000 } : d,
                        )
                      }
                    />
                  </label>
                </div>
              </div>
              {(
                [
                  ['logs', 'Logs'] as const,
                  ['runtime_metrics', 'Runtime metrics'] as const,
                  ['preview_cache', 'Preview cache'] as const,
                  ['backup_temp', 'Backup temp'] as const,
                ] as const
              ).map(([key, label]) => (
                <div key={key} className={cn('rounded-lg border p-3', gdcUi.innerWell)}>
                  <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">{label}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className={cn('flex items-center gap-2', gdcUi.formLabel)}>
                      <input
                        type="checkbox"
                        checked={retDraft[key].enabled}
                        onChange={(e) =>
                          setRetDraft((d) =>
                            d ? { ...d, [key]: { ...d[key], enabled: e.target.checked } } : d,
                          )
                        }
                      />
                      Enabled
                    </label>
                    <label className={cn('flex items-center gap-2', gdcUi.formLabel)}>
                      Days
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        className={cn('w-24', gdcUi.input)}
                        value={retDraft[key].retention_days}
                        onChange={(e) =>
                          setRetDraft((d) =>
                            d
                              ? {
                                  ...d,
                                  [key]: { ...d[key], retention_days: Number(e.target.value) },
                                }
                              : d,
                          )
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-card"
                onClick={() => setRetentionOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || readOnly}
                className={gdcUi.primaryBtn}
                onClick={() => void saveRetention()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
