import {
  AlertTriangle,
  Filter,
  Loader2,
  MoreVertical,
  Plus,
  Radio,
  Search,
  Server,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  createDestination,
  fetchDestinationsList,
  invalidateDestinationsListCache,
  sendDestinationTestEvents,
  testDestination,
  type DestinationListItem,
  type DestinationType,
  type DestinationWritePayload,
} from '../../../api/gdcDestinations'
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
import {
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  DEFAULT_ROUTE_PROCESSING_INHERIT,
  newWizardRouteDraftKey,
  type WizardDestinationsState,
  type WizardRouteDraft,
  type WizardState,
} from './wizard-state'

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
  const payload = state.apiTest.parsedJson ?? state.apiTest.rawResponse
  if (payload === null || payload === undefined) return null
  const enrichment = enrichmentDictFromRows(state.enrichment, {
    advancedPassthrough: state.enrichmentPassthrough,
  })
  return {
    payload,
    event_array_path:
      state.stream.useWholeResponseAsEvent || !state.stream.eventArrayPath.trim()
        ? null
        : state.stream.eventArrayPath.trim(),
    event_root_path: state.stream.eventRootPath.trim() || null,
    field_mappings: buildWizardFieldMappingsPayload(state),
    enrichment: state.enrichmentEnabled === false ? {} : enrichment,
    override_policy: state.enrichmentOverridePolicy ?? ('KEEP_EXISTING' as const),
    max_events: 1,
  }
}

function destinationEndpointLine(dest: DestinationListItem): string {
  const cfg = dest.config_json ?? {}
  if (dest.destination_type === 'WEBHOOK_POST') {
    const raw = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    if (!raw) return '—'
    try {
      const url = new URL(raw)
      const port = url.port ? ':' + url.port : ''
      return url.protocol + '//' + url.hostname + port + (url.pathname || '/')
    } catch {
      return 'Webhook endpoint configured'
    }
  }
  const host = typeof cfg.host === 'string' ? cfg.host : '—'
  const port = cfg.port != null ? String(cfg.port) : '514'
  const proto =
    dest.destination_type === 'SYSLOG_TLS' ? 'TLS' : dest.destination_type === 'SYSLOG_TCP' ? 'TCP' : 'UDP'
  return formatWizardSyslogLabel(dest.destination_type) + ' · ' + host + ':' + port + ' (' + proto + ')'
}

function destinationTransportFormat(dest: DestinationListItem): string {
  if (dest.destination_type === 'WEBHOOK_POST') {
    return 'WEBHOOK_POST / ' + normalizeWebhookPayloadMode(dest.config_json?.payload_mode)
  }
  const formatter = dest.config_json?.formatter_config
  const messageFormat =
    formatter && typeof formatter === 'object' && !Array.isArray(formatter) &&
    typeof (formatter as Record<string, unknown>).message_format === 'string'
      ? String((formatter as Record<string, unknown>).message_format)
      : 'json'
  return dest.destination_type + ' / ' + messageFormat
}

type DestinationProbeFeedback = { kind: 'success' | 'failed' | 'unavailable'; message: string }
type DestinationTestDeliveryFeedback = {
  kind: 'success' | 'failed'
  message: string
  testDeliveryId?: string
}

type InlineDestinationDraft = {
  name: string
  destinationType: DestinationType
  url: string
  host: string
  port: string
}

const EMPTY_INLINE_DESTINATION: InlineDestinationDraft = {
  name: '',
  destinationType: 'WEBHOOK_POST',
  url: '',
  host: '',
  port: '514',
}

