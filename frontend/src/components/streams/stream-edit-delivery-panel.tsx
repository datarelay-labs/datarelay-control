import { Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchDestinationsList, type DestinationRead } from '../../api/gdcDestinations'
import {
  fetchStreamMappingUiConfig,
  saveRuntimeRouteEnabledState,
  saveRuntimeRouteFailurePolicy,
} from '../../api/gdcRuntime'
import type { MappingUIConfigResponse } from '../../api/types/gdcApi'
import { createRoute, deleteRoute, updateRoute } from '../../api/gdcRoutes'
import { cn } from '../../lib/utils'
import { DEFAULT_MESSAGE_PREFIX_TEMPLATE, defaultMessagePrefixEnabled } from '../../utils/messagePrefixDefaults'
import { DELIVERY_PREVIEW_SAMPLE_EVENT } from '../../utils/deliveryPreviewSample'
import { MessagePrefixDeliveryPreview } from './message-prefix-delivery-preview'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

const FAILURE_POLICIES = ['LOG_AND_CONTINUE', 'RETRY_AND_BACKOFF', 'PAUSE_STREAM_ON_FAILURE', 'DISABLE_ROUTE_ON_FAILURE'] as const

/** `fetch` reports CORS, DNS, TLS, mixed content, and dropped connections as this generic message. */
function formatDeliveryPanelApiError(e: unknown, context: string): string {
  if (e instanceof Error && e.message === 'Failed to fetch') {
    return `${context}: Could not reach the API (network, TLS, mixed content, or proxy blocking). Confirm API base URL (build env or localStorage gdc.apiBaseUrlOverride), that DELETE is allowed for /api/v1/routes/, and the backend is reachable.`
  }
  if (e instanceof Error) return `${context}: ${e.message}`
  return `${context} failed.`
}

function isRouteNotFoundDeleteError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  return msg.includes('404') || msg.includes('not found') || msg.includes('route_not_found')
}

function normalizeWebhookPayloadMode(raw: unknown): 'SINGLE_EVENT_OBJECT' | 'BATCH_JSON_ARRAY' {
  if (raw === 'BATCH_JSON_ARRAY') return 'BATCH_JSON_ARRAY'
  return 'SINGLE_EVENT_OBJECT'
}

function RoutePrefixPreviewBlock({
  streamId,
  streamName,
  routeId,
  draft,
  destination,
  destinationType,
}: {
  streamId: number
  streamName: string
  routeId: number
  draft: { enabled: boolean; template: string }
  destination: DestinationRead | undefined
  destinationType: string
}) {
  const req = useMemo(
    () => ({
      formatter_config: {
        message_prefix_enabled: draft.enabled,
        message_prefix_template: draft.template.trim().length > 0 ? draft.template.trim() : DEFAULT_MESSAGE_PREFIX_TEMPLATE,
      },
      sample_event: DELIVERY_PREVIEW_SAMPLE_EVENT,
      destination_type: destinationType,
      stream: { id: streamId, name: streamName },
      destination: {
        id: destination?.id ?? 0,
        name: destination?.name ?? '',
        type: destination?.destination_type ?? destinationType,
        payload_mode:
          destinationType === 'WEBHOOK_POST'
            ? normalizeWebhookPayloadMode(destination?.config_json?.payload_mode)
            : undefined,
      },
      route: { id: routeId },
    }),
    [streamId, streamName, routeId, draft.enabled, draft.template, destination, destinationType],
  )
  return <MessagePrefixDeliveryPreview request={req} />
}

type Props = {
  streamId: number
  onSaved?: () => void
}

