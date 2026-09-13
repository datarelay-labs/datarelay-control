import { ArrowRight, HelpCircle, Play, Save, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { StatusBadge } from '../shell/status-badge'
import { PanelChrome } from '../streams/mapping-json-tree'
import { createRoute, fetchRouteById, fetchRouteByIdFresh, isRouteStaleWriteError, updateRoute } from '../../api/gdcRoutes'
import { fetchStreamById } from '../../api/gdcStreams'
import { fetchConnectorById } from '../../api/gdcConnectors'
import { fetchRouteTransformEffective, type RouteTransformEffective } from '../../api/gdcRouteTransform'
import { fetchRouteProtectionEffective, type RouteProtectionEffective } from '../../api/gdcRouteProtection'
import { fetchRouteClassificationEffective, type RouteClassificationEffective } from '../../api/gdcRouteClassification'
import { fetchRoutePolicyEffective, type RoutePolicyEffective } from '../../api/gdcRoutePolicy'
import { ROUTE_EDIT_DEFAULTS, type RouteDeliveryMode, type RouteFailurePolicy, type RouteRetryBackoff } from './route-edit-defaults'
import {
  defaultsRouteDeliveryFormState,
  isRouteDeliveryDirty,
  type RouteDeliveryFormState,
} from './route-delivery-dirty'
import { streamRuntimePath } from '../../config/nav-paths'
import { RouteDetailHealthPanel } from './route-detail-health-panel'
import { RouteEditTransformPanel } from './route-edit-transform-panel'
import { ProtectionPanel } from '../streams/protection-panel'
import { ClassificationPanel } from '../streams/classification-panel'
import { PolicyPanel } from '../streams/policy-panel'
import { fetchDestinationsList } from '../../api/gdcDestinations'
import { HelpTooltip } from '../ui/help-tooltip'
import { HELP_COPY } from '../ui/help-tooltip-copy'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

type RouteEditTab = 'delivery' | 'transform' | 'protection' | 'classification' | 'policy'

function failurePolicyFromApi(raw: string): RouteFailurePolicy {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'retry' || normalized === 'retry_and_backoff') return 'Retry'
  if (normalized === 'pause_stream' || normalized === 'pause_stream_on_failure') return 'Pause Stream'
  if (normalized === 'disable_route' || normalized === 'disable_route_on_failure') return 'Disable Route'
  return 'Log and Continue'
}

function applyRouteDeliveryFields(found: {
  failure_policy?: string | null
  formatter_config_json?: Record<string, unknown> | null
  rate_limit_json?: Record<string, unknown> | null
}): {
  failurePolicy: RouteFailurePolicy
  deliveryMode: RouteDeliveryMode
  rateLimitEnabled: boolean
  perSecond: number
  burstSize: number
  maxRetry: number
  retryBackoff: RouteRetryBackoff
  initialBackoffSec: number
  maxBackoffSec: number
  maxDeliveryTimeSec: number
  batchSize: number
} {
  const d = ROUTE_EDIT_DEFAULTS
  const formatter = found.formatter_config_json ?? {}
  const rate = found.rate_limit_json ?? {}
  const deliveryModeRaw = String(formatter.delivery_mode ?? d.deliveryMode)
  const deliveryMode: RouteDeliveryMode =
    deliveryModeRaw === 'Best Effort' || deliveryModeRaw === 'BEST_EFFORT' ? 'Best Effort' : 'Reliable'
  const rateEnabled = rate.enabled === true || (rate.enabled !== false && typeof rate.per_second === 'number')
  const retryBackoffRaw = String(rate.retry_backoff ?? d.retryBackoff)
  return {
    failurePolicy:
      typeof found.failure_policy === 'string' && found.failure_policy.trim()
        ? failurePolicyFromApi(found.failure_policy)
        : d.failurePolicy,
    deliveryMode,
    rateLimitEnabled: rateEnabled,
    perSecond: typeof rate.per_second === 'number' ? rate.per_second : d.perSecond,
    burstSize: typeof rate.burst_size === 'number' ? rate.burst_size : d.burstSize,
    maxRetry: typeof rate.max_retry === 'number' ? rate.max_retry : d.maxRetry,
    retryBackoff: retryBackoffRaw.toLowerCase() === 'linear' ? 'Linear' : 'Exponential',
    initialBackoffSec: typeof rate.initial_backoff_sec === 'number' ? rate.initial_backoff_sec : d.initialBackoffSec,
    maxBackoffSec: typeof rate.max_backoff_sec === 'number' ? rate.max_backoff_sec : d.maxBackoffSec,
    maxDeliveryTimeSec: typeof rate.max_delivery_time_sec === 'number' ? rate.max_delivery_time_sec : d.maxDeliveryTimeSec,
    batchSize: typeof rate.batch_size === 'number' ? rate.batch_size : d.batchSize,
  }
}