function inlineDestinationPayload(draft: InlineDestinationDraft): DestinationWritePayload {
  const name = draft.name.trim()
  if (!name) throw new Error('Destination name is required.')
  if (draft.destinationType === 'WEBHOOK_POST') {
    const url = draft.url.trim()
    if (!/^https?:\/\/[^\s/]+/i.test(url)) {
      throw new Error('Webhook URL must start with http:// or https:// and include a host.')
    }
    return {
      name,
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      config_json: { url, payload_mode: 'SINGLE_EVENT_OBJECT' },
      rate_limit_json: {},
    }
  }

  const host = draft.host.trim()
  const port = Number(draft.port)
  if (!host) throw new Error('Syslog host is required.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer from 1 to 65535.')
  }
  if (draft.destinationType === 'SYSLOG_TLS') {
    return {
      name,
      destination_type: 'SYSLOG_TLS',
      enabled: true,
      config_json: { host, port, tls_enabled: true, tls_verify_mode: 'strict' },
      rate_limit_json: {},
    }
  }
  return {
    name,
    destination_type: draft.destinationType,
    enabled: true,
    config_json: {
      host,
      port,
      protocol: draft.destinationType === 'SYSLOG_TCP' ? 'tcp' : 'udp',
    },
    rate_limit_json: {},
  }
}

function DestinationRouteCard({
  routeIndex,
  draft,
  destination,
  onRemove,
  onDuplicate,
  onTest,
  onOpenTestDelivery,
  testBusy,
  testBlocked,
  testFeedback,
  menuOpen,
  onMenuOpenChange,
  onOpenDestinationPrerequisite,
}: {
  routeIndex: number
  draft: WizardRouteDraft
  destination: DestinationListItem | undefined
  onRemove: () => void
  onDuplicate: () => void
  onTest: () => void
  onOpenTestDelivery: () => void
  testBusy: boolean
  testBlocked: boolean
  testFeedback?: DestinationProbeFeedback
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onOpenDestinationPrerequisite?: () => boolean | void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuId = `destination-route-menu-${draft.key}`

  const menuItems = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    )

  const focusMenuItem = (edge: 'first' | 'last') => {
    queueMicrotask(() => {
      const items = menuItems()
      const target = edge === 'last' ? items[items.length - 1] : items[0]
      target?.focus()
    })
  }

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems()
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = current < 0 ? 0 : (current + 1) % items.length
    else if (event.key === 'ArrowUp') nextIndex = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onMenuOpenChange(false)
      queueMicrotask(() => menuButtonRef.current?.focus())
      return
    }
    if (nextIndex == null) return
    event.preventDefault()
    items[nextIndex]?.focus()
  }

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
            ref={menuButtonRef}
            type="button"
            aria-label={`Actions for ${destLabel}`}
            aria-controls={menuId}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover"
            onClick={() => onMenuOpenChange(!menuOpen)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              onMenuOpenChange(true)
              focusMenuItem(event.key === 'ArrowUp' ? 'last' : 'first')
            }}
          >
            <MoreVertical className="h-4 w-4" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              id={menuId}
              role="menu"
              aria-label={`Actions for ${destLabel}`}
              onKeyDown={handleMenuKeyDown}
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
              <button type="button" role="menuitem" className={routeMenuItemCls} onClick={() => { void onTest(); onMenuOpenChange(false) }} disabled={testBlocked}>
                {testBusy ? 'Testing destination…' : 'Test destination'}
              </button>
              <button
                type="button"
                role="menuitem"
                className={routeMenuItemCls}
                onClick={() => { onOpenTestDelivery(); onMenuOpenChange(false) }}
                disabled={!destination?.enabled}
              >
                Send test events…
              </button>
              <Link
                role="menuitem"
                to={destinationDetailPath(String(draft.destinationId))}
                className={routeMenuItemCls}
                onClick={(event) => {
                  onMenuOpenChange(false)
                  if (onOpenDestinationPrerequisite?.() === false) event.preventDefault()
                }}
              >
                Open destination
              </Link>
            </div>
          ) : null}
        </div>
      </div>
      {testBusy ? (
        <p
          role="status"
          data-testid={`destination-connectivity-loading-${draft.key}`}
          className="mx-3 mb-3 inline-flex items-center gap-2 text-xs text-slate-600 dark:text-gdc-mutedStrong"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Checking destination connectivity…
        </p>
      ) : testFeedback ? (
        <p
          role={testFeedback.kind === 'success' ? 'status' : 'alert'}
          data-testid={`destination-connectivity-feedback-${draft.key}`}
          className={cn(
            'mx-3 mb-3 rounded-md border px-3 py-2 text-xs leading-5',
            testFeedback.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
          )}
        >
          {testFeedback.message}
        </p>
      ) : null}
    </article>
  )
}

