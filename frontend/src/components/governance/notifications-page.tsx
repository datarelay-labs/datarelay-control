import { Bell, Loader2, RefreshCw, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchGovernanceNotificationConfig,
  fetchGovernanceNotificationEvents,
  fetchGovernanceNotificationHealth,
  testGovernanceNotification,
  updateGovernanceNotificationConfig,
  type GovernanceNotificationConfig,
  type GovernanceNotificationEventEntry,
} from '../../api/gdcGovernanceNotifications'
import { NAV_PATH } from '../../config/nav-paths'
import { governanceReadOnlyReason } from '../../lib/governance-rbac'
import { cn } from '../../lib/utils'
import { isSessionExpired, readSession } from '../../auth/session'
import { getSessionCapabilities } from '../../lib/rbac'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import { GovernanceInvestigationDrawer } from './governance-investigation-drawer'
import { Link } from 'react-router-dom'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'
import { WizardRouteLeaveGuard, type WizardBlockedNavigation } from '../streams/wizard/wizard-route-leave-guard'

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function canManageNotificationRules(): boolean {
  const session = readSession()
  if (!session || isSessionExpired() || session.user.status !== 'ACTIVE' || session.user.must_change_password) return false
  return session.user.role === 'ADMINISTRATOR' && getSessionCapabilities().admin_alert_settings_write === true
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
  testId: string
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-4 rounded-lg border border-slate-100 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-rowHover/20',
        disabled && 'opacity-60',
      )}
      data-testid={testId}
    >
      <span>
        <span className="block text-[13px] font-medium text-slate-800 dark:text-slate-200">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[12px] text-slate-500 dark:text-gdc-muted">{description}</span>
        ) : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300"
      />
    </label>
  )
}

// Compare only persisted inputs. Queue telemetry and updated_at are not edits.
function notificationRulesChanged(
  persisted: GovernanceNotificationConfig | null,
  draft: GovernanceNotificationConfig | null,
): boolean {
  if (persisted == null || draft == null) return false
  return persisted.approval_events !== draft.approval_events ||
    persisted.violation_events !== draft.violation_events ||
    persisted.quarantine_events !== draft.quarantine_events ||
    persisted.replay_events !== draft.replay_events ||
    persisted.email_enabled !== draft.email_enabled ||
    persisted.email_recipients.length !== draft.email_recipients.length ||
    persisted.email_recipients.some((entry, index) => entry !== draft.email_recipients[index]) ||
    persisted.webhook_enabled !== draft.webhook_enabled ||
    persisted.webhook_url !== draft.webhook_url
}

function notificationWhy(entry: GovernanceNotificationEventEntry): string {
  if (entry.status === 'FAILED') return 'Delivery to the configured channel failed — check email or webhook settings.'
  if (entry.status === 'PENDING') return 'Notification is queued and waiting for delivery.'
  return 'Control recorded transport acceptance for the configured channel(s). This does not confirm inbox delivery or downstream receipt.'
}

function notificationActionHref(eventType: string): string {
  const t = eventType.toLowerCase()
  if (t.includes('violation')) return NAV_PATH.governanceViolations
  if (t.includes('quarantine')) return NAV_PATH.governanceQuarantine
  if (t.includes('replay')) return NAV_PATH.governanceReplay
  if (t.includes('approval')) return NAV_PATH.governanceApprovals
  return NAV_PATH.governanceOperations
}

