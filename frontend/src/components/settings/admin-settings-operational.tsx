import {
  Activity,
  Bell,
  ChevronRight,
  ClipboardList,
  GitCompare,
  HeartPulse,
  History,
  Mail,
  MessageSquare,
  Send,
  Shield,
  Webhook,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getAdminAlertHistory,
  getAdminAlertSettings,
  getAdminAuditLog,
  getAdminConfigVersions,
  getAdminHealthSummary,
  postAdminAlertTest,
  putAdminAlertSettings,
  type AdminHealthSummaryDto,
  type AlertHistoryListDto,
  type AlertRuleDto,
  type AlertSettingsDto,
  type AuditLogListDto,
  type ConfigVersionListDto,
} from '../../api/gdcAdmin'
import { isPlatformAlertingUiEnabled } from '../../lib/feature-flags'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

function formatTs(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function healthBadgeClass(status: string) {
  if (status === 'good') return 'border-emerald-500/35 bg-emerald-500/15 text-emerald-200'
  if (status === 'medium') return 'border-amber-500/35 bg-amber-500/15 text-amber-200'
  if (status === 'bad') return 'border-red-500/35 bg-red-500/15 text-red-200'
  return 'border-gdc-border bg-gdc-panel text-gdc-muted'
}

function alertTypeLabel(t: string) {
  return t.replace(/_/g, ' ')
}

type Props = {
  reloadToken: number
  readOnly: boolean
  busy: boolean
  setBusy: (v: boolean) => void
  setPageMsg: (v: string | null) => void
  setPageErr: (v: string | null) => void
}

export function AdminOperationalDashboard({ reloadToken, readOnly, busy, setBusy, setPageMsg, setPageErr }: Props) {
  const [audit, setAudit] = useState<AuditLogListDto | null>(null)
  const [versions, setVersions] = useState<ConfigVersionListDto | null>(null)
  const [health, setHealth] = useState<AdminHealthSummaryDto | null>(null)
  const [alerts, setAlerts] = useState<AlertSettingsDto | null>(null)
  const [alertHistory, setAlertHistory] = useState<AlertHistoryListDto | null>(null)
  const [auditErr, setAuditErr] = useState<string | null>(null)

  const [auditExpanded, setAuditExpanded] = useState(false)
  const [auditFull, setAuditFull] = useState<AuditLogListDto | null>(null)
  const [alertsOpen, setAlertsOpen] = useState(false)

  const [alertDraft, setAlertDraft] = useState<AlertSettingsDto | null>(null)

  const load = useCallback(async () => {
    setAuditErr(null)

    const settled = await Promise.allSettled([
      getAdminAuditLog({ limit: 8, offset: 0 }),
      getAdminConfigVersions({ limit: 8, offset: 0 }),
      getAdminHealthSummary(),
      isPlatformAlertingUiEnabled() ? getAdminAlertSettings() : Promise.resolve(null),
      isPlatformAlertingUiEnabled()
        ? getAdminAlertHistory({ limit: 10, offset: 0 })
        : Promise.resolve({ total: 0, items: [] } as AlertHistoryListDto),
    ])

    const [a, v, h, al, ah] = settled
    if (a.status === 'fulfilled') setAudit(a.value)
    else setAuditErr(a.reason instanceof Error ? a.reason.message : String(a.reason))
    if (v.status === 'fulfilled') setVersions(v.value)
    if (h.status === 'fulfilled') setHealth(h.value)
    if (al.status === 'fulfilled' && al.value) setAlerts(al.value)
    if (ah.status === 'fulfilled') setAlertHistory(ah.value)
  }, [])

  const sendAlertTest = useCallback(
    async (alert_type: string) => {
      if (readOnly) return
      setBusy(true)
      setPageErr(null)
      setPageMsg(null)
      try {
        const r = await postAdminAlertTest({ alert_type, message: `Test alert (${alert_type})` })
        if (r.ok) {
          setPageMsg(`Webhook alert test delivered (status ${r.http_status ?? 'unknown'}).`)
        } else {
          setPageErr(`Alert test ${r.delivery_status}: ${r.error_message ?? 'no webhook configured?'}`)
        }
        const ah = await getAdminAlertHistory({ limit: 10, offset: 0 })
        setAlertHistory(ah)
      } catch (e) {
        setPageErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [readOnly, setBusy, setPageErr, setPageMsg],
  )

  useEffect(() => {
    void load()
  }, [load, reloadToken])

  const openAuditAll = async () => {
    if (auditExpanded) {
      setAuditExpanded(false)
      return
    }
    setAuditExpanded(true)
    setAuditFull(null)
    try {
      setAuditFull(await getAdminAuditLog({ limit: 100, offset: 0 }))
    } catch (e) {
      setAuditErr(e instanceof Error ? e.message : String(e))
      setAuditFull({ total: 0, items: [] })
    }
  }

  const saveAlerts = async () => {
    if (!alertDraft || readOnly) return
    setBusy(true)
    setPageErr(null)
    setPageMsg(null)
    try {
      const out = await putAdminAlertSettings({
        rules: alertDraft.rules,
        webhook_url: alertDraft.webhook_url,
        slack_webhook_url: alertDraft.slack_webhook_url,
        email_to: alertDraft.email_to,
        cooldown_seconds: alertDraft.cooldown_seconds,
        monitor_enabled: alertDraft.monitor_enabled,
      })
      setAlerts(out)
      setAlertsOpen(false)
      setPageMsg('Alert settings saved.')
      void load()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const card = gdcUi.cardShell

  function deliveryStatusBadge(status: string) {
    const ok = status === 'sent'
    const skipped = status === 'cooldown_skipped' || status === 'rule_disabled' || status === 'not_configured'
    const cls = ok
      ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200'
      : skipped
      ? 'border-slate-300 text-slate-500 dark:border-gdc-border dark:text-gdc-muted'
      : 'border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-200'
    return (
      <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', cls)}>
        {status.replace(/_/g, ' ')}
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 xl:grid-cols-2">
        {/* Audit */}
        <section className={cn(card, 'flex flex-col overflow-hidden')} aria-labelledby="admin-audit-heading">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
            <div className="flex gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-gdc-primary dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
                <ClipboardList className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h3 id="admin-audit-heading" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
                  Audit log
                </h3>
                <p className={cn('text-[12px]', gdcUi.textMuted)}>Append-only security and configuration events.</p>
              </div>
            </div>
            <button type="button" className="text-[12px] font-semibold text-gdc-primary hover:underline" onClick={() => void openAuditAll()}>
              {auditExpanded ? 'Collapse' : 'View all'}
            </button>
          </div>
          {auditErr ? (
            <p className="px-4 pb-2 text-[12px] text-amber-800 dark:text-amber-100 md:px-6" role="alert">
              Audit log could not be loaded: {auditErr}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-x-auto px-2 py-2 md:px-4">
            <table className="w-full min-w-[520px] border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">User</th>
                  <th className="px-2 py-2">Action</th>
                  <th className="px-2 py-2">Entity</th>
                  <th className="px-2 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {(audit?.items ?? []).map((ev) => (
                  <tr key={ev.id} className="border-b border-slate-50 dark:border-gdc-border/60">
                    <td className={cn('px-2 py-2 tabular-nums', gdcUi.textMuted)}>{formatTs(ev.created_at)}</td>
                    <td className={cn('px-2 py-2', gdcUi.textTitle)}>{ev.actor_username}</td>
                    <td className="px-2 py-2 font-mono text-[11px] text-violet-700 dark:text-violet-200">{ev.action}</td>
                    <td className={cn('px-2 py-2', gdcUi.textMuted)}>
                      {ev.entity_type ? `${ev.entity_type}${ev.entity_id != null ? ` #${ev.entity_id}` : ''}` : '—'}
                    </td>
                    <td className={cn('max-w-[200px] truncate px-2 py-2 font-mono text-[11px]', gdcUi.textMuted)}>
                      {JSON.stringify(ev.details ?? {})}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {auditExpanded ? (
            <div className="border-t border-slate-100 px-2 py-3 dark:border-gdc-border md:px-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                Full audit log ({auditFull?.total ?? audit?.total ?? 0} events)
              </p>
              <div className="max-h-[min(70vh,520px)] overflow-auto rounded-lg border border-slate-200/80 dark:border-gdc-border">
                <table className="w-full min-w-[900px] border-collapse text-left text-[12px]">
                  <thead className="sticky top-0 z-[1] bg-slate-50 dark:bg-gdc-tableHeader">
                    <tr className="border-b border-slate-200/80 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:border-gdc-divider dark:text-gdc-mutedStrong">
                      <th className="px-3 py-2.5">Time</th>
                      <th className="min-w-[100px] px-3 py-2.5">User</th>
                      <th className="min-w-[180px] px-3 py-2.5">Action</th>
                      <th className="min-w-[140px] px-3 py-2.5">Entity</th>
                      <th className="min-w-[280px] px-3 py-2.5">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(auditFull?.items ?? []).map((ev) => (
                      <tr key={ev.id} className="border-b border-slate-50 align-top dark:border-gdc-border/60">
                        <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-600 dark:text-gdc-muted">{formatTs(ev.created_at)}</td>
                        <td className="px-3 py-2.5 font-medium text-slate-900 dark:text-slate-50">{ev.actor_username}</td>
                        <td className="px-3 py-2.5 font-mono text-[11px] text-violet-700 dark:text-violet-200">{ev.action}</td>
                        <td className="px-3 py-2.5 text-slate-600 dark:text-gdc-muted">
                          {ev.entity_type ? `${ev.entity_type}${ev.entity_id != null ? ` #${ev.entity_id}` : ''}` : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <pre className="max-w-[420px] whitespace-pre-wrap break-all font-mono text-[11px] text-slate-600 dark:text-gdc-muted">
                            {JSON.stringify(ev.details ?? {}, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="mt-auto flex justify-end border-t border-slate-100 px-4 py-3 dark:border-gdc-border md:px-6">
              <button type="button" className={cn(gdcUi.secondaryBtn)} onClick={() => void openAuditAll()}>
                View audit logs
              </button>
            </div>
          )}
        </section>

        {/* Config versions */}
        <section className={cn(card, 'flex flex-col overflow-hidden')} aria-labelledby="admin-cfgver-heading">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
            <div className="flex gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-gdc-primary dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
                <History className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h3 id="admin-cfgver-heading" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
                  Config versioning
                </h3>
                <p className={cn('text-[12px]', gdcUi.textMuted)}>Lightweight history for stream, mapping, route, and destination saves.</p>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-x-auto px-2 py-2 md:px-4">
            <table className="w-full min-w-[560px] border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                  <th className="px-2 py-2">Version</th>
                  <th className="px-2 py-2">Entity</th>
                  <th className="px-2 py-2">Changed by</th>
                  <th className="px-2 py-2">Changed at</th>
                  <th className="px-2 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(versions?.items ?? []).map((v) => (
                  <tr key={v.id} className="border-b border-slate-50 dark:border-gdc-border/60">
                    <td className={cn('px-2 py-2 font-mono font-semibold', gdcUi.textTitle)}>v{v.version}</td>
                    <td className={cn('px-2 py-2', gdcUi.textMuted)}>
                      {v.entity_type}
                      {v.entity_name ? ` · ${v.entity_name}` : ` #${v.entity_id}`}
                    </td>
                    <td className={cn('px-2 py-2', gdcUi.textTitle)}>{v.changed_by}</td>
                    <td className={cn('px-2 py-2 tabular-nums', gdcUi.textMuted)}>{formatTs(v.changed_at)}</td>
                    <td className="px-2 py-2 text-right">
                      <button
                        type="button"
                        disabled
                        title="Rollback and deep compare are planned."
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-gdc-muted"
                      >
                        <GitCompare className="h-3.5 w-3.5" aria-hidden />
                        Compare
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-auto flex justify-end border-t border-slate-100 px-4 py-3 dark:border-gdc-border md:px-6">
            <span className="text-[11px] text-gdc-muted">Rollback: planned (not available in this release).</span>
          </div>
        </section>
      </div>

      {/* Health */}
      <section className={cn(card, 'p-4 md:p-6')} aria-labelledby="admin-health-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-gdc-primary dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <HeartPulse className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-health-heading" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
                Health monitoring
              </h3>
              <p className={cn('text-[12px]', gdcUi.textMuted)}>Derived from live database signals. Window: {(health?.metrics_window_seconds ?? 3600) / 3600}h.</p>
            </div>
          </div>
          <Link to="/runtime" className={cn('inline-flex items-center gap-1 text-[12px] font-semibold text-gdc-primary hover:underline')}>
            Runtime <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(health?.metrics ?? []).map((m) => (
            <div
              key={m.key}
              className="rounded-xl border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-panel/80"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{m.label}</p>
                <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase', healthBadgeClass(m.status))}>
                  {m.available ? (m.status === 'good' ? 'Good' : m.status === 'medium' ? 'Medium' : m.status === 'bad' ? 'Poor' : 'N/A') : 'N/A'}
                </span>
              </div>
              <p className={cn('mt-2 text-lg font-semibold tabular-nums', gdcUi.textTitle)}>
                {m.available && m.value != null ? m.value : 'Not available'}
              </p>
              {m.notes ? <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">{m.notes}</p> : null}
              {m.link_path ? (
                <Link to={m.link_path} className="mt-2 inline-block text-[11px] font-semibold text-gdc-primary hover:underline">
                  Open related view
                </Link>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Link
            to="/runtime/analytics"
            className="inline-flex items-center gap-2 rounded-lg border border-gdc-primary/40 bg-gdc-primary px-4 py-2 text-[13px] font-semibold text-white hover:opacity-95"
          >
            <Activity className="h-4 w-4" aria-hidden />
            View full metrics
          </Link>
        </div>
      </section>

      {isPlatformAlertingUiEnabled() ? (
      <>
      <section className={cn(card, 'overflow-hidden')} aria-labelledby="admin-alerts-heading">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-gdc-primary dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Bell className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-alerts-heading" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
                Alerting
              </h3>
              <p className={cn('text-[12px]', gdcUi.textMuted)}>
                Webhook delivery is{' '}
                <strong className="font-semibold text-emerald-700 dark:text-emerald-300">implemented</strong>{' '}
                with cooldown / dedupe / history. Slack and email channels remain planned placeholders.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={cn(
                'rounded border px-2 py-0.5 font-semibold',
                alerts?.monitor_enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
              )}
            >
              Monitor {alerts?.monitor_enabled ? 'on' : 'off'}
            </span>
            <span className="rounded border border-slate-200 px-2 py-0.5 font-semibold text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
              Cooldown {alerts?.cooldown_seconds ?? 600}s
            </span>
          </div>
        </div>
        <div className="overflow-x-auto px-2 py-2 md:px-4">
          <table className="w-full min-w-[720px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                <th className="px-2 py-2">Alert</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Severity</th>
                <th className="px-2 py-2">Last triggered</th>
                <th className="px-2 py-2">Channels</th>
                <th className="px-2 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {(alerts?.rules ?? []).map((rule) => (
                <tr key={rule.alert_type} className="border-b border-slate-50 dark:border-gdc-border/60">
                  <td className={cn('px-2 py-2 font-medium capitalize', gdcUi.textTitle)}>{alertTypeLabel(rule.alert_type)}</td>
                  <td className="px-2 py-2">
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-semibold',
                        rule.enabled
                          ? 'border border-emerald-500/35 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200'
                          : 'border border-slate-200 text-slate-500 dark:border-gdc-border dark:text-gdc-muted',
                      )}
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-semibold',
                        rule.severity === 'CRITICAL'
                          ? 'border border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-200'
                          : 'border border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-200',
                      )}
                    >
                      {rule.severity}
                    </span>
                  </td>
                  <td className={cn('px-2 py-2 tabular-nums', gdcUi.textMuted)}>{formatTs(rule.last_triggered_at)}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2 text-gdc-muted">
                      <span title={`Webhook: ${alerts?.channel_status?.webhook ?? '—'} (delivery: ${alerts?.notification_delivery?.webhook ?? '—'})`}>
                        <Webhook className="h-4 w-4" aria-hidden />
                      </span>
                      <span title={`Slack: ${alerts?.channel_status?.slack ?? '—'} (delivery: ${alerts?.notification_delivery?.slack ?? '—'})`}>
                        <MessageSquare className="h-4 w-4" aria-hidden />
                      </span>
                      <span title={`Email: ${alerts?.channel_status?.email ?? '—'} (delivery: ${alerts?.notification_delivery?.email ?? '—'})`}>
                        <Mail className="h-4 w-4" aria-hidden />
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      disabled={readOnly || busy || !alerts?.webhook_url}
                      onClick={() => void sendAlertTest(rule.alert_type)}
                      title={!alerts?.webhook_url ? 'Configure a webhook URL first' : 'Send a test alert'}
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold',
                        !alerts?.webhook_url || readOnly || busy
                          ? 'cursor-not-allowed border-slate-200 text-slate-400 dark:border-gdc-border dark:text-gdc-muted'
                          : 'border-gdc-primary/40 text-gdc-primary hover:bg-gdc-primary/10 dark:text-violet-200',
                      )}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden /> Test
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3 text-[11px] text-slate-600 dark:border-gdc-border dark:text-gdc-muted md:px-6">
          <p>
            <Shield className="mr-1 inline h-3.5 w-3.5 text-gdc-primary" aria-hidden />
            Channel status: webhook {alerts?.channel_status?.webhook ?? '—'} ({alerts?.notification_delivery?.webhook ?? '—'}), slack{' '}
            {alerts?.channel_status?.slack ?? '—'} ({alerts?.notification_delivery?.slack ?? '—'}), email {alerts?.channel_status?.email ?? '—'}{' '}
            ({alerts?.notification_delivery?.email ?? '—'}).
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={readOnly}
              onClick={() => {
                setAlertDraft(alerts)
                setAlertsOpen(true)
              }}
              className={cn(gdcUi.primaryBtn, readOnly && 'cursor-not-allowed opacity-50')}
            >
              Manage alerts
            </button>
          </div>
        </div>
      </section>

      <section className={cn(card, 'overflow-hidden')} aria-labelledby="admin-alert-history-heading">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-gdc-primary dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <History className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-alert-history-heading" className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>
                Recent alert deliveries
              </h3>
              <p className={cn('text-[12px]', gdcUi.textMuted)}>
                Most recent webhook attempts — including cooldown skips and failed deliveries.
              </p>
            </div>
          </div>
          <span className={cn('rounded border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-gdc-border dark:text-gdc-muted')}>
            Total: {alertHistory?.total ?? 0}
          </span>
        </div>
        <div className="overflow-x-auto px-2 py-2 md:px-4">
          <table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Alert</th>
                <th className="px-2 py-2">Severity</th>
                <th className="px-2 py-2">Stream</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">HTTP</th>
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {(alertHistory?.items ?? []).length === 0 ? (
                <tr>
                  <td colSpan={8} className={cn('px-3 py-6 text-center text-[12px]', gdcUi.textMuted)}>
                    No alert deliveries yet. Use the Test button on a rule, or wait for the monitor to detect issues.
                  </td>
                </tr>
              ) : (
                (alertHistory?.items ?? []).map((h) => (
                  <tr key={h.id} className="border-b border-slate-50 hover:bg-slate-50/40 dark:border-gdc-border/60 dark:hover:bg-gdc-panel/40">
                    <td className={cn('px-2 py-2 tabular-nums', gdcUi.textMuted)}>{formatTs(h.created_at)}</td>
                    <td className={cn('px-2 py-2 font-medium capitalize', gdcUi.textTitle)}>{alertTypeLabel(h.alert_type)}</td>
                    <td className="px-2 py-2">
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 text-[10px] font-bold uppercase',
                          h.severity === 'CRITICAL'
                            ? 'border border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-200'
                            : 'border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
                        )}
                      >
                        {h.severity}
                      </span>
                    </td>
                    <td className={cn('px-2 py-2', gdcUi.textMuted)}>
                      {h.stream_name ? `${h.stream_name}` : h.stream_id != null ? `#${h.stream_id}` : '—'}
                    </td>
                    <td className="px-2 py-2">{deliveryStatusBadge(h.delivery_status)}</td>
                    <td className={cn('px-2 py-2 tabular-nums', gdcUi.textMuted)}>{h.http_status ?? '—'}</td>
                    <td className={cn('px-2 py-2', gdcUi.textMuted)}>{h.trigger_source}</td>
                    <td className={cn('max-w-[260px] truncate px-2 py-2', gdcUi.textMuted)} title={h.message}>
                      {h.message}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      </>
      ) : null}

      {/* Modals */}

      {alertsOpen && alertDraft ? (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <div className={cn(gdcUi.modalPanel, 'max-w-lg')}>
            <h4 className={cn('text-[15px] font-semibold', gdcUi.textTitle)}>Alert settings</h4>
            <div className="mt-4 space-y-2">
              {alertDraft.rules.map((rule, idx) => (
                <div key={rule.alert_type} className={cn('flex flex-wrap items-center gap-2 rounded-lg border p-2', gdcUi.innerWell)}>
                  <span className="min-w-[140px] flex-1 text-[12px] font-medium capitalize">{alertTypeLabel(rule.alert_type)}</span>
                  <label className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => {
                        const next = [...alertDraft.rules]
                        next[idx] = { ...rule, enabled: e.target.checked }
                        setAlertDraft({ ...alertDraft, rules: next })
                      }}
                    />
                    On
                  </label>
                  <select
                    className={cn('min-w-[100px]', gdcUi.select)}
                    value={rule.severity}
                    onChange={(e) => {
                      const next = [...alertDraft.rules]
                      next[idx] = { ...rule, severity: e.target.value as AlertRuleDto['severity'] }
                      setAlertDraft({ ...alertDraft, rules: next })
                    }}
                  >
                    <option value="WARNING">Warning</option>
                    <option value="CRITICAL">Critical</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2">
              <label className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-gdc-muted">Webhook URL</label>
              <input
                className={cn('w-full', gdcUi.input)}
                value={alertDraft.webhook_url ?? ''}
                onChange={(e) => setAlertDraft({ ...alertDraft, webhook_url: e.target.value })}
                placeholder="https://…"
              />
              <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
                Webhook delivery is implemented. Slack and email entries are persisted but delivery for those channels is planned.
              </p>
              <label className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-gdc-muted">Slack incoming webhook (planned)</label>
              <input
                className={cn('w-full', gdcUi.input)}
                value={alertDraft.slack_webhook_url ?? ''}
                onChange={(e) => setAlertDraft({ ...alertDraft, slack_webhook_url: e.target.value })}
              />
              <label className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-gdc-muted">Email to (planned)</label>
              <input
                className={cn('w-full', gdcUi.input)}
                value={alertDraft.email_to ?? ''}
                onChange={(e) => setAlertDraft({ ...alertDraft, email_to: e.target.value })}
                placeholder="ops@example.com"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <div>
                  <label className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-gdc-muted">Cooldown seconds</label>
                  <input
                    type="number"
                    min={10}
                    max={86400}
                    className={cn('w-full', gdcUi.input)}
                    value={alertDraft.cooldown_seconds ?? 600}
                    onChange={(e) => setAlertDraft({ ...alertDraft, cooldown_seconds: Number(e.target.value) || 0 })}
                  />
                </div>
                <label className="mt-5 flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={alertDraft.monitor_enabled}
                    onChange={(e) => setAlertDraft({ ...alertDraft, monitor_enabled: e.target.checked })}
                  />
                  Monitor enabled (background detection)
                </label>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-100 dark:text-gdc-muted dark:hover:bg-gdc-card" onClick={() => setAlertsOpen(false)}>
                Cancel
              </button>
              <button type="button" disabled={busy || readOnly} className={gdcUi.primaryBtn} onClick={() => void saveAlerts()}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