const DestinationRouteCardMemo = memo(DestinationRouteCard)

type StepDeliveryProps = {
  state: WizardState
  onChange: (patch: Partial<WizardDestinationsState>) => void
  onOpenDestinationPrerequisite?: () => boolean | void
  /** Only the New Stream wizard has a local Create Stream / Resume draft journey. */
  showCreateDraftReturnGuidance?: boolean
  /** A saved Destination is offered for explicit route selection, never auto-attached. */
  recentlyCreatedDestinationId?: number | null
}

export function StepDelivery({
  state,
  onChange,
  onOpenDestinationPrerequisite,
  showCreateDraftReturnGuidance = false,
  recentlyCreatedDestinationId = null,
}: StepDeliveryProps) {
  const [loading, setLoading] = useState(true)
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  /** True when fetchDestinationsList returned null (failure), not a valid empty catalog. */
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false)
  const [sampleEvent, setSampleEvent] = useState<Record<string, unknown>>(DELIVERY_PREVIEW_SAMPLE_EVENT)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<DestinationLibraryTab>('all')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [testBusyId, setTestBusyId] = useState<number | null>(null)
  const [testFeedbackByDestinationId, setTestFeedbackByDestinationId] = useState<Record<number, DestinationProbeFeedback>>({})
  const [inlineCreateOpen, setInlineCreateOpen] = useState(false)
  const [inlineDraft, setInlineDraft] = useState<InlineDestinationDraft>({ ...EMPTY_INLINE_DESTINATION })
  const [inlineCreateBusy, setInlineCreateBusy] = useState(false)
  const [inlineCreateError, setInlineCreateError] = useState<string | null>(null)
  const [inlineCreateNotice, setInlineCreateNotice] = useState<string | null>(null)
  const [testDeliveryDestinationId, setTestDeliveryDestinationId] = useState<number | null>(null)
  const [testDeliveryCount, setTestDeliveryCount] = useState('10')
  const [testDeliveryBusy, setTestDeliveryBusy] = useState(false)
  const [testDeliveryFeedback, setTestDeliveryFeedback] = useState<DestinationTestDeliveryFeedback | null>(null)
  const inlineCreateBusyRef = useRef(false)
  const testDeliveryBusyRef = useRef(false)
  const onChangeRef = useRef(onChange)
  const routeDraftsRef = useRef(state.destinations.routeDrafts)
  const fetchVersionRef = useRef(0)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { routeDraftsRef.current = state.destinations.routeDrafts }, [state.destinations.routeDrafts])

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
    state.apiTest.rawResponse,
    state.stream.useWholeResponseAsEvent,
    state.stream.eventArrayPath,
    state.stream.eventRootPath,
    state.mapping,
    state.mappingMode,
    state.fullEventJsonataExpression,
    state.fullEventRegexConfigJson,
    state.transformRules,
    state.unmappedFieldsPolicy,
    state.enrichment,
    state.enrichmentPassthrough,
    state.enrichmentEnabled,
    state.enrichmentOverridePolicy,
  ])

  const refreshDestinations = useCallback(async (force = false) => {
    const version = ++fetchVersionRef.current
    setLoading(true)
    // Destinations may have been added from another tab; bypass the in-memory TTL.
    if (force) invalidateDestinationsListCache()
    let rows: DestinationListItem[] | null = null
    try {
      rows = await fetchDestinationsList()
    } catch {
      // Transport and authentication errors must not masquerade as an empty catalog.
    }
    if (version !== fetchVersionRef.current) return
    if (rows === null) {
      setCatalogLoadFailed(true)
      onChangeRef.current({ destinationApiBacked: false })
    } else {
      setCatalogLoadFailed(false)
      setDestinations(rows)
      if (rows.length > 0) {
        onChangeRef.current({
          destinationApiBacked: true,
          destinationKindsById: Object.fromEntries(rows.map((r) => [r.id, r.destination_type])),
        })
      } else if (!force) {
        // Preserve the initial empty-catalog contract. A later refresh must not
        // destroy routes the operator may have configured while another tab ran.
        onChangeRef.current({ destinationApiBacked: true, routeDrafts: [] })
      } else {
        onChangeRef.current({ destinationApiBacked: true })
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // A Destination just created outside this Wizard must bypass the cached
    // catalog; otherwise the return screen can claim it does not exist yet.
    void refreshDestinations(recentlyCreatedDestinationId != null)
    const onFocus = () => { void refreshDestinations(true) }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      fetchVersionRef.current += 1
    }
  }, [refreshDestinations, recentlyCreatedDestinationId])

  const destById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])
  const testDeliveryDestination =
    testDeliveryDestinationId != null ? destById.get(testDeliveryDestinationId) : undefined
  const parsedTestDeliveryCount = Number(testDeliveryCount)
  const testDeliveryCountValid =
    Number.isInteger(parsedTestDeliveryCount) && parsedTestDeliveryCount >= 1 && parsedTestDeliveryCount <= 100

  const addRouteForDestination = useCallback(
    (destinationId: number) => {
      const currentDrafts = routeDraftsRef.current
      if (currentDrafts.some((draft) => draft.destinationId === destinationId)) return
      const next: WizardRouteDraft = {
        key: newWizardRouteDraftKey(),
        destinationId,
        enabled: true,
        failurePolicy: 'RETRY_AND_BACKOFF',
        rateLimitJson: {},
        inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
      }
      const nextDrafts = [...currentDrafts, next]
      routeDraftsRef.current = nextDrafts
      onChange({ routeDrafts: nextDrafts })
    },
    [onChange],
  )

  const openInlineDestinationCreate = useCallback(() => {
    setInlineCreateError(null)
    setInlineCreateNotice(null)
    setInlineDraft({ ...EMPTY_INLINE_DESTINATION })
    setInlineCreateOpen(true)
  }, [])

  const cancelInlineDestinationCreate = useCallback(() => {
    if (inlineCreateBusyRef.current) return
    setInlineCreateOpen(false)
    setInlineCreateError(null)
    setInlineDraft({ ...EMPTY_INLINE_DESTINATION })
  }, [])

  const saveInlineDestination = useCallback(async () => {
    if (inlineCreateBusyRef.current) return

    let payload: DestinationWritePayload
    try {
      payload = inlineDestinationPayload(inlineDraft)
    } catch (error) {
      setInlineCreateError(error instanceof Error ? error.message : 'Check the destination fields and retry.')
      return
    }

    inlineCreateBusyRef.current = true
    setInlineCreateBusy(true)
    setInlineCreateError(null)
    setInlineCreateNotice(null)
    try {
      const created = await createDestination(payload)
      const createdListItem: DestinationListItem = {
        ...created,
        streams_using_count: 0,
        routes: [],
      }

      setDestinations((current) => [
        ...current.filter((destination) => destination.id !== created.id),
        createdListItem,
      ])
      setCatalogLoadFailed(false)
      addRouteForDestination(created.id)
      setInlineCreateNotice(`Destination ${created.name} created and delivery path added.`)
      setInlineCreateOpen(false)
      setInlineDraft({ ...EMPTY_INLINE_DESTINATION })

      invalidateDestinationsListCache()
      try {
        const refreshed = await fetchDestinationsList()
        if (refreshed !== null) {
          setDestinations(refreshed)
          onChangeRef.current({
            destinationApiBacked: true,
            destinationKindsById: Object.fromEntries(refreshed.map((destination) => [
              destination.id,
              destination.destination_type,
            ])),
          })
        }
      } catch {
        // The create response is authoritative for this saved destination.
        // Keep the created row and draft attached when catalog refresh is temporarily unavailable.
      }
    } catch {
      setInlineCreateError('Destination save failed. Check required fields and API access, then retry.')
    } finally {
      inlineCreateBusyRef.current = false
      setInlineCreateBusy(false)
    }
  }, [addRouteForDestination, inlineDraft])

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
  const returnedDestination =
    recentlyCreatedDestinationId != null ? destById.get(recentlyCreatedDestinationId) : undefined
  const returnedDestinationHasPath =
    recentlyCreatedDestinationId != null &&
    drafts.some((draft) => draft.destinationId === recentlyCreatedDestinationId)

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

  const openTestDelivery = useCallback((destinationId: number) => {
    const destination = destById.get(destinationId)
    if (!destination?.enabled) return
    setTestDeliveryDestinationId(destinationId)
    setTestDeliveryCount('10')
    setTestDeliveryFeedback(null)
  }, [destById])

  const closeTestDelivery = useCallback(() => {
    if (testDeliveryBusyRef.current) return
    setTestDeliveryDestinationId(null)
    setTestDeliveryCount('10')
    setTestDeliveryFeedback(null)
  }, [])

  const handleSendTestDelivery = useCallback(async () => {
    const destinationId = testDeliveryDestinationId
    const count = Number(testDeliveryCount)
    if (
      testDeliveryBusyRef.current ||
      destinationId == null ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100
    ) return

    testDeliveryBusyRef.current = true
    setTestDeliveryBusy(true)
    setTestDeliveryFeedback(null)
    try {
      const result = await sendDestinationTestEvents(destinationId, count)
      setTestDeliveryFeedback({
        kind: 'success',
        message:
          `Sent ${result.logical_event_count} synthetic logical test event${result.logical_event_count === 1 ? '' : 's'} to ${result.target} as ${result.transport_format}. This did not run or start the Stream or move its checkpoint.`,
        testDeliveryId: result.test_delivery_id,
      })
    } catch {
      setTestDeliveryFeedback({
        kind: 'failed',
        message: 'Test delivery failed. Review the Destination and receiver, then retry.',
      })
    } finally {
      testDeliveryBusyRef.current = false
      setTestDeliveryBusy(false)
    }
  }, [testDeliveryCount, testDeliveryDestinationId])

  const handleTestDestination = useCallback(async (destinationId: number) => {
    if (testBusyId != null) return
    setTestBusyId(destinationId)
    // Do not leave an old success visible while a new test is in flight.
    setTestFeedbackByDestinationId((prev) => {
      const next = { ...prev }
      delete next[destinationId]
      return next
    })
    try {
      const result = await testDestination(destinationId)
      const detail = typeof result?.message === 'string' ? result.message.trim() : ''
      setTestFeedbackByDestinationId((prev) => ({
        ...prev,
        [destinationId]: result?.success === true
          ? {
              kind: 'success',
              message: `Connection check passed.${detail ? ` ${detail}.` : ''} This tests connectivity, not end-to-end Stream delivery.`,
            }
          : {
              kind: 'failed',
              message: `Connection check failed.${detail ? ` ${detail}.` : ''} Open destination to review its settings and retry.`,
            },
      }))
    } catch {
      // Avoid rendering raw exception text; it can contain private network or auth data.
      setTestFeedbackByDestinationId((prev) => ({
        ...prev,
        [destinationId]: {
          kind: 'unavailable',
          message: 'Connection check unavailable. Check authentication and API connectivity, then retry.',
        },
      }))
    } finally {
      setTestBusyId(null)
    }
  }, [testBusyId])

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
          {!loading && !catalogLoadFailed && destinations.length > 0 ? (
            <button
              type="button"
              className={btnGhost}
              onClick={openInlineDestinationCreate}
              disabled={inlineCreateBusy}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Create destination here
            </button>
          ) : null}
          <button
            type="button"
            className={btnGhost}
            onClick={() => void refreshDestinations(true)}
            disabled={loading}
          >
            Refresh destinations
          </button>
          {drafts.length > 0 ? (
            <button type="button" className={btnGhost} onClick={handleReset}>
              Reset {WIZARD_LABEL.deliveryPaths.toLowerCase()}
            </button>
          ) : null}
        </div>
      </div>

      {testDeliveryDestinationId != null && testDeliveryDestination ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="wizard-test-delivery-title"
          data-testid="wizard-test-delivery-dialog"
          className="rounded-xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-500/40 dark:bg-violet-500/10"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 id="wizard-test-delivery-title" className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                Send bounded test events
              </h4>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-gdc-mutedStrong">
                Sends known synthetic events to this saved Destination only. It does not run or start the Stream,
                move its checkpoint, or apply this draft.
              </p>
            </div>
            <button type="button" className={btnGhost} onClick={closeTestDelivery} disabled={testDeliveryBusy}>
              Close
            </button>
          </div>

          <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-3">
            <div className="rounded-md border border-slate-200 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card">
              <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Target</dt>
              <dd className="mt-1 break-all text-slate-800 dark:text-slate-100">
                {destinationEndpointLine(testDeliveryDestination)}
              </dd>
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card">
              <dt className="font-semibold text-slate-500 dark:text-gdc-muted">Format</dt>
              <dd className="mt-1 text-slate-800 dark:text-slate-100">
                {destinationTransportFormat(testDeliveryDestination)}
              </dd>
            </div>
            <label className="rounded-md border border-slate-200 bg-white p-2 font-semibold text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
              Logical events
              <input
                aria-label="Test event count"
                type="number"
                min={1}
                max={100}
                step={1}
                value={testDeliveryCount}
                onChange={(event) => setTestDeliveryCount(event.target.value)}
                className={cn(inputCls, 'mt-1')}
                disabled={testDeliveryBusy}
              />
            </label>
          </dl>

          {!testDeliveryCountValid ? (
            <p role="alert" className="mt-2 text-[11px] font-medium text-red-700 dark:text-red-300">
              Enter a whole number from 1 to 100.
            </p>
          ) : null}

          {testDeliveryFeedback ? (
            <div
              role={testDeliveryFeedback.kind === 'success' ? 'status' : 'alert'}
              data-testid="wizard-test-delivery-feedback"
              className={cn(
                'mt-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed',
                testDeliveryFeedback.kind === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100'
                  : 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100',
              )}
            >
              <p>{testDeliveryFeedback.message}</p>
              {testDeliveryFeedback.testDeliveryId ? (
                <p className="mt-1 font-mono text-[10px]">Test delivery ID: {testDeliveryFeedback.testDeliveryId}</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={closeTestDelivery} disabled={testDeliveryBusy}>
              Cancel
            </button>
            <button
              type="button"
              className={btnPrimarySm}
              onClick={() => void handleSendTestDelivery()}
              disabled={testDeliveryBusy || !testDeliveryCountValid || !testDeliveryDestination.enabled}
            >
              {testDeliveryBusy ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                  Sending…
                </>
              ) : (
                `Send ${testDeliveryCountValid ? parsedTestDeliveryCount : ''} test event${parsedTestDeliveryCount === 1 ? '' : 's'}`
              )}
            </button>
          </div>
        </div>
      ) : null}

      {inlineCreateNotice ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
          data-testid="wizard-inline-destination-created"
        >
          {inlineCreateNotice}
        </p>
      ) : null}

      {inlineCreateOpen ? (
        <form
          data-testid="wizard-inline-destination-form"
          className="rounded-xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-500/40 dark:bg-violet-500/10"
          onSubmit={(event) => {
            event.preventDefault()
            void saveInlineDestination()
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">Create destination in this Flow</h4>
              <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-mutedStrong">
                Save a reusable Destination and attach one Route draft without leaving the current Stream setup.
              </p>
            </div>
            <button type="button" className={btnGhost} onClick={cancelInlineDestinationCreate} disabled={inlineCreateBusy}>
              Cancel
            </button>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              Destination name
              <input
                aria-label="Destination name"
                value={inlineDraft.name}
                onChange={(event) => setInlineDraft((draft) => ({ ...draft, name: event.target.value }))}
                className={cn(inputCls, 'mt-1')}
                autoFocus
              />
            </label>
            <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              Destination type
              <select
                aria-label="Destination type"
                value={inlineDraft.destinationType}
                onChange={(event) => {
                  const destinationType = event.target.value as DestinationType
                  setInlineDraft((draft) => ({
                    ...draft,
                    destinationType,
                    port: destinationType === 'SYSLOG_TLS' ? '6514' : destinationType === 'WEBHOOK_POST' ? draft.port : '514',
                  }))
                }}
                className={cn(inputCls, 'mt-1')}
              >
                <option value="WEBHOOK_POST">Webhook (HTTP POST)</option>
                <option value="SYSLOG_UDP">Syslog UDP</option>
                <option value="SYSLOG_TCP">Syslog TCP</option>
                <option value="SYSLOG_TLS">Syslog TLS</option>
              </select>
            </label>
          </div>

          {inlineDraft.destinationType === 'WEBHOOK_POST' ? (
            <label className="mt-3 block text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              Webhook URL
              <input
                aria-label="Webhook URL"
                value={inlineDraft.url}
                onChange={(event) => setInlineDraft((draft) => ({ ...draft, url: event.target.value }))}
                placeholder="https://receiver.example/events"
                className={cn(inputCls, 'mt-1')}
              />
            </label>
          ) : (
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_160px]">
              <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                Syslog host
                <input
                  aria-label="Syslog host"
                  value={inlineDraft.host}
                  onChange={(event) => setInlineDraft((draft) => ({ ...draft, host: event.target.value }))}
                  placeholder="receiver.internal"
                  className={cn(inputCls, 'mt-1')}
                />
              </label>
              <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                Port
                <input
                  aria-label="Destination port"
                  inputMode="numeric"
                  value={inlineDraft.port}
                  onChange={(event) => setInlineDraft((draft) => ({ ...draft, port: event.target.value }))}
                  className={cn(inputCls, 'mt-1')}
                />
              </label>
            </div>
          )}

          {inlineDraft.destinationType === 'SYSLOG_TLS' ? (
            <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-muted">
              TLS verification uses the product default: strict. Use Manage all destinations for advanced certificate settings.
            </p>
          ) : null}

          {inlineCreateError ? (
            <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
              {inlineCreateError}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className={btnGhost} onClick={cancelInlineDestinationCreate} disabled={inlineCreateBusy}>
              Cancel
            </button>
            <button type="submit" className={btnPrimarySm} disabled={inlineCreateBusy}>
              {inlineCreateBusy ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                  Saving…
                </>
              ) : (
                'Create and add delivery path'
              )}
            </button>
          </div>
        </form>
      ) : null}

      {recentlyCreatedDestinationId != null ? (
        <div data-testid="wizard-returned-destination" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-[12px] text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100">
          <p role="status">
            Destination #{recentlyCreatedDestinationId} saved. Choose Add delivery path once it appears in the catalog; no Route was added automatically.
            {returnedDestinationHasPath
              ? ' A delivery path is already configured for this destination.'
              : returnedDestination?.enabled
                ? ' This destination is now available.'
                : returnedDestination && !returnedDestination.enabled
                  ? ' This destination is disabled; enable it in Destinations before adding a path.'
                  : catalogLoadFailed
                    ? ' Destination list unavailable; retry loading before selecting a path.'
                    : ' Refresh the catalog if the destination is not visible yet.'}
          </p>
          {!returnedDestinationHasPath && returnedDestination?.enabled && !loading && !catalogLoadFailed ? (
            <button
              type="button"
              className={btnPrimarySm}
              data-testid="wizard-add-returned-destination"
              onClick={() => addRouteForDestination(returnedDestination.id)}
            >
              Add delivery path to {returnedDestination.name}
            </button>
          ) : !loading && !catalogLoadFailed && !returnedDestination ? (
            <button type="button" data-testid="wizard-refresh-returned-destination" className={btnGhost} onClick={() => void refreshDestinations(true)}>
              Refresh destinations
            </button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <p className="inline-flex items-center gap-2 text-[12px] text-slate-600 dark:text-gdc-mutedStrong">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading destinations…
        </p>
      ) : catalogLoadFailed ? (
        <div role="alert" className="rounded-xl border border-dashed border-amber-300/80 bg-amber-50/80 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-[12px] text-amber-900 dark:text-amber-100">
            Failed to load destinations. Check authentication and API connectivity.
          </p>
          <button type="button" className={cn(btnGhost, 'mt-3 min-h-10')} onClick={() => void refreshDestinations(true)}>
            Retry loading destinations
          </button>
        </div>
      ) : destinations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 dark:border-gdc-border dark:bg-gdc-card">
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">No destinations configured yet. Create one here without leaving this Flow.</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button type="button" className={btnPrimarySm} onClick={openInlineDestinationCreate}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Create destination here
            </button>
            <Link
              to={NAV_PATH.destinations}
              state={showCreateDraftReturnGuidance ? { returnToSavedWizardDraft: true } : undefined}
              onClick={(event) => {
                if (onOpenDestinationPrerequisite?.() === false) event.preventDefault()
              }}
              className="text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
            >
              Manage all destinations
            </Link>
          </div>
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
                    onOpenTestDelivery={() => openTestDelivery(draft.destinationId)}
                    testBusy={testBusyId === draft.destinationId}
                    testBlocked={testBusyId != null}
                    testFeedback={testFeedbackByDestinationId[draft.destinationId]}
                    menuOpen={menuKey === draft.key}
                    onMenuOpenChange={(open) => setMenuKey(open ? draft.key : null)}
                    onOpenDestinationPrerequisite={onOpenDestinationPrerequisite}
                  />
                ))
              )}
            </div>

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
                {filteredLibrary.length === 0 ? (
                  <li role="status" data-testid="destination-library-empty" className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center dark:border-gdc-border dark:bg-gdc-section">
                    <p className="text-xs text-slate-600 dark:text-gdc-mutedStrong">
                      {tabCounts.all === 0 ? 'No enabled destinations are available.' : 'No destinations match this search or filter.'}
                    </p>
                    {tabCounts.all > 0 ? (
                      <button
                        type="button"
                        className="mt-2 text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
                        onClick={() => { setSearch(''); setTab('all') }}
                      >
                        Clear destination filters
                      </button>
                    ) : (
                      <Link
                        to={NAV_PATH.destinations}
                        state={showCreateDraftReturnGuidance ? { returnToSavedWizardDraft: true } : undefined}
                        onClick={(event) => {
                          if (onOpenDestinationPrerequisite?.() === false) event.preventDefault()
                        }}
                        className="mt-2 inline-block text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      >
                        Manage destinations
                      </Link>
                    )}
                  </li>
                ) : null}
                {filteredLibrary.map((d) => {
                  const alreadyAdded = drafts.some((draft) => draft.destinationId === d.id)
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
                      <button
                        type="button"
                        className={btnPrimarySm}
                        onClick={() => addRouteForDestination(d.id)}
                        disabled={alreadyAdded}
                      >
                        {alreadyAdded ? 'Added' : WIZARD_LABEL.addDeliveryPath}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <Link
                to={NAV_PATH.destinations}
                state={showCreateDraftReturnGuidance ? { returnToSavedWizardDraft: true } : undefined}
                onClick={(event) => {
                  if (onOpenDestinationPrerequisite?.() === false) event.preventDefault()
                }}
                className="mt-3 flex items-center justify-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
              >
                Manage all destinations
              </Link>
              {showCreateDraftReturnGuidance && onOpenDestinationPrerequisite ? (
                <p className="mt-1 text-center text-[11px] leading-4 text-slate-500 dark:text-gdc-muted" data-testid="wizard-destination-resume-guidance">
                  Opening Destinations saves this Stream draft first. After saving, return to this step automatically; Resume draft remains available if you leave.
                </p>
              ) : null}
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

    </section>
  )
}