function DeliveryTable({
  title,
  rows,
  emptyLabel,
  testId,
  onRowClick,
}: {
  title: string
  rows: GovernanceNotificationEventEntry[]
  emptyLabel: string
  testId: string
  onRowClick?: (row: GovernanceNotificationEventEntry) => void
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-gdc-border dark:bg-gdc-panel" data-testid={testId}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 text-[12px] text-slate-500 dark:text-gdc-muted">{emptyLabel}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className={opTable}>
            <thead>
              <tr className={opThRow}>
                <th className={opTh}>Time</th>
                <th className={opTh}>Event</th>
                <th className={opTh}>Severity</th>
                <th className={opTh}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(opTr, onRowClick && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-gdc-rowHover')}
                  data-testid={`notification-event-${row.id}`}
                  onClick={() => onRowClick?.(row)}
                >
                  <td className={opTd}>{formatTime(row.created_at)}</td>
                  <td className={opTd}>{row.event_type.replace(/_/g, ' ')}</td>
                  <td className={opTd}>{row.severity}</td>
                  <td className={opTd}>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function NotificationsPage() {
  const readOnlyReason = governanceReadOnlyReason()
  const canEdit = canManageNotificationRules()
  const [config, setConfig] = useState<GovernanceNotificationConfig | null>(null)
  const [draft, setDraft] = useState<GovernanceNotificationConfig | null>(null)
  const [pending, setPending] = useState<GovernanceNotificationEventEntry[]>([])
  const [failed, setFailed] = useState<GovernanceNotificationEventEntry[]>([])
  const [recentSent, setRecentSent] = useState<GovernanceNotificationEventEntry[]>([])
  const [queueHealth, setQueueHealth] = useState<Awaited<ReturnType<typeof fetchGovernanceNotificationHealth>> | null>(null)
  const queueHealthRequestId = useRef(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<'email' | 'webhook' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<GovernanceNotificationEventEntry | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [refreshAfterDiscard, setRefreshAfterDiscard] = useState(false)
  const [navigationDuringSave, setNavigationDuringSave] = useState(false)
  const pendingNavigationRef = useRef<WizardBlockedNavigation | null>(null)
  const allowedNextPathRef = useRef<string | null>(null)
  const hasUnsavedChanges = canEdit && notificationRulesChanged(config, draft)

  const onBlockedNavigation = useCallback((pending: WizardBlockedNavigation) => {
    if (saving) {
      pending.reset()
      setNavigationDuringSave(true)
      return
    }
    pendingNavigationRef.current = pending
    setRefreshAfterDiscard(false)
    setDiscardOpen(true)
  }, [saving])

  const dismissDiscard = useCallback(() => {
    const pending = pendingNavigationRef.current
    pendingNavigationRef.current = null
    pending?.reset()
    setDiscardOpen(false)
    setRefreshAfterDiscard(false)
  }, [])

  useEffect(() => {
    if (!canEdit || (!hasUnsavedChanges && !saving)) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [canEdit, hasUnsavedChanges, saving])

  const recipientsText = useMemo(() => (draft?.email_recipients ?? []).join(', '), [draft?.email_recipients])

  const load = useCallback(async () => {
    const queueRequest = ++queueHealthRequestId.current
    setQueueHealth(null)
    // Optional queue telemetry must not block the existing settings or event lists.
    void fetchGovernanceNotificationHealth()
      .then((health) => {
        if (queueHealthRequestId.current === queueRequest) setQueueHealth(health)
      })
      .catch(() => {
        if (queueHealthRequestId.current === queueRequest) setQueueHealth(null)
      })
    setLoading(true)
    setError(null)
    try {
      const [cfg, pendingResp, failedResp, sentResp] = await Promise.all([
        fetchGovernanceNotificationConfig(),
        fetchGovernanceNotificationEvents('PENDING', 20),
        fetchGovernanceNotificationEvents('FAILED', 20),
        fetchGovernanceNotificationEvents('SENT', 20),
      ])
      setConfig(cfg)
      setDraft(cfg)
      setPending(pendingResp.events)
      setFailed(failedResp.events)
      setRecentSent(sentResp.events)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notification settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const requestRefresh = () => {
    if (saving) {
      setNavigationDuringSave(true)
      return
    }
    if (hasUnsavedChanges) {
      setRefreshAfterDiscard(true)
      setDiscardOpen(true)
      return
    }
    void load()
  }

  const save = async () => {
    if (!draft || !canEdit) return
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      const updated = await updateGovernanceNotificationConfig({
        approval_events: draft.approval_events,
        violation_events: draft.violation_events,
        quarantine_events: draft.quarantine_events,
        replay_events: draft.replay_events,
        email_enabled: draft.email_enabled,
        email_recipients: draft.email_recipients,
        webhook_enabled: draft.webhook_enabled,
        webhook_url: draft.webhook_url,
      })
      setConfig(updated)
      setDraft(updated)
      setMessage('Notification rules saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save notification rules')
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (channel: 'email' | 'webhook') => {
    if (!canEdit) return
    setTesting(channel)
    setMessage(null)
    setError(null)
    try {
      const result = await testGovernanceNotification(channel)
      setMessage(result.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test notification failed')
    } finally {
      setTesting(null)
    }
  }

  if (loading && !config) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-gdc-muted" data-testid="notifications-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading notifications…
      </div>
    )
  }

  return (
    <div className="space-y-6" data-testid="governance-notifications-page">
      <WizardRouteLeaveGuard
        active={canEdit && (hasUnsavedChanges || saving)}
        allowedNextPathRef={allowedNextPathRef}
        onBlocked={onBlockedNavigation}
      />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <Bell className="h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
            Notifications
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] text-slate-600 dark:text-gdc-mutedStrong">
            Configure who is notified when governance events occur. Review delivery status to see what happened and what needs attention.
          </p>
        </div>
        <button
          type="button"
          onClick={requestRefresh}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
          data-testid="notifications-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </header>

      {hasUnsavedChanges ? (
        <p role="status" data-testid="notification-unsaved-warning" className="rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          Unsaved notification rules are local only. Save or explicitly discard changes before leaving or refreshing.
        </p>
      ) : null}
      {navigationDuringSave && saving ? (
        <p role="status" data-testid="notification-saving-navigation-warning" className="text-[12px] text-amber-800 dark:text-amber-200">
          Finish saving notification rules before leaving or refreshing this page.
        </p>
      ) : null}
      {readOnlyReason ? (
        <p className="rounded-lg border border-amber-200/80 bg-amber-50/60 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          {readOnlyReason}
        </p>
      ) : null}
      {!canEdit ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:border-gdc-border dark:bg-gdc-rowHover/20 dark:text-gdc-mutedStrong">
          Notification rules can only be changed by an Administrator.
        </p>
      ) : null}
      {message ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
          {error}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-gdc-border dark:bg-gdc-panel" data-testid="notification-channels">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Notification Channels</h3>
          {draft ? (
            <div className="space-y-3">
              <ToggleRow
                label="Email Enabled"
                description="Send governance alerts to configured recipients."
                checked={draft.email_enabled}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, email_enabled: v })}
                testId="notification-email-enabled"
              />
              <label className="block text-[12px] text-slate-600 dark:text-gdc-mutedStrong">
                Email recipients (comma-separated)
                <input
                  type="text"
                  value={recipientsText}
                  disabled={!canEdit || saving}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      email_recipients: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] dark:border-gdc-border dark:bg-gdc-bg"
                  data-testid="notification-email-recipients"
                />
              </label>
              <ToggleRow
                label="Webhook Enabled"
                description="POST JSON payloads to your webhook URL."
                checked={draft.webhook_enabled}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, webhook_enabled: v })}
                testId="notification-webhook-enabled"
              />
              <label className="block text-[12px] text-slate-600 dark:text-gdc-mutedStrong">
                Webhook URL
                <input
                  type="url"
                  value={draft.webhook_url ?? ''}
                  disabled={!canEdit || saving}
                  onChange={(e) => setDraft({ ...draft, webhook_url: e.target.value || null })}
                  className="mt-1 w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-[13px] dark:border-gdc-border dark:bg-gdc-bg"
                  data-testid="notification-webhook-url"
                />
              </label>
              {canEdit ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-60"
                    data-testid="notification-save"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    Save Notification Rules
                  </button>
                  <button
                    type="button"
                    disabled={testing !== null || saving}
                    onClick={() => void runTest('email')}
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong"
                    data-testid="notification-test-email"
                  >
                    Test Email
                  </button>
                  <button
                    type="button"
                    disabled={testing !== null || saving}
                    onClick={() => void runTest('webhook')}
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-gdc-mutedStrong"
                    data-testid="notification-test-webhook"
                  >
                    Test Webhook
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-gdc-border dark:bg-gdc-panel" data-testid="notification-subscriptions">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Event Subscription</h3>
          {draft ? (
            <div className="space-y-2">
              <ToggleRow
                label="Approval Events"
                checked={draft.approval_events}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, approval_events: v })}
                testId="notification-sub-approval"
              />
              <ToggleRow
                label="Violation Events"
                checked={draft.violation_events}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, violation_events: v })}
                testId="notification-sub-violation"
              />
              <ToggleRow
                label="Quarantine Events"
                checked={draft.quarantine_events}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, quarantine_events: v })}
                testId="notification-sub-quarantine"
              />
              <ToggleRow
                label="Replay Events"
                checked={draft.replay_events}
                disabled={!canEdit || saving}
                onChange={(v) => setDraft({ ...draft, replay_events: v })}
                testId="notification-sub-replay"
              />
            </div>
          ) : null}
        </section>
      </div>

      <div className="space-y-4" data-testid="notification-delivery-status">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Delivery Status</h3>
        {queueHealth?.durable_outbox_enabled ? (
          <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-gdc-border dark:bg-gdc-panel" data-testid="notification-outbox-health">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Durable Delivery Queue</h4>
            <div className="mt-3 grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
              {([
                ['Pending', queueHealth.pending_delivery_jobs, 'notification-outbox-pending'],
                ['In progress', queueHealth.leased_delivery_jobs, 'notification-outbox-leased'],
                ['Scheduled retry', queueHealth.retry_scheduled_delivery_jobs, 'notification-outbox-retry'],
                ['Dead letter', queueHealth.dead_letter_delivery_jobs, 'notification-outbox-dead'],
              ] as const).map(([label, count, id]) => (
                <div key={id} data-testid={id} className="rounded-lg bg-slate-50 p-3 dark:bg-gdc-rowHover/20">
                  <div className="text-slate-500 dark:text-gdc-muted">{label}</div>
                  <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{Number.isSafeInteger(count) && (count ?? -1) >= 0 ? count?.toLocaleString() : 'Not verified'}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-slate-500 dark:text-gdc-muted">
              Queue acknowledgement does not confirm downstream receipt. Retry and worker activity require separate runtime verification.
            </p>
          </section>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-3">
          <DeliveryTable
            title="Pending"
            rows={pending}
            emptyLabel="No pending notifications."
            testId="notification-pending"
            onRowClick={setSelectedEvent}
          />
          <DeliveryTable
            title="Failed"
            rows={failed}
            emptyLabel="No failed deliveries."
            testId="notification-failed"
            onRowClick={setSelectedEvent}
          />
          <DeliveryTable
            title="Recent Sent"
            rows={recentSent}
            emptyLabel="No recent deliveries."
            testId="notification-sent"
            onRowClick={setSelectedEvent}
          />
        </div>
      </div>

      <GovernanceInvestigationDrawer
        title="Notification event"
        testId="notification-event-drawer"
        closeTestId="notification-event-close"
        loading={false}
        hasContent={selectedEvent != null}
        onClose={() => setSelectedEvent(null)}
        whatHappenedTestId="notification-section-what-happened"
        whyTestId="notification-section-why"
        whatShouldIDoTestId="notification-section-what-should-i-do"
        whatHappened={
          selectedEvent ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
              <div>
                <dt className="text-slate-500">Event</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100">
                  {selectedEvent.event_type.replace(/_/g, ' ')}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Severity</dt>
                <dd>{selectedEvent.severity}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Status</dt>
                <dd>{selectedEvent.status}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Time</dt>
                <dd>{formatTime(selectedEvent.created_at)}</dd>
              </div>
            </dl>
          ) : null
        }
        why={selectedEvent ? <p className="text-[12px] text-slate-700 dark:text-gdc-mutedStrong">{notificationWhy(selectedEvent)}</p> : null}
        whatShouldIDo={
          selectedEvent ? (
            <div className="flex flex-wrap gap-2">
              <Link
                to={notificationActionHref(selectedEvent.event_type)}
                className="rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200"
              >
                Open governance workspace
              </Link>
              {selectedEvent.status === 'FAILED' && canEdit ? (
                <button
                  type="button"
                  onClick={() => void runTest('email')}
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-200"
                >
                  Test email channel
                </button>
              ) : null}
            </div>
          ) : null
        }
      />
      {discardOpen ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => { if (!open) dismissDiscard() }}
          title={refreshAfterDiscard ? 'Refresh and discard unsaved notification rules?' : 'Discard unsaved notification rules?'}
          targetName="Notification rules"
          risk="medium"
          impactBullets={[
            'Unsaved changes to notification channels, recipients and event subscriptions will be lost.',
            'Previously saved notification rules remain active until a successful Save.',
          ]}
          reversibility="Unsaved changes cannot be recovered after discard."
          primaryLabel={refreshAfterDiscard ? 'Refresh latest' : 'Discard changes'}
          onConfirm={() => {
            const pending = pendingNavigationRef.current
            pendingNavigationRef.current = null
            setDiscardOpen(false)
            if (pending) pending.proceed()
            else if (refreshAfterDiscard) void load()
            setRefreshAfterDiscard(false)
          }}
          dataTestId="notification-discard-dialog"
        />
      ) : null}
    </div>
  )
}