function Field({
  label,
  children,
  hint,
  help,
}: {
  label: string
  children: ReactNode
  hint?: string
  help?: { content: ReactNode; example?: string; ariaLabel?: string }
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-slate-600 dark:text-gdc-muted">
      <span className="flex items-center gap-1 font-semibold text-slate-700 dark:text-gdc-mutedStrong">
        {label}
        {help ? (
          <HelpTooltip
            content={help.content}
            example={help.example}
            ariaLabel={help.ariaLabel ?? `${label} help`}
          />
        ) : null}
      </span>
      {children}
      {hint ? <span className="text-[10px] text-slate-500">{hint}</span> : null}
    </label>
  )
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

export function RouteEditPage() {
  const { routeId = '' } = useParams<{ routeId: string }>()
  const backendRouteId = /^\d+$/.test(routeId) ? Number(routeId) : null
  const isCreateMode = backendRouteId == null
  const navigate = useNavigate()
  const d = ROUTE_EDIT_DEFAULTS

  const [routeName, setRouteName] = useState(d.routeName)
  const [description, setDescription] = useState(d.description)
  const [enabled, setEnabled] = useState(d.status === 'ENABLED')
  const [deliveryMode, setDeliveryMode] = useState<RouteDeliveryMode>(d.deliveryMode)
  const [failurePolicy, setFailurePolicy] = useState<RouteFailurePolicy>(d.failurePolicy)
  const [maxRetry, setMaxRetry] = useState(d.maxRetry)
  const [retryBackoff, setRetryBackoff] = useState<RouteRetryBackoff>(d.retryBackoff)
  const [initialBackoffSec, setInitialBackoffSec] = useState(d.initialBackoffSec)
  const [maxBackoffSec, setMaxBackoffSec] = useState(d.maxBackoffSec)
  const [maxDeliveryTimeSec, setMaxDeliveryTimeSec] = useState(d.maxDeliveryTimeSec)
  const [batchSize, setBatchSize] = useState(d.batchSize)
  const [rateLimitEnabled, setRateLimitEnabled] = useState(d.rateLimitEnabled)
  const [perSecond, setPerSecond] = useState(d.perSecond)
  const [burstSize, setBurstSize] = useState(d.burstSize)
  const [activeTab, setActiveTab] = useState<RouteEditTab>('delivery')
  const [visitedTabs, setVisitedTabs] = useState<Set<RouteEditTab>>(() => new Set<RouteEditTab>(['delivery']))
  const [transformEffective, setTransformEffective] = useState<RouteTransformEffective | null>(null)
  const [protectionEffective, setProtectionEffective] = useState<RouteProtectionEffective | null>(null)
  const [classificationEffective, setClassificationEffective] = useState<RouteClassificationEffective | null>(null)
  const [policyEffective, setPolicyEffective] = useState<RoutePolicyEffective | null>(null)
  const transformStatus = transformEffective?.processing_status ?? null
  const protectionStatus = protectionEffective?.processing_status ?? null
  const classificationStatus = classificationEffective?.processing_status ?? null
  const policyStatus = policyEffective?.processing_status ?? null
  const [backendStreamId, setBackendStreamId] = useState<number | null>(null)
  const [backendDestinationId, setBackendDestinationId] = useState<number | null>(null)
  const [destinationOptions, setDestinationOptions] = useState<Array<{ id: number; label: string }>>([])
  const [destinationSource, setDestinationSource] = useState<'api' | 'empty'>('empty')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [staleConflict, setStaleConflict] = useState(false)
  const [routeUpdatedAt, setRouteUpdatedAt] = useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false)
  const [deliveryBaseline, setDeliveryBaseline] = useState<RouteDeliveryFormState | null>(
    isCreateMode ? defaultsRouteDeliveryFormState() : null,
  )
  const [transformDirty, setTransformDirty] = useState(false)
  const [connectorLabel, setConnectorLabel] = useState('—')
  const [streamLabel, setStreamLabel] = useState('—')
  const destinationLabel = useMemo(() => {
    const found = destinationOptions.find((o) => o.id === backendDestinationId)
    return found?.label ?? '—'
  }, [destinationOptions, backendDestinationId])

  const currentDeliveryForm = useMemo<RouteDeliveryFormState>(
    () => ({
      routeName,
      description,
      enabled,
      destinationId: backendDestinationId,
      deliveryMode,
      failurePolicy,
      maxRetry,
      retryBackoff,
      initialBackoffSec,
      maxBackoffSec,
      maxDeliveryTimeSec,
      batchSize,
      rateLimitEnabled,
      perSecond,
      burstSize,
    }),
    [
      routeName,
      description,
      enabled,
      backendDestinationId,
      deliveryMode,
      failurePolicy,
      maxRetry,
      retryBackoff,
      initialBackoffSec,
      maxBackoffSec,
      maxDeliveryTimeSec,
      batchSize,
      rateLimitEnabled,
      perSecond,
      burstSize,
    ],
  )

  const deliveryDirty = isRouteDeliveryDirty(deliveryBaseline, currentDeliveryForm)
  const hasUnsavedChanges = deliveryDirty || transformDirty

  const applyDeliveryForm = useCallback((form: RouteDeliveryFormState) => {
    setRouteName(form.routeName)
    setDescription(form.description)
    setEnabled(form.enabled)
    setBackendDestinationId(form.destinationId)
    setFailurePolicy(form.failurePolicy)
    setDeliveryMode(form.deliveryMode)
    setRateLimitEnabled(form.rateLimitEnabled)
    setPerSecond(form.perSecond)
    setBurstSize(form.burstSize)
    setMaxRetry(form.maxRetry)
    setRetryBackoff(form.retryBackoff)
    setInitialBackoffSec(form.initialBackoffSec)
    setMaxBackoffSec(form.maxBackoffSec)
    setMaxDeliveryTimeSec(form.maxDeliveryTimeSec)
    setBatchSize(form.batchSize)
  }, [])

  const leaveWithoutSaving = useCallback(() => {
    if (backendStreamId != null) navigate(streamRuntimePath(String(backendStreamId)))
    else navigate(isCreateMode ? '/routes' : '/streams')
  }, [backendStreamId, isCreateMode, navigate])

  const requestLeave = useCallback(() => {
    if (hasUnsavedChanges) {
      setDiscardOpen(true)
      return
    }
    leaveWithoutSaving()
  }, [hasUnsavedChanges, leaveWithoutSaving])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges])

  const processingStatusGenRef = useRef(0)
  const refreshProcessingStatus = useCallback(async (routeId: number) => {
    const gen = ++processingStatusGenRef.current
    const [transformEffective, protectionEffective, classificationEffective, policyEffective] = await Promise.all([
      fetchRouteTransformEffective(routeId),
      fetchRouteProtectionEffective(routeId),
      fetchRouteClassificationEffective(routeId),
      fetchRoutePolicyEffective(routeId),
    ])
    if (gen !== processingStatusGenRef.current) return
    setTransformEffective(transformEffective)
    setProtectionEffective(protectionEffective)
    setClassificationEffective(classificationEffective)
    setPolicyEffective(policyEffective)
  }, [])

  const applyServerRoute = useCallback(
    (found: {
      name?: string | null
      description?: string | null
      enabled?: boolean | null
      destination_id?: number | null
      stream_id?: number | null
      failure_policy?: string | null
      formatter_config_json?: Record<string, unknown> | null
      rate_limit_json?: Record<string, unknown> | null
      updated_at?: string | null
    }) => {
      const delivery = applyRouteDeliveryFields(found)
      const form: RouteDeliveryFormState = {
        routeName: found.name?.trim() || d.routeName,
        description: typeof found.description === 'string' ? found.description : '',
        enabled: typeof found.enabled === 'boolean' ? found.enabled : d.status === 'ENABLED',
        destinationId: typeof found.destination_id === 'number' ? found.destination_id : null,
        deliveryMode: delivery.deliveryMode,
        failurePolicy: delivery.failurePolicy,
        maxRetry: delivery.maxRetry,
        retryBackoff: delivery.retryBackoff,
        initialBackoffSec: delivery.initialBackoffSec,
        maxBackoffSec: delivery.maxBackoffSec,
        maxDeliveryTimeSec: delivery.maxDeliveryTimeSec,
        batchSize: delivery.batchSize,
        rateLimitEnabled: delivery.rateLimitEnabled,
        perSecond: delivery.perSecond,
        burstSize: delivery.burstSize,
      }
      if (typeof found.stream_id === 'number') setBackendStreamId(found.stream_id)
      applyDeliveryForm(form)
      setDeliveryBaseline(form)
      setRouteUpdatedAt(typeof found.updated_at === 'string' ? found.updated_at : null)
      setTransformDirty(false)
      setStaleConflict(false)
      setSaveError(null)
      setSaveSuccess(null)
    },
    [applyDeliveryForm, d.routeName, d.status],
  )

  const reloadLatestFromServer = useCallback(async () => {
    if (backendRouteId == null) return
    const found = await fetchRouteByIdFresh(backendRouteId)
    if (!found) {
      setSaveError('Could not refresh the latest route from the server.')
      return
    }
    applyServerRoute(found)
    void refreshProcessingStatus(backendRouteId)
  }, [applyServerRoute, backendRouteId, refreshProcessingStatus])

  const requestRefreshLatest = useCallback(() => {
    if (hasUnsavedChanges) {
      setRefreshConfirmOpen(true)
      return
    }
    void reloadLatestFromServer()
  }, [hasUnsavedChanges, reloadLatestFromServer])

  useEffect(() => {
    let cancelled = false
    if (backendRouteId == null) {
      setTransformEffective(null)
      setProtectionEffective(null)
      setClassificationEffective(null)
      setPolicyEffective(null)
      setDeliveryBaseline(defaultsRouteDeliveryFormState())
      setRouteUpdatedAt(null)
      setTransformDirty(false)
      setStaleConflict(false)
      return
    }
    const routeId = backendRouteId
    setTransformEffective(null)
    setProtectionEffective(null)
    setClassificationEffective(null)
    setPolicyEffective(null)
    setDeliveryBaseline(null)
    setRouteUpdatedAt(null)
    setTransformDirty(false)
    setStaleConflict(false)
    ;(async () => {
      const found = await fetchRouteById(routeId)
      if (!found || cancelled) return
      // Dirty-safety: never clobber local edits if the operator already changed the form
      // before this in-flight load resolves (e.g. remount race / delayed response).
      applyServerRoute(found)
      void refreshProcessingStatus(routeId)
    })()
    return () => {
      cancelled = true
      processingStatusGenRef.current += 1
    }
  }, [applyServerRoute, backendRouteId, refreshProcessingStatus])

  useEffect(() => {
    let cancelled = false
    if (backendStreamId == null) {
      setStreamLabel('—')
      setConnectorLabel('—')
      return
    }
    ;(async () => {
      const stream = await fetchStreamById(backendStreamId)
      if (cancelled || !stream) return
      setStreamLabel(stream.name?.trim() || `Stream #${stream.id}`)
      const cid = typeof stream.connector_id === 'number' ? stream.connector_id : null
      if (cid == null) {
        setConnectorLabel('—')
        return
      }
      const connector = await fetchConnectorById(cid)
      if (!cancelled) setConnectorLabel(connector?.name?.trim() || `Connector #${cid}`)
    })()
    return () => {
      cancelled = true
    }
  }, [backendStreamId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const rows = await fetchDestinationsList()
      if (cancelled) return
      if (rows?.length) {
        const next = rows.map((row) => ({ id: row.id, label: (row.name ?? '').trim() || `Destination #${row.id}` }))
        setDestinationOptions(next)
        setDestinationSource('api')
        setBackendDestinationId((prev) => {
          if (prev != null) return prev
          const id = next[0]?.id ?? null
          if (id != null && isCreateMode) {
            setDeliveryBaseline((base) => (base ? { ...base, destinationId: base.destinationId ?? id } : base))
          }
          return id
        })
        return
      }
      setDestinationOptions([])
      setDestinationSource('empty')
    })()
    return () => {
      cancelled = true
    }
  }, [isCreateMode])

  async function handleSaveRoute() {
    if (isSaving || (!isCreateMode && !deliveryDirty)) return
    setIsSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    setStaleConflict(false)
    try {
      const policy =
        failurePolicy === 'Retry'
          ? 'retry'
          : failurePolicy === 'Log and Continue'
            ? 'log_and_continue'
            : failurePolicy === 'Pause Stream'
              ? 'pause_stream'
              : 'disable_route'
      const routePayload = {
        name: routeName,
        description,
        enabled,
        stream_id: backendStreamId,
        destination_id: backendDestinationId,
        failure_policy: policy,
        status: enabled ? 'ENABLED' : 'DISABLED',
        formatter_config_json: {
          delivery_mode: deliveryMode,
        },
        rate_limit_json: rateLimitEnabled
          ? {
              enabled: true,
              per_second: perSecond,
              burst_size: burstSize,
              max_retry: maxRetry,
              retry_backoff: retryBackoff,
              initial_backoff_sec: initialBackoffSec,
              max_backoff_sec: maxBackoffSec,
              max_delivery_time_sec: maxDeliveryTimeSec,
              batch_size: batchSize,
            }
          : { enabled: false },
      }
      if (!isCreateMode) {
        if (!routeUpdatedAt) {
          setSaveError('Route concurrency token missing. Refresh the latest route before saving.')
          setStaleConflict(true)
          return
        }
      }
      const saved = isCreateMode
        ? await createRoute(routePayload)
        : await updateRoute(backendRouteId, {
            ...routePayload,
            expected_updated_at: routeUpdatedAt as string,
          })
      const delivery = applyRouteDeliveryFields(saved)
      const nextBaseline: RouteDeliveryFormState = {
        routeName: saved.name?.trim() || routeName,
        description: typeof saved.description === 'string' ? saved.description : description,
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : enabled,
        destinationId: typeof saved.destination_id === 'number' ? saved.destination_id : backendDestinationId,
        deliveryMode: delivery.deliveryMode,
        failurePolicy: delivery.failurePolicy,
        maxRetry: delivery.maxRetry,
        retryBackoff: delivery.retryBackoff,
        initialBackoffSec: delivery.initialBackoffSec,
        maxBackoffSec: delivery.maxBackoffSec,
        maxDeliveryTimeSec: delivery.maxDeliveryTimeSec,
        batchSize: delivery.batchSize,
        rateLimitEnabled: delivery.rateLimitEnabled,
        perSecond: delivery.perSecond,
        burstSize: delivery.burstSize,
      }
      applyDeliveryForm(nextBaseline)
      setDeliveryBaseline(nextBaseline)
      setRouteUpdatedAt(typeof saved.updated_at === 'string' ? saved.updated_at : null)
      setStaleConflict(false)
      setSaveSuccess(isCreateMode ? 'Route created. Moving to stream runtime…' : 'Route saved. Moving to stream runtime…')
      const runtimeStreamId = typeof saved.stream_id === 'number' ? saved.stream_id : backendStreamId
      if (typeof runtimeStreamId === 'number') navigate(streamRuntimePath(String(runtimeStreamId)))
      else navigate('/routes')
    } catch (err) {
      if (isRouteStaleWriteError(err)) {
        setStaleConflict(true)
        setSaveError(
          'This route changed since you started editing. Your unsaved changes are still preserved. Refresh/review the latest route before saving again.',
        )
        setSaveSuccess(null)
        return
      }
      const message = err instanceof Error ? err.message : 'Route save failed.'
      setSaveError(`API save failed: ${message}`)
      setSaveSuccess(null)
    } finally {
      setIsSaving(false)
    }
  }

  const saveStatusLabel = isSaving
    ? 'Saving…'
    : staleConflict
      ? 'Conflict'
      : saveError
        ? 'Save failed'
        : saveSuccess
          ? 'Saved'
          : hasUnsavedChanges
            ? 'Unsaved changes'
            : 'Saved'
  return (
    <div className="w-full min-w-0 space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200/70 bg-white/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">{isCreateMode ? 'New Route' : 'Edit Route'}</h2>
            <StatusBadge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'ENABLED' : 'DISABLED'}</StatusBadge>
            {!isCreateMode && (transformStatus || protectionStatus || classificationStatus || policyStatus) ? (
              <span className="flex flex-wrap items-center gap-1.5" data-testid="route-processing-status">
                {transformStatus ? (
                  <StatusBadge
                    tone={transformStatus === 'Overridden' ? 'warning' : transformStatus === 'Mixed' ? 'warning' : 'neutral'}
                    data-testid="route-transform-processing-status"
                  >
                    Transform: {transformStatus}
                  </StatusBadge>
                ) : null}
                {protectionStatus ? (
                  <StatusBadge
                    tone={protectionStatus === 'Overridden' ? 'warning' : protectionStatus === 'Mixed' ? 'warning' : 'neutral'}
                    data-testid="route-protection-processing-status"
                  >
                    Protection: {protectionStatus}
                  </StatusBadge>
                ) : null}
                {classificationStatus ? (
                  <StatusBadge
                    tone={classificationStatus === 'Overridden' ? 'warning' : classificationStatus === 'Mixed' ? 'warning' : 'neutral'}
                    data-testid="route-classification-processing-status"
                  >
                    Classification: {classificationStatus}
                  </StatusBadge>
                ) : null}
                {policyStatus ? (
                  <StatusBadge
                    tone={policyStatus === 'Overridden' ? 'warning' : policyStatus === 'Mixed' ? 'warning' : 'neutral'}
                    data-testid="route-policy-processing-status"
                  >
                    Policy: {policyStatus}
                  </StatusBadge>
                ) : null}
              </span>
            ) : null}
          </div>
          <p className="text-[13px] text-slate-600 dark:text-gdc-muted">
            Configure how data is delivered from the stream to the destination.
          </p>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
            Save state ·{' '}
            {isCreateMode ? 'API-backed (POST /api/v1/routes/)' : 'API-backed (PUT /api/v1/routes/{id})'}
          </p>
        </div>
        <div
          className="inline-flex h-7 items-center rounded-full border border-slate-200/90 bg-slate-50 px-2.5 text-[11px] font-semibold text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
          aria-live="polite"
          data-testid="route-edit-save-status"
        >
          {saveStatusLabel}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card"
          >
            <Play className="h-3.5 w-3.5" />
            Test Delivery
          </button>
          <button
            type="button"
            onClick={requestLeave}
            data-testid="route-edit-cancel"
            className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSaving || (!isCreateMode && !deliveryDirty) || (isCreateMode && !deliveryDirty && backendDestinationId == null)}
            onClick={() => void handleSaveRoute()}
            data-testid="route-edit-save"
            className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? 'Saving…' : isCreateMode ? 'Create Route' : 'Save Route'}
          </button>
        </div>
      </header>
      {hasUnsavedChanges ? (
        <p className="text-[11px] text-amber-800 dark:text-amber-200" data-testid="route-edit-unsaved-hint">
          Unsaved edits are local only. Runtime continues using the last persisted route configuration until Save succeeds.
        </p>
      ) : null}
      {staleConflict ? (
        <div
          className="space-y-2 rounded-md border border-amber-300/80 bg-amber-50/90 p-3 dark:border-amber-700/60 dark:bg-amber-950/40"
          data-testid="route-edit-stale-conflict"
          role="alert"
        >
          <p className="text-[12px] font-medium text-amber-950 dark:text-amber-100">
            This route changed since you started editing. Your unsaved changes are still preserved. Refresh/review the
            latest route before saving again.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card"
              data-testid="route-edit-stale-keep-editing"
              onClick={() => setStaleConflict(false)}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-md border border-amber-400 bg-amber-100 px-3 text-[12px] font-semibold text-amber-950 hover:bg-amber-200 dark:border-amber-600 dark:bg-amber-900/50 dark:text-amber-50"
              data-testid="route-edit-stale-refresh"
              onClick={requestRefreshLatest}
            >
              Refresh latest
            </button>
          </div>
        </div>
      ) : null}
      {saveError && !staleConflict ? (
        <p className="text-[12px] font-medium text-red-700 dark:text-red-300" data-testid="route-edit-save-error">
          {saveError}
        </p>
      ) : null}
      {saveSuccess ? <p className="text-[12px] font-medium text-emerald-700 dark:text-emerald-300">{saveSuccess}</p> : null}
      {!isCreateMode && backendRouteId != null ? (
        <RouteDetailHealthPanel routeId={backendRouteId} streamId={backendStreamId} />
      ) : null}

      <section className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200/70 bg-white/80 p-3 text-[12px] dark:border-gdc-border dark:bg-gdc-card md:grid-cols-4 xl:grid-cols-8">
        {[
          ['Connector', connectorLabel],
          ['Stream', streamLabel],
          ['Destination', destinationLabel],
          ['Route Status', enabled ? 'Enabled' : 'Disabled'],
          ['Delivery Mode', deliveryMode],
          ['Processing', transformStatus || protectionStatus || classificationStatus || policyStatus ? `Transform: ${transformStatus ?? '—'} · Protection: ${protectionStatus ?? '—'} · Classification: ${classificationStatus ?? '—'} · Policy: ${policyStatus ?? '—'}` : '—'],
          ['Last Updated', '—'],
          ['Updated By', '—'],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
            <p className="truncate pt-0.5 font-medium text-slate-800 dark:text-slate-100">{value}</p>
          </div>
        ))}
      </section>

      <div className="flex flex-wrap gap-2 border-b border-slate-200/80 pb-2 dark:border-gdc-border">
        {(
          [
            ['delivery', 'Delivery'],
            ['transform', 'Transform'],
            ['protection', 'Protection'],
            ['classification', 'Classification'],
            ['policy', 'Policy'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setActiveTab(key)
              setVisitedTabs((prev) => {
                if (prev.has(key)) return prev
                const next = new Set(prev)
                next.add(key)
                return next
              })
            }}
            data-testid={`route-edit-tab-${key}`}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-semibold',
              activeTab === key
                ? 'bg-violet-600 text-white'
                : 'border border-slate-200/90 bg-white text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 space-y-3 xl:col-span-9">
          {!isCreateMode && backendRouteId != null && visitedTabs.has('transform') ? (
            <div className={cn(activeTab !== 'transform' && 'hidden')} aria-hidden={activeTab !== 'transform'}>
              <RouteEditTransformPanel
                routeId={backendRouteId}
                streamId={backendStreamId}
                initialEffective={transformEffective}
                onEffectiveChange={setTransformEffective}
                onDirtyChange={setTransformDirty}
              />
            </div>
          ) : null}

          {!isCreateMode && backendRouteId != null && backendStreamId != null && visitedTabs.has('protection') ? (
            <div className={cn(activeTab !== 'protection' && 'hidden')} aria-hidden={activeTab !== 'protection'}>
              <ProtectionPanel
                streamId={backendStreamId}
                routeId={backendRouteId}
                canOperate
                initialEffective={protectionEffective}
                onEffectiveChange={setProtectionEffective}
              />
            </div>
          ) : null}

          {!isCreateMode && backendRouteId != null && backendStreamId != null && visitedTabs.has('classification') ? (
            <div className={cn(activeTab !== 'classification' && 'hidden')} aria-hidden={activeTab !== 'classification'}>
              <ClassificationPanel
                streamId={backendStreamId}
                routeId={backendRouteId}
                canOperate
                initialEffective={classificationEffective}
                onEffectiveChange={setClassificationEffective}
              />
            </div>
          ) : null}

          {!isCreateMode && backendRouteId != null && backendStreamId != null && visitedTabs.has('policy') ? (
            <div className={cn(activeTab !== 'policy' && 'hidden')} aria-hidden={activeTab !== 'policy'}>
              <PolicyPanel
                streamId={backendStreamId}
                routeId={backendRouteId}
                canOperate
                initialEffective={policyEffective}
                onEffectiveChange={setPolicyEffective}
              />
            </div>
          ) : null}

          {activeTab === 'delivery' ? (
            <>
          <PanelChrome title="Route Information">
            <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-3">
              <Field label="Route Name *">
                <input value={routeName} onChange={(e) => setRouteName(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Description" >
                <input value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputCls, 'md:col-span-2')} />
              </Field>
              <Field label="Status" help={{ content: HELP_COPY.routeEnabled.content }}>
                <button
                  type="button"
                  onClick={() => setEnabled((v) => !v)}
                  className={cn(
                    'inline-flex h-8 w-fit items-center rounded-full px-3 text-[11px] font-semibold',
                    enabled ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : 'bg-slate-500/15 text-slate-700 dark:text-gdc-mutedStrong',
                  )}
                >
                  {enabled ? 'Enabled' : 'Disabled'}
                </button>
              </Field>
              <Field
                label="Destination *"
                help={{ content: HELP_COPY.routeVsDestination.content }}
              >
                <select
                  value={backendDestinationId ?? ''}
                  onChange={(e) => setBackendDestinationId(Number(e.target.value))}
                  className={inputCls}
                >
                  {destinationOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </PanelChrome>

          <PanelChrome title="Delivery Settings">
            <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-4">
              <Field label="Delivery Mode *" hint="Guarantee at-least-once delivery">
                <select value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as 'Reliable' | 'Best Effort')} className={inputCls}>
                  <option value="Reliable">Reliable</option>
                  <option value="Best Effort">Best Effort</option>
                </select>
              </Field>
              <Field
                label="Failure Policy *"
                hint="Retry on failure with backoff"
                help={{
                  content: HELP_COPY.routeFailurePolicy.content,
                  example: HELP_COPY.routeFailurePolicy.example,
                }}
              >
                <select value={failurePolicy} onChange={(e) => setFailurePolicy(e.target.value as typeof failurePolicy)} className={inputCls}>
                  <option>Retry</option>
                  <option>Log and Continue</option>
                  <option>Pause Stream</option>
                  <option>Disable Route</option>
                </select>
              </Field>
              <Field label="Max Retry" hint="0 = unlimited">
                <input type="number" value={maxRetry} onChange={(e) => setMaxRetry(Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Retry Backoff *" hint="Backoff strategy for retries">
                <select value={retryBackoff} onChange={(e) => setRetryBackoff(e.target.value as 'Exponential' | 'Linear')} className={inputCls}>
                  <option value="Exponential">Exponential</option>
                  <option value="Linear">Linear</option>
                </select>
              </Field>
              <Field label="Initial Backoff" hint="seconds">
                <input type="number" value={initialBackoffSec} onChange={(e) => setInitialBackoffSec(Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Max Backoff *" hint="seconds">
                <input type="number" value={maxBackoffSec} onChange={(e) => setMaxBackoffSec(Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Max Delivery Time" hint="0 = no limit (seconds)">
                <input type="number" value={maxDeliveryTimeSec} onChange={(e) => setMaxDeliveryTimeSec(Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Batch Size" hint="Events per delivery batch">
                <input type="number" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} className={inputCls} />
              </Field>
            </div>
          </PanelChrome>

          <PanelChrome title="Rate Limiting">
            <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-3">
              <Field label="Rate Limit" help={{ content: HELP_COPY.destinationRateLimit.content }}>
                <button
                  type="button"
                  onClick={() => setRateLimitEnabled((v) => !v)}
                  className={cn(
                    'inline-flex h-8 w-fit items-center rounded-full px-3 text-[11px] font-semibold',
                    rateLimitEnabled ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : 'bg-slate-500/15 text-slate-700 dark:text-gdc-mutedStrong',
                  )}
                >
                  {rateLimitEnabled ? 'Enable rate limiting' : 'Disabled'}
                </button>
              </Field>
              <Field label="Per Second" hint="events / sec">
                <input type="number" value={perSecond} onChange={(e) => setPerSecond(Number(e.target.value))} className={inputCls} />
              </Field>
              <Field label="Burst Size" hint="Maximum events in short burst">
                <input type="number" value={burstSize} onChange={(e) => setBurstSize(Number(e.target.value))} className={inputCls} />
              </Field>
            </div>
          </PanelChrome>
            </>
          ) : null}

          {activeTab === 'transform' && isCreateMode ? (
            <PanelChrome title="Transform">
              <p className="p-3 text-[12px] text-slate-600 dark:text-gdc-muted">
                Create the route first, then configure per-route transform overrides.
              </p>
            </PanelChrome>
          ) : null}

          {activeTab === 'protection' && isCreateMode ? (
            <PanelChrome title="Protection">
              <p className="p-3 text-[12px] text-slate-600 dark:text-gdc-muted">
                Create the route first, then configure per-route protection overrides.
              </p>
            </PanelChrome>
          ) : null}

          {activeTab === 'classification' && isCreateMode ? (
            <PanelChrome title="Classification">
              <p className="p-3 text-[12px] text-slate-600 dark:text-gdc-muted">
                Create the route first, then configure per-route classification overrides.
              </p>
            </PanelChrome>
          ) : null}

          {activeTab === 'policy' && isCreateMode ? (
            <PanelChrome title="Policy">
              <p className="p-3 text-[12px] text-slate-600 dark:text-gdc-muted">
                Create the route first, then configure per-route policy overrides.
              </p>
            </PanelChrome>
          ) : null}
        </div>

        <div className="col-span-12 space-y-3 xl:col-span-3">
          <PanelChrome title="Route Summary">
            <ul className="space-y-1.5 p-2.5 text-[12px]">
              <li className="flex items-center justify-between"><span className="text-slate-500">Status</span><span className="font-semibold text-emerald-700 dark:text-emerald-400">{enabled ? 'Enabled' : 'Disabled'}</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Delivery Mode</span><span className="font-semibold">{deliveryMode}</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Failure Policy</span><span className="font-semibold">{failurePolicy}</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Retry Backoff</span><span className="font-semibold">{retryBackoff}</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Rate Limit</span><span className="font-semibold">{rateLimitEnabled ? `${perSecond} events/sec (Burst ${burstSize})` : 'Disabled'}</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Batch Size</span><span className="font-semibold">{batchSize} events</span></li>
              <li className="flex items-center justify-between"><span className="text-slate-500">Destination</span><span className="font-semibold">{destinationLabel}</span></li>
            </ul>
          </PanelChrome>

          <PanelChrome title="Route Flow">
            <div className="flex items-center justify-between gap-2 p-2.5">
              <div className="rounded-md border border-slate-200/80 bg-slate-50 px-2 py-1 text-[11px] font-medium dark:border-gdc-border dark:bg-gdc-card">
                {streamLabel}
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
              <div className="rounded-md border border-violet-200 bg-violet-500/[0.08] px-2 py-1 text-[11px] font-medium text-violet-800 dark:border-violet-500/40 dark:text-violet-300">
                {destinationLabel}
              </div>
            </div>
          </PanelChrome>

          <PanelChrome title="Next Steps">
            <ol className="space-y-1.5 p-2.5 text-[11px] text-slate-600 dark:text-gdc-muted">
              <li>1. Save Route (API-backed when available)</li>
              <li>2. Start Stream</li>
              <li>3. Open Runtime and verify delivery</li>
              <li>4. Monitor route failure/retry signals</li>
            </ol>
            <p className="px-2.5 pb-2 text-[10px] text-slate-500 dark:text-gdc-muted">
              Destination source: {destinationSource === 'api' ? 'API-backed list' : 'No destinations loaded'}
            </p>
          </PanelChrome>

          <PanelChrome title="Need help?">
            <div className="space-y-2 p-2.5 text-[12px]">
              <p className="text-slate-600 dark:text-gdc-muted">Learn more about routes in our documentation.</p>
              <a
                href="https://example.com/docs/routes"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-300"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                View Docs
              </a>
            </div>
          </PanelChrome>
        </div>
      </div>

      <p className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-gdc-muted">
        <ShieldCheck className="h-3 w-3" />
        Delivery settings persist on the route entity; transform overrides use route_mappings and route_enrichments when enabled.
      </p>

      {discardOpen ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setDiscardOpen(false)
          }}
          title="Discard unsaved route changes?"
          targetName={routeName.trim() || (isCreateMode ? 'New Route' : `Route #${backendRouteId}`)}
          risk="medium"
          impactBullets={[
            'Local delivery and transform edits that were not saved will be discarded.',
            'Runtime continues using the last successfully persisted route configuration.',
          ]}
          reversibility="Unsaved edits cannot be recovered after discard."
          primaryLabel="Discard changes"
          onConfirm={() => {
            setDiscardOpen(false)
            if (deliveryBaseline) applyDeliveryForm(deliveryBaseline)
            setTransformDirty(false)
            leaveWithoutSaving()
          }}
          dataTestId="route-edit-discard-dialog"
        />
      ) : null}
      {refreshConfirmOpen ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setRefreshConfirmOpen(false)
          }}
          title="Refresh and discard unsaved route changes?"
          targetName={routeName.trim() || `Route #${backendRouteId}`}
          risk="medium"
          impactBullets={[
            'Your unsaved local edits will be discarded.',
            'The form will reload the latest server route configuration.',
            'Runtime continues using the last successfully persisted route configuration.',
          ]}
          reversibility="Unsaved edits cannot be recovered after refresh."
          primaryLabel="Refresh latest"
          onConfirm={() => {
            setRefreshConfirmOpen(false)
            void reloadLatestFromServer()
          }}
          dataTestId="route-edit-refresh-discard-dialog"
        />
      ) : null}
    </div>
  )
}
