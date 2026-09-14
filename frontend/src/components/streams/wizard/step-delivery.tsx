import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Filter,
  Loader2,
  MoreVertical,
  Network,
  Plus,
  Radio,
  Search,
  Server,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchDestinationsList, testDestination, type DestinationListItem } from '../../../api/gdcDestinations'
import { runFinalEventDraftPreview } from '../../../api/gdcRuntimePreview'
import { NAV_PATH, destinationDetailPath } from '../../../config/nav-paths'
import { cn } from '../../../lib/utils'
import { WIZARD_LABEL } from '../../../lib/operator-vocabulary'
import { DELIVERY_PREVIEW_SAMPLE_EVENT } from '../../../utils/deliveryPreviewSample'
import { DEFAULT_MESSAGE_PREFIX_TEMPLATE, defaultMessagePrefixEnabled } from '../../../utils/messagePrefixDefaults'
import { MessagePrefixDeliveryPreview } from '../message-prefix-delivery-preview'
import {
  deliveryModeFromFailurePolicy,
  destinationLibraryTab,
  duplicateRouteDraft,
  formatWizardSyslogLabel,
  type DestinationLibraryTab,
} from './wizard-delivery-helpers'
import { wizardExtractEvents } from './wizard-json-extract'
import { enrichmentDictFromRows, fieldMappingsFromRows, DEFAULT_ROUTE_PROCESSING_INHERIT, newWizardRouteDraftKey, type WizardDestinationsState, type WizardRouteDraft, type WizardState } from './wizard-state'