export function StreamEditDeliveryPanel({ streamId, onSaved }: Props) {
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [destinations, setDestinations] = useState<DestinationRead[]>([])
  const [mappingCfg, setMappingCfg] = useState<MappingUIConfigResponse | null>(null)
  const [routeBusyId, setRouteBusyId] = useState<number | null>(null)
  const [newRouteDestinationId, setNewRouteDestinationId] = useState('')
  const [newRouteFailurePolicy, setNewRouteFailurePolicy] = useState<(typeof FAILURE_POLICIES)[number]>('LOG_AND_CONTINUE')
  const [prefixDraft, setPrefixDraft] = useState<
    Record<number, { enabled: boolean; template: string }>
  >({})
  const [deleteRouteDialog, setDeleteRouteDialog] = useState<{ routeId: number; destinationName: string } | null>(
    null,
  )

  const load = useCallback(async () => {
    setLoadError(null)
    setBusy(true)
    try {
      const [cfg, dests] = await Promise.all([
        fetchStreamMappingUiConfig(streamId, { fresh: true }),
        fetchDestinationsList(),
      ])
      if (!cfg) {
        setLoadError('Could not load stream delivery configuration.')
        setMappingCfg(null)
        return
      }
      setMappingCfg(cfg)
      setDestinations(dests)
      setNewRouteDestinationId((prev) => prev || (dests[0]?.id != null ? String(dests[0].id) : ''))
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Load delivery configuration'))
      setMappingCfg(null)
    } finally {
      setBusy(false)
    }
  }, [streamId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const rows = mappingCfg?.routes
    if (!rows) return
    const next: Record<number, { enabled: boolean; template: string }> = {}
    for (const r of rows) {
      const fc = r.formatter_config ?? {}
      const kind = r.destination_type ?? ''
      const defEn = defaultMessagePrefixEnabled(kind)
      next[r.route_id] = {
        enabled: typeof fc.message_prefix_enabled === 'boolean' ? fc.message_prefix_enabled : defEn,
        template:
          typeof fc.message_prefix_template === 'string' && fc.message_prefix_template.trim()
            ? String(fc.message_prefix_template)
            : DEFAULT_MESSAGE_PREFIX_TEMPLATE,
      }
    }
    setPrefixDraft(next)
  }, [mappingCfg])

  const routes = mappingCfg?.routes ?? []
  const destinationById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

  const applyRouteRemoved = useCallback((routeId: number) => {
    setMappingCfg((prev) =>
      prev ? { ...prev, routes: (prev.routes ?? []).filter((r) => r.route_id !== routeId) } : prev,
    )
    setPrefixDraft((prev) => {
      if (!(routeId in prev)) return prev
      const next = { ...prev }
      delete next[routeId]
      return next
    })
  }, [])

  async function onAddRoute() {
    const destinationId = Number(newRouteDestinationId)
    if (!Number.isFinite(destinationId)) return
    setRouteBusyId(-1)
    setNotice(null)
    try {
      const destRow = destinations.find((d) => d.id === destinationId)
      await createRoute({
        name: `${mappingCfg?.stream_name ?? `Stream ${streamId}`} delivery`,
        stream_id: streamId,
        destination_id: destinationId,
        enabled: true,
        status: 'ENABLED',
        failure_policy: newRouteFailurePolicy,
        formatter_config_json: {
          message_prefix_enabled: defaultMessagePrefixEnabled(destRow?.destination_type ?? ''),
          message_prefix_template: DEFAULT_MESSAGE_PREFIX_TEMPLATE,
        },
      })
      setNotice('Route added to this stream.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Add route'))
    } finally {
      setRouteBusyId(null)
    }
  }

  async function onDestinationChange(routeId: number, destinationId: number) {
    setRouteBusyId(routeId)
    setNotice(null)
    try {
      await updateRoute(routeId, { destination_id: destinationId, stream_id: streamId })
      setNotice('Destination updated for this route.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Update route destination'))
    } finally {
      setRouteBusyId(null)
    }
  }

  async function onToggleRoute(routeId: number, enabled: boolean) {
    setRouteBusyId(routeId)
    setNotice(null)
    try {
      const res = await saveRuntimeRouteEnabledState(routeId, enabled)
      if (!res) {
        setLoadError('Runtime API unavailable · route state unchanged.')
        return
      }
      setNotice(enabled ? 'Route enabled.' : 'Route disabled.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Toggle route'))
    } finally {
      setRouteBusyId(null)
    }
  }

  async function executeDeleteRoute(routeId: number) {
    setRouteBusyId(routeId)
    setNotice(null)
    setLoadError(null)
    try {
      try {
        await deleteRoute(routeId, { streamId })
      } catch (e) {
        if (!isRouteNotFoundDeleteError(e)) throw e
      }
      applyRouteRemoved(routeId)
      setDeleteRouteDialog(null)
      setNotice('Route removed from this stream.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Remove route'))
    } finally {
      setRouteBusyId(null)
    }
  }

  async function onSaveMessagePrefix(routeId: number) {
    const row = routes.find((r) => r.route_id === routeId)
    const draft = prefixDraft[routeId]
    if (!row || !draft) return
    setRouteBusyId(routeId)
    setNotice(null)
    try {
      const prev = { ...(row.formatter_config ?? {}) }
      await updateRoute(routeId, {
        stream_id: streamId,
        formatter_config_json: {
          ...prev,
          message_prefix_enabled: draft.enabled,
          message_prefix_template: draft.template.trim() || DEFAULT_MESSAGE_PREFIX_TEMPLATE,
        },
      })
      setNotice('Message prefix settings saved.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Save message prefix'))
    } finally {
      setRouteBusyId(null)
    }
  }

  async function onFailurePolicy(routeId: number, failure_policy: (typeof FAILURE_POLICIES)[number]) {
    setRouteBusyId(routeId)
    setNotice(null)
    try {
      const res = await saveRuntimeRouteFailurePolicy(routeId, failure_policy)
      if (!res) {
        setLoadError('Runtime API unavailable · failure policy unchanged.')
        return
      }
      setNotice('Failure policy saved.')
      await load()
      onSaved?.()
    } catch (e) {
      setLoadError(formatDeliveryPanelApiError(e, 'Save failure policy'))
    } finally {
      setRouteBusyId(null)
    }
  }

  function destinationTarget(destination: DestinationRead | undefined): string {
    if (!destination) return '—'
    const cfg = destination.config_json ?? {}
    const host = typeof cfg.host === 'string' ? cfg.host : typeof cfg.hostname === 'string' ? cfg.hostname : ''
    const port = typeof cfg.port === 'number' || typeof cfg.port === 'string' ? String(cfg.port) : ''
    const url = typeof cfg.url === 'string' ? cfg.url : typeof cfg.endpoint_url === 'string' ? cfg.endpoint_url : ''
    if (url) return url
    if (host && port) return `${host}:${port}`
    if (host) return host
    return 'Configured target'
  }

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Delivery</h3>
          <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
            Configure routes and destinations for this stream. Route changes are saved through the API immediately.
          </p>
        </div>
        <div className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-500/[0.08] px-2.5 py-1 text-[11px] font-semibold text-emerald-800 dark:border-emerald-500/30 dark:text-emerald-200">
          Routes ({routes.length})
        </div>
      </div>

      {notice ? <p className="mt-2 text-[12px] font-medium text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
      {loadError ? <p className="mt-2 text-[12px] font-medium text-red-700 dark:text-red-300">{loadError}</p> : null}

      <div className="mt-4 rounded-lg border border-slate-200/80 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section">
        <div className="grid gap-2 md:grid-cols-[1fr_220px_auto]">
          <select
            value={newRouteDestinationId}
            onChange={(e) => setNewRouteDestinationId(e.target.value)}
            disabled={routeBusyId === -1 || destinations.length === 0}
            className="h-9 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            {destinations.length === 0 ? (
              <option value="">No destinations available</option>
            ) : (
              destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.destination_type}
                </option>
              ))
            )}
          </select>
          <select
            value={newRouteFailurePolicy}
            onChange={(e) => setNewRouteFailurePolicy(e.target.value as (typeof FAILURE_POLICIES)[number])}
            disabled={routeBusyId === -1 || destinations.length === 0}
            className="h-9 rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
          >
            {FAILURE_POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void onAddRoute()}
            disabled={routeBusyId === -1 || destinations.length === 0 || !newRouteDestinationId}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {routeBusyId === -1 ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
            Add Route
          </button>
        </div>
      </div>

      {busy && routes.length === 0 ? (
        <p className="mt-4 inline-flex items-center gap-2 text-[12px] text-slate-600 dark:text-gdc-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading routes…
        </p>
      ) : routes.length === 0 ? (
        <p className="mt-4 text-[12px] text-slate-600 dark:text-gdc-muted">
          No routes are linked to this stream yet. Select an existing destination above to attach delivery without leaving this page.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:text-gdc-muted">
                <th className="py-2 pr-3">Destination</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3">Target</th>
                <th className="py-2 pr-3">Prefix</th>
                <th className="py-2 pr-3">Prefix template</th>
                <th className="py-2 pr-3">Failure Policy</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-1 text-right">Remove</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => {
                const destination = destinationById.get(r.destination_id)
                return (
                <tr key={r.route_id} className="border-b border-slate-100 dark:border-gdc-border">
                  <td className="py-2 pr-3 align-middle">
                    <select
                      disabled={routeBusyId === r.route_id}
                      value={r.destination_id}
                      onChange={(e) => void onDestinationChange(r.route_id, Number(e.target.value))}
                      className={cn(
                        'h-9 min-w-[180px] rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100',
                        routeBusyId === r.route_id && 'opacity-60',
                      )}
                    >
                      {destinations.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3 align-middle">
                    <span className="font-mono text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
                      {destination?.destination_type ?? r.destination_type ?? '—'}
                    </span>
                  </td>
                  <td className="max-w-[220px] truncate py-2 pr-3 align-middle text-[12px] text-slate-700 dark:text-gdc-mutedStrong">
                    {destinationTarget(destination)}
                  </td>
                  <td className="py-2 pr-3 align-middle">
                    <label className="inline-flex items-center gap-2 text-[11px] text-slate-800 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={prefixDraft[r.route_id]?.enabled ?? defaultMessagePrefixEnabled(r.destination_type ?? '')}
                        disabled={routeBusyId === r.route_id}
                        onChange={(e) =>
                          setPrefixDraft((prev) => ({
                            ...prev,
                            [r.route_id]: {
                              enabled: e.target.checked,
                              template:
                                prev[r.route_id]?.template ??
                                DEFAULT_MESSAGE_PREFIX_TEMPLATE,
                            },
                          }))
                        }
                        className="accent-violet-600"
                      />
                      On
                    </label>
                  </td>
                  <td className="max-w-[320px] py-2 pr-3 align-middle">
                    <div className="space-y-2">
                      <textarea
                        value={prefixDraft[r.route_id]?.template ?? DEFAULT_MESSAGE_PREFIX_TEMPLATE}
                        disabled={routeBusyId === r.route_id}
                        onChange={(e) =>
                          setPrefixDraft((prev) => ({
                            ...prev,
                            [r.route_id]: {
                              enabled: prev[r.route_id]?.enabled ?? defaultMessagePrefixEnabled(r.destination_type ?? ''),
                              template: e.target.value,
                            },
                          }))
                        }
                        rows={3}
                        className="min-h-[72px] w-full min-w-[200px] rounded-md border border-slate-200/90 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                      />
                      <RoutePrefixPreviewBlock
                        streamId={streamId}
                        streamName={mappingCfg?.stream_name ?? `Stream ${streamId}`}
                        routeId={r.route_id}
                        draft={
                          prefixDraft[r.route_id] ?? {
                            enabled: defaultMessagePrefixEnabled(r.destination_type ?? ''),
                            template: DEFAULT_MESSAGE_PREFIX_TEMPLATE,
                          }
                        }
                        destination={destination}
                        destinationType={destination?.destination_type ?? r.destination_type ?? 'SYSLOG_UDP'}
                      />
                      <div
                        className="rounded-md border border-violet-300/70 bg-violet-500/[0.08] p-2 dark:border-violet-500/35 dark:bg-violet-500/10"
                        data-testid={`save-prefix-action-${r.route_id}`}
                      >
                        <p className="text-[10px] font-medium leading-snug text-violet-900 dark:text-violet-100">
                          Prefix changes are not applied until you save this route.
                        </p>
                        <button
                          type="button"
                          disabled={routeBusyId === r.route_id}
                          onClick={() => void onSaveMessagePrefix(r.route_id)}
                          className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3 text-[11px] font-semibold text-white shadow-sm ring-1 ring-violet-500/40 hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                          data-testid={`save-prefix-${r.route_id}`}
                        >
                          {routeBusyId === r.route_id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Save className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Save prefix template
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-3 align-middle">
                    <select
                      disabled={routeBusyId === r.route_id}
                      value={r.failure_policy}
                      onChange={(e) =>
                        void onFailurePolicy(r.route_id, e.target.value as (typeof FAILURE_POLICIES)[number])
                      }
                      className="h-9 min-w-[200px] rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                    >
                      {FAILURE_POLICIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 align-middle">
                    <label className="inline-flex items-center gap-2 text-[12px] font-medium text-slate-800 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={r.route_enabled}
                        disabled={routeBusyId === r.route_id}
                        onChange={(e) => void onToggleRoute(r.route_id, e.target.checked)}
                        className="accent-violet-600"
                      />
                      {r.route_enabled ? 'Enabled' : 'Disabled'}
                    </label>
                  </td>
                  <td className="py-2 pr-1 align-middle text-right">
                    <button
                      type="button"
                      title={
                        r.route_enabled
                          ? 'Disable this route before removing it.'
                          : 'Remove this route from the stream'
                      }
                      disabled={routeBusyId === r.route_id || r.route_enabled}
                      onClick={() =>
                        setDeleteRouteDialog({
                          routeId: r.route_id,
                          destinationName: r.destination_name ?? destinationById.get(r.destination_id)?.name ?? 'destination',
                        })
                      }
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-red-200/90 bg-white text-red-700 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900/60 dark:bg-gdc-card dark:text-red-300 dark:hover:bg-red-950/40"
                      aria-label={r.route_enabled ? 'Remove route (disabled until route is off)' : 'Remove route'}
                    >
                      {routeBusyId === r.route_id ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Trash2 className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {deleteRouteDialog ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && routeBusyId == null) setDeleteRouteDialog(null)
          }}
          title="Remove route from stream?"
          targetName={deleteRouteDialog.destinationName}
          impactBullets={[
            'Removes this delivery path from the stream only.',
            'The destination configuration is kept and can be used by other routes.',
          ]}
          reversibility="You can add a new route to the same destination later."
          primaryLabel="Remove route"
          busy={routeBusyId === deleteRouteDialog.routeId}
          error={loadError}
          onConfirm={() => void executeDeleteRoute(deleteRouteDialog.routeId)}
          dataTestId="route-remove-dialog"
        />
      ) : null}
    </section>
  )
}