function normalizeWebhookPayloadMode(raw: unknown): 'SINGLE_EVENT_OBJECT' | 'BATCH_JSON_ARRAY' {
  if (raw === 'BATCH_JSON_ARRAY') return 'BATCH_JSON_ARRAY'
  return 'SINGLE_EVENT_OBJECT'
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

const textareaCls =
  'min-h-[72px] w-full rounded-md border border-slate-200/90 bg-white px-2.5 py-2 font-mono text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

const btnGhost =
  'inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2.5 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover'

const btnPrimarySm =
  'inline-flex h-8 shrink-0 items-center rounded-md bg-violet-600 px-2.5 text-[11px] font-semibold text-white shadow-sm hover:bg-violet-700'

function buildWizardFinalDraftRequest(state: WizardState) {
  const payload = state.apiTest.parsedJson
  if (payload === null || payload === undefined) return null
  return {
    payload,
    event_array_path: state.stream.eventArrayPath.trim() || null,
    event_root_path: state.stream.eventRootPath.trim() || null,
    field_mappings: fieldMappingsFromRows(state.mapping),
    enrichment: enrichmentDictFromRows(state.enrichment),
    override_policy: 'KEEP_EXISTING' as const,
    max_events: 1,
  }
}

function destinationEndpointLine(dest: DestinationListItem): string {
  const cfg = dest.config_json ?? {}
  if (dest.destination_type === 'WEBHOOK_POST') {
    const u = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    return u || '—'
  }
  const host = typeof cfg.host === 'string' ? cfg.host : '—'
  const port = cfg.port != null ? String(cfg.port) : '514'
  const proto =
    dest.destination_type === 'SYSLOG_TLS' ? 'TLS' : dest.destination_type === 'SYSLOG_TCP' ? 'TCP' : 'UDP'
  return `${formatWizardSyslogLabel(dest.destination_type)} · ${host}:${port} (${proto})`
}

function DestinationRouteCard({
  routeIndex,
  draft,
  destination,
  onRemove,
  onDuplicate,
  onTest,
  testBusy,
  menuOpen,
  onMenuOpenChange,
}: {
  routeIndex: number
  draft: WizardRouteDraft
  destination: DestinationListItem | undefined
  onRemove: () => void
  onDuplicate: () => void
  onTest: () => void
  testBusy: boolean
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onMenuOpenChange(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen, onMenuOpenChange])

  const destLabel = destination?.name?.trim() || `Destination #${draft.destinationId}`
  const endpointShort = destination ? destinationEndpointLine(destination) : '—'

  const routeMenuItemCls =
    'block w-full px-3 py-1.5 text-left text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-gdc-rowHover disabled:opacity-50'

  return (
    <article
      className="rounded-lg border border-slate-200/90 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card"
      data-testid={`destination-route-card-${draft.key}`}
    >
      <div className="flex flex-wrap items-start gap-2 px-3 py-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-[11px] font-bold text-violet-700 dark:text-violet-300">
          {routeIndex}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-[13px] font-semibold text-slate-900 dark:text-slate-50">{destLabel}</h4>
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong">
              Selected
            </span>
          </div>
          <p className="truncate text-[11px] text-slate-500 dark:text-gdc-muted">{endpointShort}</p>
          <p className="mt-1 text-[10px] text-slate-500 dark:text-gdc-muted">
            Tune enabled state, failure policy, and rate limits in Route Processing.
          </p>
        </div>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
            onClick={() => onMenuOpenChange(!menuOpen)}
          >
            <MoreVertical className="h-4 w-4" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-30 mt-1 min-w-[200px] rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-gdc-border dark:bg-gdc-card"
            >
              <button type="button" role="menuitem" className={routeMenuItemCls} onClick={() => { onDuplicate(); onMenuOpenChange(false) }}>
                Duplicate route
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${routeMenuItemCls} text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/40`}
                onClick={() => { onRemove(); onMenuOpenChange(false) }}
              >
                Remove route
              </button>
              <hr className="my-1 border-slate-100 dark:border-gdc-border" />
              <button type="button" role="menuitem" className={routeMenuItemCls} onClick={() => { void onTest(); onMenuOpenChange(false) }} disabled={testBusy}>
                Test destination
              </button>
              <Link
                role="menuitem"
                to={destinationDetailPath(String(draft.destinationId))}
                className={routeMenuItemCls}
                onClick={() => onMenuOpenChange(false)}
              >
                Open destination
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  )
}

const DestinationRouteCardMemo = memo(DestinationRouteCard)

type StepDeliveryProps = {
  state: WizardState
  onChange: (patch: Partial<WizardDestinationsState>) => void
}

export function StepDelivery({ state, onChange }: StepDeliveryProps) {
  const [loading, setLoading] = useState(true)
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  /** True when fetchDestinationsList returned null (failure), not a valid empty catalog. */
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  const [sampleEvent, setSampleEvent] = useState<Record<string, unknown>>(DELIVERY_PREVIEW_SAMPLE_EVENT)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<DestinationLibraryTab>('all')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [testBusyId, setTestBusyId] = useState<number | null>(null)

  const fallbackSampleEvent = useMemo(() => {
    const payload = state.apiTest.parsedJson
    if (payload == null || typeof payload !== 'object') return DELIVERY_PREVIEW_SAMPLE_EVENT
    try {
      const extracted = wizardExtractEvents(
        payload,
        state.stream.eventArrayPath.trim(),
        state.stream.eventRootPath.trim(),
      )
      const first = extracted[0]
      if (first && typeof first === 'object' && !Array.isArray(first)) return first
    } catch {
      // Keep static fallback when extraction cannot be resolved locally.
    }
    return DELIVERY_PREVIEW_SAMPLE_EVENT
  }, [state.apiTest.parsedJson, state.stream.eventArrayPath, state.stream.eventRootPath])

  useEffect(() => {
    const req = buildWizardFinalDraftRequest(state)
    if (!req) {
      setSampleEvent(fallbackSampleEvent)
      return
    }
    let cancelled = false
    void runFinalEventDraftPreview(req)
      .then((res) => {
        if (cancelled) return
        const ev = res.final_events[0]
        if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
          setSampleEvent(ev as Record<string, unknown>)
        } else {
          setSampleEvent(fallbackSampleEvent)
        }
      })
      .catch(() => {
        if (!cancelled) setSampleEvent(fallbackSampleEvent)
      })
    return () => {
      cancelled = true
    }
  }, [
    fallbackSampleEvent,
    state.apiTest.parsedJson,
    state.stream.eventArrayPath,
    state.stream.eventRootPath,
    state.mapping,
    state.enrichment,
  ])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await fetchDestinationsList()
      if (cancelled) return
      if (rows === null) {
        // Failure != empty catalog: keep route drafts; do not crash on null.
        setCatalogLoadFailed(true)
        setDestinations([])
        onChange({ destinationApiBacked: false })
        setLoading(false)
        return
      }
      setCatalogLoadFailed(false)
      setDestinations(rows)
      if (rows.length > 0) {
        onChange({
          destinationApiBacked: true,
          destinationKindsById: Object.fromEntries(rows.map((r) => [r.id, r.destination_type])),
        })
      } else {
        // Valid empty list from API.
        onChange({ destinationApiBacked: true, routeDrafts: [] })
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const destById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

  const addRouteForDestination = useCallback(
    (destinationId: number) => {
      const next: WizardRouteDraft = {
        key: newWizardRouteDraftKey(),
        destinationId,
        enabled: true,
        failurePolicy: 'RETRY_AND_BACKOFF',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      }
      onChange({ routeDrafts: [...state.destinations.routeDrafts, next] })
    },
    [onChange, state.destinations.routeDrafts],
  )

  const filteredLibrary = useMemo(() => {
    const q = search.trim().toLowerCase()
    return destinations.filter((d) => {
      if (!d.enabled) return false
      if (tab !== 'all' && destinationLibraryTab(d.destination_type) !== tab) return false
      if (!q) return true
      const name = (d.name ?? '').toLowerCase()
      const line = destinationEndpointLine(d).toLowerCase()
      return name.includes(q) || line.includes(q) || d.destination_type.toLowerCase().includes(q)
    })
  }, [destinations, search, tab])

  const tabCounts = useMemo(() => {
    const enabled = destinations.filter((d) => d.enabled)
    return {
      all: enabled.length,
      syslog: enabled.filter((d) => destinationLibraryTab(d.destination_type) === 'syslog').length,
      webhook: enabled.filter((d) => destinationLibraryTab(d.destination_type) === 'webhook').length,
      other: enabled.filter((d) => destinationLibraryTab(d.destination_type) === 'other').length,
    }
  }, [destinations])

  const drafts = state.destinations.routeDrafts

  const summary = useMemo(() => {
    const total = drafts.length
    const enabledN = drafts.filter((r) => r.enabled).length
    const destIds = new Set(drafts.map((r) => r.destinationId))
    const reliableN = drafts.filter((r) => deliveryModeFromFailurePolicy(r.failurePolicy) === 'Reliable').length
    const bestN = total - reliableN
    return { total, enabledN, destCount: destIds.size, reliableN, bestN }
  }, [drafts])

  const issueChips = useMemo(() => {
    const chips: string[] = []
    const noRetry = drafts.some((d) => d.enabled && d.failurePolicy === 'LOG_AND_CONTINUE')
    if (noRetry) chips.push('Missing retry')
    if (drafts.length === 1 && drafts[0]?.enabled) chips.push('No backup destination')
    const disabledRoutes = drafts.filter((d) => !d.enabled).length
    if (disabledRoutes > 0) chips.push('Disabled delivery paths')
    const unreachable = drafts.some((d) => {
      const dst = destById.get(d.destinationId)
      return dst && dst.enabled === false
    })
    if (unreachable) chips.push('Unreachable destination')
    const probeFailed = drafts.some((d) => {
      const dst = destById.get(d.destinationId)
      return dst && dst.last_connectivity_test_success === false
    })
    if (probeFailed) chips.push('Last connectivity test failed')
    return chips
  }, [drafts, destById])

  const prefixPreviewRequest = useMemo(() => {
    const first = drafts[0]
    const firstDestId = first?.destinationId
    const destType =
      firstDestId != null ? state.destinations.destinationKindsById[firstDestId] ?? 'SYSLOG_UDP' : 'SYSLOG_UDP'
    const destLabel =
      firstDestId != null ? destById.get(firstDestId)?.name?.trim() ?? '' : ''
    const prefixEnabled =
      firstDestId != null
        ? state.destinations.messagePrefixEnabledByDestinationId[firstDestId] ??
          defaultMessagePrefixEnabled(state.destinations.destinationKindsById[firstDestId] ?? '')
        : defaultMessagePrefixEnabled(destType)
    const tmpl =
      state.destinations.messagePrefixTemplate.trim().length > 0
        ? state.destinations.messagePrefixTemplate.trim()
        : DEFAULT_MESSAGE_PREFIX_TEMPLATE
    const firstMeta =
      firstDestId != null ? destinations.find((o) => o.id === firstDestId) : undefined
    return {
      formatter_config: {
        message_prefix_enabled: prefixEnabled,
        message_prefix_template: tmpl,
      },
      sample_event: sampleEvent,
      destination_type: destType,
      stream: { id: 0, name: state.stream.name },
      destination: {
        id: firstDestId ?? 0,
        name: destLabel,
        type: destType,
        ...(destType === 'WEBHOOK_POST'
          ? { payload_mode: normalizeWebhookPayloadMode(firstMeta?.config_json?.payload_mode) }
          : {}),
      },
      route: { id: 0 },
    }
  }, [
    drafts,
    sampleEvent,
    destinations,
    destById,
    state.destinations.destinationKindsById,
    state.destinations.messagePrefixEnabledByDestinationId,
    state.destinations.messagePrefixTemplate,
    state.stream.name,
  ])

  const handleReset = useCallback(() => {
    if (!drafts.length) return
    if (!window.confirm(`Remove all configured ${WIZARD_LABEL.deliveryPaths.toLowerCase()} for this stream? Destinations themselves will not be deleted.`)) return
    onChange({ routeDrafts: [] })
  }, [drafts.length, onChange])

  const scrollToLibrary = useCallback(() => {
    document.getElementById('wizard-destination-library')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleTestDestination = useCallback(async (destinationId: number) => {
    setTestBusyId(destinationId)
    try {
      await testDestination(destinationId)
    } catch {
      /* surfaced via connectivity columns when available */
    } finally {
      setTestBusyId(null)
    }
  }, [])

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Destinations</h3>
          <p className="max-w-3xl text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            Select where final events will be delivered. Add or remove destinations for this stream — tune enabled
            paths, failure policies, and rate limits in Route Processing.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" className={btnPrimarySm} onClick={scrollToLibrary}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {WIZARD_LABEL.addDeliveryPath}
          </button>
          <button type="button" className={btnGhost} onClick={handleReset} disabled={!drafts.length}>
            Reset {WIZARD_LABEL.deliveryPaths.toLowerCase()}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="inline-flex items-center gap-2 text-[12px] text-slate-600 dark:text-gdc-mutedStrong">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading destinations…
        </p>
      ) : catalogLoadFailed ? (
        <div className="rounded-xl border border-dashed border-amber-300/80 bg-amber-50/80 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-[12px] text-amber-900 dark:text-amber-100">
            Failed to load destinations. Check authentication and API connectivity.
          </p>
        </div>
      ) : destinations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">No destinations configured yet. Create a destination first.</p>
          <Link to={NAV_PATH.destinations} className="mt-2 inline-flex h-9 items-center rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white">
            Go to Destinations
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 space-y-3 lg:max-w-[68%]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                {WIZARD_LABEL.deliveryPaths} ({drafts.length})
              </h4>
            </div>

            <div className="space-y-3">
              {drafts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/50 px-4 py-8 text-center dark:border-gdc-border dark:bg-gdc-section">
                  <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{WIZARD_LABEL.noDeliveryPathsYet}</p>
                  <button type="button" className={cn(btnPrimarySm, 'mt-3')} onClick={scrollToLibrary}>
                    Open destination library
                  </button>
                </div>
              ) : (
                drafts.map((draft, idx) => (
                  <DestinationRouteCardMemo
                    key={draft.key}
                    routeIndex={idx + 1}
                    draft={draft}
                    destination={destById.get(draft.destinationId)}
                    onRemove={() => {
                      onChange({ routeDrafts: drafts.filter((d) => d.key !== draft.key) })
                    }}
                    onDuplicate={() => onChange({ routeDrafts: duplicateRouteDraft(drafts, draft.key) })}
                    onTest={() => handleTestDestination(draft.destinationId)}
                    testBusy={testBusyId === draft.destinationId}
                    menuOpen={menuKey === draft.key}
                    onMenuOpenChange={(open) => setMenuKey(open ? draft.key : null)}
                  />
                ))
              )}
            </div>

            <button type="button" className="w-full rounded-lg border border-dashed border-slate-200 py-2 text-[12px] font-medium text-violet-700 hover:bg-violet-500/5 dark:border-gdc-border dark:text-violet-300" onClick={scrollToLibrary}>
              + {WIZARD_LABEL.addDeliveryPath}
            </button>
            <p className="text-center text-[10px] text-slate-500">Add another {WIZARD_LABEL.deliveryPath.toLowerCase()} for this stream.</p>

            <div className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section">
              <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Message prefix (delivery)</p>
              <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
                When enabled, each destination receives <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">prefix + space + JSON</code> immediately before send.
                Default: on for Syslog, off for Webhook.
              </p>
              <label className="mt-2 block text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">Prefix template</label>
              <textarea
                value={state.destinations.messagePrefixTemplate}
                onChange={(e) => onChange({ messagePrefixTemplate: e.target.value })}
                placeholder={DEFAULT_MESSAGE_PREFIX_TEMPLATE}
                rows={3}
                className={textareaCls}
              />
              <MessagePrefixDeliveryPreview request={prefixPreviewRequest} />
              <ul className="mt-3 space-y-2">
                {drafts.map((d) => {
                  const opt = destById.get(d.destinationId)
                  if (!opt) return null
                  const checked =
                    state.destinations.messagePrefixEnabledByDestinationId[d.destinationId] ??
                    defaultMessagePrefixEnabled(opt.destination_type)
                  return (
                    <li key={`pfx-${d.key}`} className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 font-medium text-slate-800 dark:text-slate-100">{opt.name}</span>
                      <label className="inline-flex items-center gap-2 text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            onChange({
                              messagePrefixEnabledByDestinationId: {
                                ...state.destinations.messagePrefixEnabledByDestinationId,
                                [d.destinationId]: e.target.checked,
                              },
                            })
                          }
                          className="accent-violet-600"
                        />
                        Enable message prefix
                      </label>
                    </li>
                  )
                })}
              </ul>
              {drafts.length === 0 ? (
                <p className="mt-2 text-[10px] text-slate-500">Add delivery paths above to tune prefix per destination.</p>
              ) : null}
            </div>
          </div>

          <aside id="wizard-destination-library" className="w-full shrink-0 space-y-4 lg:sticky lg:top-4 lg:w-[32%] lg:min-w-[280px]">
            <div className="rounded-lg border border-slate-200/90 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Destination library</h4>
                <span title="Filter by category">
                  <Filter className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                </span>
              </div>
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
                <input
                  type="search"
                  placeholder="Search destinations…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className={cn(inputCls, 'h-9 pl-8')}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {(
                  [
                    ['all', 'All', tabCounts.all],
                    ['syslog', 'Syslog', tabCounts.syslog],
                    ['webhook', 'Webhook', tabCounts.webhook],
                    ['other', 'Other', tabCounts.other],
                  ] as const
                ).map(([k, label, n]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTab(k as DestinationLibraryTab)}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                      tab === k
                        ? 'bg-violet-500/15 text-violet-800 dark:text-violet-200'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
                    )}
                  >
                    {label} ({n})
                  </button>
                ))}
              </div>
              <ul className="mt-3 max-h-[320px] space-y-2 overflow-y-auto pr-0.5">
                {filteredLibrary.map((d) => {
                  const icon =
                    d.destination_type === 'WEBHOOK_POST' ? (
                      <Radio className="h-4 w-4 text-pink-500" aria-hidden />
                    ) : (
                      <Server className="h-4 w-4 text-sky-600" aria-hidden />
                    )
                  return (
                    <li
                      key={d.id}
                      className="flex items-start gap-2 rounded-md border border-slate-100 bg-slate-50/50 p-2 dark:border-gdc-border dark:bg-gdc-section"
                    >
                      <span className="mt-0.5 shrink-0 rounded-md bg-white p-1 shadow-sm dark:bg-gdc-card">{icon}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-slate-900 dark:text-slate-50">{d.name}</p>
                        <p className="truncate text-[10px] text-slate-500">{formatWizardSyslogLabel(d.destination_type)}</p>
                        <p className="truncate text-[10px] text-slate-400">{destinationEndpointLine(d)}</p>
                      </div>
                      <button type="button" className={btnPrimarySm} onClick={() => addRouteForDestination(d.id)}>
                        {WIZARD_LABEL.addDeliveryPath}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <Link
                to={NAV_PATH.destinations}
                className="mt-3 flex items-center justify-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Create new destination
              </Link>
            </div>

            <div className="rounded-lg border border-slate-200/90 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Routing summary</h4>
              <dl className="mt-2 space-y-1.5 text-[11px]">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Total delivery paths</dt>
                  <dd className="font-semibold text-slate-800 dark:text-slate-100">{summary.total}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Enabled delivery paths</dt>
                  <dd className="font-semibold text-slate-800 dark:text-slate-100">{summary.enabledN}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Destinations used</dt>
                  <dd className="font-semibold text-slate-800 dark:text-slate-100">{summary.destCount}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Reliable delivery routes</dt>
                  <dd className="font-semibold text-slate-800 dark:text-slate-100">{summary.reliableN}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Best effort routes</dt>
                  <dd className="font-semibold text-slate-800 dark:text-slate-100">{summary.bestN}</dd>
                </div>
              </dl>
              <div className="mt-3 border-t border-slate-100 pt-2 dark:border-gdc-border">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Potential issues
                </p>
                {issueChips.length === 0 ? (
                  <p className="mt-1 text-[10px] text-slate-500">None detected.</p>
                ) : (
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {issueChips.map((c) => (
                      <li
                        key={c}
                        className="rounded-full border border-amber-200/80 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:border-amber-500/30 dark:text-amber-100"
                      >
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="rounded-xl border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Delivery concepts</h4>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              title: 'Reliable delivery',
              body: 'Strict failure handling — retries and backoff protect downstream SLAs.',
              icon: CheckCircle2,
            },
            {
              title: 'Best effort delivery',
              body: 'Non-blocking behavior — minimize back-pressure when loss is acceptable.',
              icon: Radio,
            },
            {
              title: 'Failure policies',
              body: 'Choose pause, retry, disable route, or log-and-continue per route.',
              icon: Network,
            },
            {
              title: 'Rate limiting',
              body: 'Cap EPS and burst per route to shield destinations from overload.',
              icon: Activity,
            },
          ].map((c) => (
            <div key={c.title} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 dark:border-gdc-border dark:bg-gdc-section">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                <c.icon className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" aria-hidden />
                {c.title}
              </p>
              <p className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-gdc-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
