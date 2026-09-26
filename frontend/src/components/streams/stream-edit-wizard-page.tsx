import { ChevronLeft, ChevronRight, Loader2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { NAV_PATH, streamRuntimePath, type StreamWizardStepKey } from '../../config/nav-paths'
import { deleteStream, fetchStreamById } from '../../api/gdcStreams'
import {
  fetchStreamRuntimeStatsHealth,
  startRuntimeStream,
  stopRuntimeStream,
} from '../../api/gdcRuntime'
import { mapBackendStreamStatus } from '../../api/streamRows'
import type { StreamRuntimeStatus } from '../../api/streamRows'
import { StatusBadge } from '../shell/status-badge'
import { StreamOperationalBadges } from './stream-operational-badges'
import { isStreamSchedulerActive, StreamRunControlSwitch } from './stream-run-control-switch'
import {
  buildOperationalStreamBadges,
  operationalRunControlTooltipSupplement,
} from '../../utils/streamOperationalBadges'
import { formatRunOnceErrorLines } from '../../utils/formatRunOnceSummary'
import { wizardStepsWithSourcePresentation } from '../../utils/sourceTypePresentation'
import { StepConnect } from './wizard/step-connect'
import { StepSample } from './wizard/step-sample'
import { StepDelivery } from './wizard/step-delivery'
import { StreamEditDeliveryPanel } from './stream-edit-delivery-panel'
import { StepRouteProcessing } from './wizard/step-route-processing'
import { StepDeploy } from './wizard/step-deploy'
import { WizardStepper } from './wizard/wizard-stepper'
import { wizardStagePurpose } from './wizard/wizard-stage-guidance'
import { hydrateWizardStateFromStream, refreshWizardDestinationsFromStream } from './wizard/wizard-stream-hydrate'
import { reconcileWizardAfterPartialPersist } from './wizard/wizard-partial-save-reconcile'
import { proveStreamRunOnce } from './wizard/prove-stream-run-once'
import { deliveryProofLines, type PriorDeliveryProof } from './wizard/deploy-delivery-proof'
import { editRuntimeVerificationBlocked, shouldScheduleEditAutosave } from './wizard/wizard-edit-runtime-gate'
import { persistWizardStreamEdits } from './wizard/wizard-stream-persist'
import {
  WIZARD_STEPS,
  computeStepCompletion,
  legacySubstepToWizardStep,
  type WizardLegacySubstepKey,
  type WizardConfigState,
  type WizardState,
  type WizardStepKey,
} from './wizard/wizard-state'
import {
  applySampleConfirmationToWizardState,
  mergeStreamSampleConfirmations,
} from './wizard/wizard-step-gates'
import { wizardExtractEvents } from './wizard/wizard-json-extract'
import { buildApiTestExtractedEventsPatch, buildApiTestSuccessPatch } from '../../utils/wizardUnionSchema'
import {
  buildAnalysisForSample,
  getOperationalSample,
  type OperationalSampleId,
} from './wizard/wizard-operational-samples'
import {
  checkpointPathFromClick,
  eventRootPathFromClick,
  normalizeEventArrayPath,
  normalizeEventRootPath,
} from '../../utils/eventExtractionPaths'
import { normalizeCheckpointRelativePath } from '../../utils/recordSelectionPaths'
import { StreamDeleteConfirmDialog } from './stream-delete-confirm-dialog'
import { useSessionCapabilities } from '../../lib/rbac'

const EDIT_NEXT_STEP_LABEL: Partial<Record<WizardStepKey, string>> = {
  connect: 'Sample & Record Selection',
  sample: 'Destinations',
  destinations: 'Route Processing',
  route_processing: 'Deploy',
}

function wizardStepIndexForKey(steps: ReadonlyArray<{ key: WizardStepKey }>, key: WizardStepKey): number {
  const idx = steps.findIndex((step) => step.key === key)
  return idx >= 0 ? idx : 0
}

const WIZARD_STEP_QUERY_KEYS = new Set<StreamWizardStepKey>([
  'connect',
  'sample',
  'destinations',
  'route_processing',
  'deploy',
])

function isReadonlyFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  )
}

/** Block field edits without disabling buttons used for section navigation and preview. */
function blockReadonlyFormEdit(event: {
  target: EventTarget | null
  preventDefault: () => void
  stopPropagation: () => void
}) {
  if (!isReadonlyFormControl(event.target)) return
  event.preventDefault()
  event.stopPropagation()
}

const readonlyFieldClass =
  '[&_input]:pointer-events-none [&_select]:pointer-events-none [&_textarea]:pointer-events-none'

function ReadonlyInspectionFrame({
  readOnly,
  children,
}: {
  readOnly: boolean
  children: ReactNode
}) {
  if (!readOnly) return <>{children}</>
  return (
    <div
      className={readonlyFieldClass}
      onChangeCapture={blockReadonlyFormEdit}
      onInputCapture={blockReadonlyFormEdit}
      onBeforeInputCapture={blockReadonlyFormEdit}
    >
      {children}
    </div>
  )
}

function parseWizardStepQuery(raw: string | null): StreamWizardStepKey | null {
  if (!raw || !WIZARD_STEP_QUERY_KEYS.has(raw as StreamWizardStepKey)) return null
  return raw as StreamWizardStepKey
}

export function StreamEditWizardPage() {
  const { streamId = '' } = useParams<{ streamId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const backendStreamId = /^\d+$/.test(streamId) ? Number(streamId) : null
  const caps = useSessionCapabilities()
  const canMutateWorkspace = caps.workspace_mutations === true
  const canRuntimeControl = caps.runtime_stream_control === true
  const canMutateWorkspaceRef = useRef(canMutateWorkspace)
  canMutateWorkspaceRef.current = canMutateWorkspace

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [state, setState] = useState<WizardState | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [runtimeStatus, setRuntimeStatus] = useState<StreamRuntimeStatus>('UNKNOWN')
  const [controlBusy, setControlBusy] = useState(false)
  const [runOnceBusy, setRunOnceBusy] = useState(false)
  const [controlMessage, setControlMessage] = useState<string | null>(null)
  const [runOnceNotice, setRunOnceNotice] = useState<{ variant: 'success' | 'error'; lines: string[] } | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [operationalSampleId, setOperationalSampleId] = useState<OperationalSampleId | null>(null)
  const [dataProtectionDrawerOpen, setDataProtectionDrawerOpen] = useState(false)
  const [streamDeleteOpen, setStreamDeleteOpen] = useState(false)
  const [streamDeleteConfirm, setStreamDeleteConfirm] = useState('')
  const [streamDeleteBusy, setStreamDeleteBusy] = useState(false)
  const [streamDeleteError, setStreamDeleteError] = useState<string | null>(null)
  const confirmedSavedSnapshotRef = useRef<string>('')
  const failedAttemptSnapshotRef = useRef<string | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const latestStateRef = useRef<WizardState | null>(null)
  const isSavingRef = useRef(false)
  const saveErrorRef = useRef<string | null>(null)
  const priorDeliveryProofRef = useRef<PriorDeliveryProof | null>(null)
  isSavingRef.current = isSaving
  saveErrorRef.current = saveError
  const appliedQueryStepRef = useRef<StreamWizardStepKey | null>(null)

  useEffect(() => {
    latestStateRef.current = state
  }, [state])

  useEffect(() => {
    if (backendStreamId == null) {
      setLoadError('A numeric stream id is required for API-backed editing.')
      setLoading(false)
      return
    }
    let cancelled = false
    priorDeliveryProofRef.current = null
    setLoading(true)
    setLoadError(null)
    void (async () => {
      const hydrated = await hydrateWizardStateFromStream(backendStreamId)
      if (cancelled) return
      if (!hydrated) {
        setLoadError('Could not load stream configuration.')
        setState(null)
        setLoading(false)
        return
      }
      const next = applySampleConfirmationToWizardState(hydrated)
      setState(next)
      confirmedSavedSnapshotRef.current = JSON.stringify(next)
      failedAttemptSnapshotRef.current = null
      priorDeliveryProofRef.current = null
      setLoading(false)
      const found = await fetchStreamById(backendStreamId)
      if (!cancelled && found?.status) {
        setRuntimeStatus(mapBackendStreamStatus(found.status))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [backendStreamId])

  const wizardSteps = useMemo(() => {
    if (!state) return WIZARD_STEPS
    const steps = wizardStepsWithSourcePresentation(WIZARD_STEPS, state.connector.sourceType)
    return steps.map((step) =>
      step.key === 'deploy'
        ? { ...step, title: 'Review', subtitle: 'Save · runtime · monitoring' }
        : step,
    )
  }, [state])

  const currentStepKey = wizardSteps[stepIndex]?.key ?? 'connect'
  const completion = useMemo(() => (state ? computeStepCompletion(state) : null), [state])

  const requestedStepKey = parseWizardStepQuery(searchParams.get('step'))

  useEffect(() => {
    if (!requestedStepKey) return
    if (appliedQueryStepRef.current === requestedStepKey) return
    const idx = wizardStepIndexForKey(wizardSteps, requestedStepKey)
    if (idx < 0) return
    appliedQueryStepRef.current = requestedStepKey
    setStepIndex((prev) => (prev === idx ? prev : idx))
    const nextParams = new URLSearchParams(searchParams)
    if (nextParams.has('step')) {
      nextParams.delete('step')
      setSearchParams(nextParams, { replace: true })
    }
  }, [requestedStepKey, searchParams, setSearchParams, wizardSteps])

  const refreshRuntimeSnapshot = useCallback(async () => {
    if (backendStreamId == null) return
    const bundle = await fetchStreamRuntimeStatsHealth(backendStreamId, 80, '1h')
    const status = bundle?.stats?.stream_status ?? bundle?.health?.stream_status
    if (status) setRuntimeStatus(mapBackendStreamStatus(status))
  }, [backendStreamId])

  useEffect(() => {
    void refreshRuntimeSnapshot()
  }, [refreshRuntimeSnapshot])

  const updateConnector = useCallback((patch: Partial<WizardState['connector']>) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, connector: { ...prev.connector, ...patch } } : prev))
  }, [])
  const updateStreamConfig = useCallback((patch: Partial<WizardState['stream']>) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, stream: { ...prev.stream, ...patch } } : prev))
  }, [])
  // Preview/sample results stay local. Autosave and leave-flush still require workspace_mutations.
  const updateApiTest = useCallback((next: WizardState['apiTest']) => {
    setState((prev) =>
      prev
        ? {
            ...prev,
            apiTest: next,
            stream: mergeStreamSampleConfirmations(prev.stream, next),
          }
        : prev,
    )
  }, [])
  const patchStream = useCallback((patch: Partial<WizardState['stream']>) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, stream: { ...prev.stream, ...patch } } : prev))
  }, [])

  const setEventArrayPath = useCallback((path: string) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => {
      if (!prev) return prev
      const raw = prev.apiTest.parsedJson ?? prev.apiTest.rawResponse
      const rawObj = raw !== null && typeof raw === 'object' ? raw : null
      const normalized = normalizeEventArrayPath(path) || (Array.isArray(rawObj) ? '$' : '')
      const useWhole = normalized.length === 0
      const nextStream = {
        ...prev.stream,
        eventArrayPath: normalized,
        useWholeResponseAsEvent: useWhole,
        eventRootPath: '',
        eventRootConfirmedForApiTestAt: null,
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      }
      const extracted = wizardExtractEvents(rawObj, normalized, '')
      const mergedStream = mergeStreamSampleConfirmations(nextStream, prev.apiTest)
      return {
        ...prev,
        stream: mergedStream,
        apiTest: {
          ...prev.apiTest,
          ...buildApiTestExtractedEventsPatch(extracted, prev.apiTest.analysis, {
            stream: mergedStream,
            apiTest: prev.apiTest,
          }),
        },
      }
    })
  }, [])

  const setEventRootPath = useCallback((path: string) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => {
      if (!prev) return prev
      const arrayPath = prev.stream.eventArrayPath.trim() || '$'
      const normalizedInput = normalizeEventRootPath(path)
      const normalized =
        normalizedInput && normalizedInput.startsWith('$')
          ? eventRootPathFromClick(normalizedInput, arrayPath) || normalizedInput
          : normalizedInput
      const nextStream = mergeStreamSampleConfirmations(
        {
          ...prev.stream,
          eventRootPath: normalized,
          customExtractionValidatedForApiTestAt: null,
          customExtractionValidationOk: false,
        },
        prev.apiTest,
      )
      return { ...prev, stream: nextStream }
    })
  }, [])

  const setCheckpoint = useCallback(
    (patch: Partial<Pick<WizardConfigState, 'checkpointFieldType' | 'checkpointSourcePath'>>) => {
      if (!canMutateWorkspaceRef.current) return
      setState((prev) => {
        if (!prev) return prev
        let checkpointSourcePath = patch.checkpointSourcePath ?? prev.stream.checkpointSourcePath
        if (patch.checkpointSourcePath !== undefined && checkpointSourcePath.trim()) {
          const rawPath = checkpointSourcePath.trim()
          const arrayPath = prev.stream.eventArrayPath.trim() || '$'
          if (rawPath.startsWith('$') && /\[\d+\]/.test(rawPath)) {
            checkpointSourcePath = checkpointPathFromClick(rawPath, arrayPath, 0)
          } else {
            checkpointSourcePath = normalizeCheckpointRelativePath(rawPath)
          }
        }
        return {
          ...prev,
          stream: mergeStreamSampleConfirmations(prev.stream, prev.apiTest, {
            ...patch,
            ...(patch.checkpointSourcePath !== undefined ? { checkpointSourcePath } : {}),
            customExtractionValidatedForApiTestAt: null,
            customExtractionValidationOk: false,
          }),
        }
      })
    },
    [],
  )

  const loadOperationalSample = useCallback((id: OperationalSampleId) => {
    if (!canMutateWorkspaceRef.current) return
    const sample = getOperationalSample(id)
    const startedAt = Date.now()
    const analysis = buildAnalysisForSample(sample, '', '')
    const samplePatch = buildApiTestSuccessPatch(sample.payload, analysis)
    setOperationalSampleId(id)
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        stream: {
          ...prev.stream,
          eventArrayPath: '',
          eventRootPath: '',
          useWholeResponseAsEvent: false,
          checkpointSourcePath: '',
          checkpointFieldType: '',
          recordSelectionMode: 'basic',
          customExtractionValidatedForApiTestAt: null,
          customExtractionValidationOk: false,
          recordPathConfirmedForApiTestAt: null,
          eventRootConfirmedForApiTestAt: null,
          checkpointConfirmedForApiTestAt: null,
        },
        apiTest: {
          ...prev.apiTest,
          status: 'success',
          ok: true,
          requestUrl: `local://operational-sample/${id}`,
          method: prev.stream.httpMethod,
          statusCode: 200,
          responseHeaders: { 'x-operational-sample': id },
          rawBody: JSON.stringify(sample.payload),
          parsedJson: sample.payload,
          rawResponse: sample.payload,
          ...samplePatch,
          analysis,
          startedAt,
          finishedAt: startedAt + 1,
          errorCode: null,
          errorType: null,
          errorMessage: null,
          targetStatusCode: null,
          targetResponseBody: null,
          hint: null,
          apiBacked: false,
          steps: [],
          responseSample: null,
          effectiveHeadersMasked: null,
          actualRequestSent: null,
          s3ConnectivityPassed: false,
          remoteProbe: null,
        },
      }
    })
  }, [])

  const setMapping = useCallback((mapping: WizardState['mapping']) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, mapping } : prev))
  }, [])
  const setMappingMode = useCallback((mappingMode: WizardState['mappingMode']) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, mappingMode } : prev))
  }, [])
  const setFullEventJsonata = useCallback((fullEventJsonataExpression: string) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, fullEventJsonataExpression } : prev))
  }, [])
  const setFullEventRegexConfigJson = useCallback((fullEventRegexConfigJson: string) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, fullEventRegexConfigJson } : prev))
  }, [])
  const setEnrichment = useCallback((enrichment: WizardState['enrichment']) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, enrichment } : prev))
  }, [])
  const setUnmappedFieldsPolicy = useCallback((unmappedFieldsPolicy: WizardState['unmappedFieldsPolicy']) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, unmappedFieldsPolicy } : prev))
  }, [])
  const setDataProtection = useCallback((dataProtection: WizardState['dataProtection']) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => (prev ? { ...prev, dataProtection } : prev))
  }, [])
  const setDestinations = useCallback((patch: Partial<WizardState['destinations']>) => {
    if (!canMutateWorkspaceRef.current) return
    setState((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        destinations: {
          ...prev.destinations,
          ...patch,
          routeDrafts: patch.routeDrafts ?? prev.destinations.routeDrafts,
          destinationKindsById: patch.destinationKindsById
            ? { ...prev.destinations.destinationKindsById, ...patch.destinationKindsById }
            : prev.destinations.destinationKindsById,
          messagePrefixEnabledByDestinationId: patch.messagePrefixEnabledByDestinationId
            ? {
                ...prev.destinations.messagePrefixEnabledByDestinationId,
                ...patch.messagePrefixEnabledByDestinationId,
              }
            : prev.destinations.messagePrefixEnabledByDestinationId,
        },
      }
    })
  }, [])

  const navigateToWizardStep = useCallback(
    (key: WizardStepKey) => {
      const idx = wizardStepIndexForKey(wizardSteps, key)
      if (idx >= 0) setStepIndex(idx)
    },
    [wizardSteps],
  )

  const navigateToLegacySubstep = useCallback(
    (legacyKey: WizardLegacySubstepKey) => {
      if (legacyKey === 'data_protection') setDataProtectionDrawerOpen(true)
      navigateToWizardStep(legacySubstepToWizardStep(legacyKey))
    },
    [navigateToWizardStep],
  )

  const refreshDestinationsFromApi = useCallback(async () => {
    if (backendStreamId == null) return
    const refreshed = await refreshWizardDestinationsFromStream(backendStreamId)
    if (!refreshed) return
    setState((prev) => {
      if (!prev) return prev
      const localByKey = new Map(prev.destinations.routeDrafts.map((d) => [d.key, d]))
      const mergedDrafts = refreshed.destinations.routeDrafts.map((server) => {
        const local = localByKey.get(server.key)
        if (!local) return server
        // Keep local processing/protection/classification overrides; sync delivery fields from API.
        return {
          ...local,
          destinationId: server.destinationId,
          enabled: server.enabled,
          failurePolicy: server.failurePolicy,
        }
      })
      return {
        ...prev,
        destinations: {
          ...refreshed.destinations,
          routeDrafts: mergedDrafts,
        },
        outcome: {
          ...prev.outcome,
          routeId: refreshed.routeIds[0] ?? prev.outcome?.routeId ?? null,
          routeIds: refreshed.routeIds,
        },
      }
    })
  }, [backendStreamId])

  const handleSave = useCallback(async (opts?: { manual?: boolean }) => {
    const manual = opts?.manual === true
    const stateToSave = latestStateRef.current
    if (!canMutateWorkspace || !stateToSave || backendStreamId == null || isSaving) return
    if (manual && saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setIsSaving(true)
    isSavingRef.current = true
    setSaveError(null)
    setSaveSuccess(null)
    const result = await persistWizardStreamEdits(backendStreamId, stateToSave)
    const clearPersistFailure = (current: WizardState, routePatch?: { routeId: number | null; routeIds: number[] }) => {
      if (!current.outcome) return current
      return {
        ...current,
        outcome: {
          ...current.outcome,
          ...(routePatch ?? {}),
          errors: [],
          reconciliationNote: null,
        },
      }
    }
    const confirmSaved = (next: WizardState) => {
      confirmedSavedSnapshotRef.current = JSON.stringify(next)
      failedAttemptSnapshotRef.current = null
      latestStateRef.current = next
    }
    if (result.ok) {
      if (manual) {
        const rehydrated = await hydrateWizardStateFromStream(backendStreamId)
        const next = rehydrated ? clearPersistFailure(rehydrated) : clearPersistFailure(stateToSave)
        confirmSaved(next)
        setState(next)
      } else {
        const refreshedDestinations = await refreshWizardDestinationsFromStream(backendStreamId)
        setState((prev) => {
          if (!prev) return prev
          const next = clearPersistFailure(
            refreshedDestinations
              ? { ...prev, destinations: refreshedDestinations.destinations }
              : prev,
            refreshedDestinations
              ? {
                  routeId: refreshedDestinations.routeIds[0] ?? prev.outcome?.routeId ?? null,
                  routeIds: refreshedDestinations.routeIds,
                }
              : undefined,
          )
          confirmSaved(next)
          return next
        })
      }
      await refreshRuntimeSnapshot()
      setSaveSuccess(manual ? 'Saved now and applied.' : 'Changes saved.')
      window.setTimeout(() => setSaveSuccess(null), 3000)
    } else {
      let message = result.errors.join(' · ') || 'Save failed.'
      try {
        const reconciled = await reconcileWizardAfterPartialPersist(backendStreamId, stateToSave, result.errors)
        if (reconciled.note) message = `${message} ${reconciled.note}`
        setState((prev) => {
          if (!prev) return prev
          const next: WizardState = {
            ...prev,
            ...(reconciled.appliedDestinations ? { destinations: reconciled.state.destinations } : {}),
            ...(reconciled.appliedStream ? { stream: reconciled.state.stream } : {}),
            ...(reconciled.appliedMapping
              ? {
                  mapping: reconciled.state.mapping,
                  mappingMode: reconciled.state.mappingMode,
                  fullEventJsonataExpression: reconciled.state.fullEventJsonataExpression,
                  fullEventRegexConfigJson: reconciled.state.fullEventRegexConfigJson,
                  unmappedFieldsPolicy: reconciled.state.unmappedFieldsPolicy,
                  enrichment: reconciled.state.enrichment,
                }
              : {}),
          }
          if (prev.outcome) {
            next.outcome = {
              ...prev.outcome,
              ...(reconciled.appliedDestinations && reconciled.state.outcome
                ? {
                    routeId: reconciled.state.outcome.routeId,
                    routeIds: reconciled.state.outcome.routeIds,
                  }
                : {}),
              errors: result.errors,
              reconciliationNote: reconciled.note,
            }
          }
          failedAttemptSnapshotRef.current = JSON.stringify(next)
          latestStateRef.current = next
          return next
        })
      } catch {
        message = `${message} Could not read back persisted state after the save error. This draft is not confirmed as saved.`
        failedAttemptSnapshotRef.current = JSON.stringify(stateToSave)
      }
      setSaveError(message)
    }
    isSavingRef.current = false
    setIsSaving(false)
  }, [backendStreamId, canMutateWorkspace, isSaving, refreshRuntimeSnapshot])

  useEffect(() => {
    if (!canMutateWorkspace || !state || backendStreamId == null || isSaving) return
    const snapshot = JSON.stringify(state)
    if (!shouldScheduleEditAutosave(snapshot, confirmedSavedSnapshotRef.current, failedAttemptSnapshotRef.current)) return
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void handleSave()
    }, 1200)
    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [backendStreamId, canMutateWorkspace, handleSave, isSaving, state])

  // Flush pending autosave on leave so debounce window cannot silently drop route edits.
  useEffect(() => {
    return () => {
      if (!canMutateWorkspace) return
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (!latest || backendStreamId == null) return
      const snapshot = JSON.stringify(latest)
      if (!shouldScheduleEditAutosave(snapshot, confirmedSavedSnapshotRef.current, failedAttemptSnapshotRef.current)) return
      void persistWizardStreamEdits(backendStreamId, latest)
    }
  }, [backendStreamId, canMutateWorkspace])

  const runtimeVerificationBlockedNow = useCallback(() => {
    const latest = latestStateRef.current
    if (!latest) return true
    return editRuntimeVerificationBlocked({
      isSaving: isSavingRef.current,
      saveFailed: saveErrorRef.current != null,
      persistErrorCount: latest.outcome?.errors.length ?? 0,
      draftSnapshot: JSON.stringify(latest),
      confirmedSavedSnapshot: confirmedSavedSnapshotRef.current,
    })
  }, [])

  const runStreamControl = useCallback(
    async (action: 'start' | 'stop') => {
      if (!canRuntimeControl || backendStreamId == null || controlBusy || runOnceBusy) return
      if (action === 'start' && runtimeVerificationBlockedNow()) return
      setControlBusy(true)
      setControlMessage(null)
      const res =
        action === 'start' ? await startRuntimeStream(backendStreamId) : await stopRuntimeStream(backendStreamId)
      if (res) {
        setControlMessage(res.message)
        await refreshRuntimeSnapshot()
        const found = await fetchStreamById(backendStreamId)
        if (found?.status) setRuntimeStatus(mapBackendStreamStatus(found.status))
      } else {
        setControlMessage('Runtime API unavailable · control action not applied.')
      }
      setControlBusy(false)
    },
    [backendStreamId, canRuntimeControl, controlBusy, refreshRuntimeSnapshot, runOnceBusy, runtimeVerificationBlockedNow],
  )

  const executeRunOnce = useCallback(async () => {
    if (!canRuntimeControl || backendStreamId == null || runOnceBusy || controlBusy || runtimeVerificationBlockedNow()) return
    setRunOnceBusy(true)
    setRunOnceNotice(null)
    try {
      const proof = await proveStreamRunOnce(backendStreamId, priorDeliveryProofRef.current)
      priorDeliveryProofRef.current = {
        streamId: backendStreamId,
        runtimeRunId: proof.runtimeRunId,
        status: proof.status,
      }
      const proven = proof.status === 'proven' || proof.status === 'recovered'
      setRunOnceNotice({
        variant: proven ? 'success' : 'error',
        lines: deliveryProofLines(proof),
      })
      await refreshRuntimeSnapshot()
    } catch (error) {
      setRunOnceNotice({ variant: 'error', lines: formatRunOnceErrorLines(error) })
    } finally {
      setRunOnceBusy(false)
    }
  }, [backendStreamId, canRuntimeControl, controlBusy, refreshRuntimeSnapshot, runOnceBusy, runtimeVerificationBlockedNow])

  const handleStart = useCallback(async () => {
    if (!canRuntimeControl || backendStreamId == null || isStarting || runtimeVerificationBlockedNow()) return
    setIsStarting(true)
    await startRuntimeStream(backendStreamId)
    await refreshRuntimeSnapshot()
    setIsStarting(false)
  }, [backendStreamId, canRuntimeControl, isStarting, refreshRuntimeSnapshot, runtimeVerificationBlockedNow])

  const executeStreamDelete = useCallback(async () => {
    if (!canMutateWorkspace || backendStreamId == null) return
    const streamName = state?.stream.name ?? ''
    if (streamDeleteConfirm.trim() !== streamName.trim()) return
    setStreamDeleteBusy(true)
    setStreamDeleteError(null)
    try {
      await deleteStream(backendStreamId)
      navigate(NAV_PATH.streams)
    } catch (e) {
      setStreamDeleteError(e instanceof Error ? e.message : 'Delete failed.')
    } finally {
      setStreamDeleteBusy(false)
    }
  }, [backendStreamId, canMutateWorkspace, navigate, state?.stream.name, streamDeleteConfirm])

  const headerStatus = runtimeStatus
  const headerStatusTone =
    headerStatus === 'ERROR'
      ? 'error'
      : headerStatus === 'DEGRADED'
        ? 'warning'
        : headerStatus === 'RUNNING'
          ? 'success'
          : 'neutral'

  const operationalBadges = useMemo(
    () => buildOperationalStreamBadges(state?.stream.name ?? streamId, state?.connector.sourceType),
    [state?.connector.sourceType, state?.stream.name, streamId],
  )
  const runControlTooltipExtra = operationalRunControlTooltipSupplement(state?.stream.name ?? streamId)

  const runtimeVerificationBlocked = !state
    ? true
    : editRuntimeVerificationBlocked({
        isSaving,
        saveFailed: saveError != null,
        persistErrorCount: state.outcome?.errors.length ?? 0,
        draftSnapshot: JSON.stringify(state),
        confirmedSavedSnapshot: confirmedSavedSnapshotRef.current,
      })

  const saveStateLabel = !canMutateWorkspace
    ? 'Read-only'
    : isSaving
      ? 'Auto-saving…'
      : saveError
        ? 'Auto-save failed'
        : saveSuccess
          ? 'Changes saved'
          : 'Auto-save enabled'

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-violet-600" aria-hidden />
      </div>
    )
  }

  if (loadError || !state || !completion) {
    return (
      <div className="rounded-lg border border-red-200/80 bg-red-500/[0.06] p-4 text-[13px] text-red-800 dark:border-red-500/35 dark:bg-red-500/10 dark:text-red-200">
        {loadError ?? 'Unable to open stream editor.'}
      </div>
    )
  }

  const nextLabel = EDIT_NEXT_STEP_LABEL[currentStepKey]
  const stagePurpose = wizardStagePurpose(currentStepKey)

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 pb-8" data-testid="edit-stream-wizard">
      {!canMutateWorkspace || !canRuntimeControl ? (
        <p
          role="status"
          data-testid="stream-edit-readonly-banner"
          className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100/95"
        >
          {!canMutateWorkspace
            ? 'Read-only session: stream configuration, route changes, save, and delete are unavailable. Navigation and inspection remain available.'
            : null}
          {!canRuntimeControl ? ' Start, stop, and Run Now are unavailable.' : null}
        </p>
      ) : null}
      {/* Toolbar only — App Shell owns the page title */}
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={headerStatusTone} className="font-bold uppercase tracking-wide">
              {headerStatus}
            </StatusBadge>
            <StreamOperationalBadges badges={operationalBadges} />
            <span
              className="inline-flex h-7 items-center rounded-md border border-slate-200/90 bg-slate-50 px-2.5 text-xs font-semibold text-slate-700 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
              aria-live="polite"
            >
              {saveStateLabel}
            </span>
          </div>
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted" data-testid="wizard-stage-purpose">
            {stagePurpose}
          </p>
          <p className="text-xs text-slate-500 dark:text-gdc-muted">
            {canMutateWorkspace
              ? `Editing ${state.stream.name} · changes auto-save to the platform`
              : `Viewing ${state.stream.name} · read-only`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canRuntimeControl ? (
            <StreamRunControlSwitch
              status={runtimeStatus}
              busy={controlBusy}
              disabled={runOnceBusy || (!isStreamSchedulerActive(runtimeStatus) && runtimeVerificationBlocked)}
              tooltipExtra={runControlTooltipExtra ?? undefined}
              onToggle={(nextActive) => void runStreamControl(nextActive ? 'start' : 'stop')}
            />
          ) : null}
          {canRuntimeControl ? (
            <button
              type="button"
              disabled={controlBusy || runOnceBusy || runtimeVerificationBlocked}
              onClick={() => void executeRunOnce()}
              className="inline-flex h-9 items-center rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {runOnceBusy ? 'Running…' : 'Run Now'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => navigate(streamRuntimePath(streamId))}
            className="inline-flex h-9 items-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
          >
            Back to monitoring
          </button>
          {canMutateWorkspace && backendStreamId != null ? (
            <button
              type="button"
              disabled={runtimeStatus === 'RUNNING'}
              onClick={() => {
                setStreamDeleteOpen(true)
                setStreamDeleteConfirm('')
                setStreamDeleteError(null)
              }}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-300/90 bg-white px-3 text-sm font-semibold text-red-800 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/40 dark:bg-gdc-section dark:text-red-200 dark:hover:bg-red-950/40"
              title={runtimeStatus === 'RUNNING' ? 'Stop the stream before deleting' : 'Delete this stream'}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </button>
          ) : null}
        </div>
      </div>

      {saveError ? (
        <p className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-3 text-[12px] font-medium text-red-700 dark:border-red-500/40 dark:text-red-300">
          {saveError}
        </p>
      ) : null}
      {controlMessage ? <p className="text-[11px] font-medium text-slate-600 dark:text-gdc-mutedStrong">{controlMessage}</p> : null}
      {runOnceNotice ? (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-[11px]',
            runOnceNotice.variant === 'success'
              ? 'border-emerald-300/70 bg-emerald-500/[0.06] text-emerald-950 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100'
              : 'border-red-300/70 bg-red-500/[0.06] text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100',
          )}
        >
          {runOnceNotice.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}

      <WizardStepper
        wizardSteps={wizardSteps}
        stepIndex={stepIndex}
        setStepIndex={setStepIndex}
        completion={completion}
        state={state}
        reachability={{ editMode: true }}
      />

      <div>
        <ReadonlyInspectionFrame readOnly={!canMutateWorkspace}>
        {currentStepKey === 'connect' ? (
          <StepConnect
            state={state}
            connectorReadonly
            onConnectorChange={updateConnector}
            onStreamChange={updateStreamConfig}
          />
        ) : null}
        {currentStepKey === 'sample' ? (
          <StepSample
            state={state}
            onApiTestChange={updateApiTest}
            onStreamPatch={patchStream}
            onSetEventArrayPath={setEventArrayPath}
            onSetEventRootPath={setEventRootPath}
            onSetCheckpoint={setCheckpoint}
            onLoadOperationalSample={loadOperationalSample}
            activeOperationalSampleId={operationalSampleId}
          />
        ) : null}
        {currentStepKey === 'route_processing' ? (
          <StepRouteProcessing
            state={state}
            onChangeMapping={setMapping}
            onChangeMappingMode={setMappingMode}
            onChangeFullEventJsonata={setFullEventJsonata}
            onChangeFullEventRegexConfigJson={setFullEventRegexConfigJson}
            onChangeEnrichment={setEnrichment}
            onChangeUnmappedFieldsPolicy={setUnmappedFieldsPolicy}
            onChangeDataProtection={setDataProtection}
            onChangeDestinations={setDestinations}
            dataProtectionDrawerOpen={dataProtectionDrawerOpen}
            onDataProtectionDrawerOpenChange={setDataProtectionDrawerOpen}
          />
        ) : null}
        </ReadonlyInspectionFrame>
        {currentStepKey === 'destinations' ? (
          <div className="space-y-6" data-testid="edit-stream-destinations">
            <ReadonlyInspectionFrame readOnly={!canMutateWorkspace}>
              <StepDelivery state={state} onChange={setDestinations} />
            </ReadonlyInspectionFrame>
            {backendStreamId != null ? (
              <StreamEditDeliveryPanel
                streamId={backendStreamId}
                readOnly={!canMutateWorkspace}
                onSaved={() => void refreshDestinationsFromApi()}
              />
            ) : null}
          </div>
        ) : null}
        {currentStepKey === 'deploy' ? (
          <StepDeploy
            state={state}
            isStarting={isStarting}
            canRuntimeControl={canRuntimeControl}
            onStart={() => void handleStart()}
            onNavigateToLegacySubstep={navigateToLegacySubstep}
            runtimeVerificationBlocked={runtimeVerificationBlocked}
          />
        ) : null}
      </div>

      <nav
        className="sticky bottom-0 z-20 mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 bg-white/95 py-3 backdrop-blur-sm dark:border-gdc-border dark:bg-gdc-section"
        aria-label="Edit stream navigation"
        data-testid="wizard-action-bar"
      >
        <button
          type="button"
          onClick={() => setStepIndex((idx) => Math.max(0, idx - 1))}
          disabled={stepIndex === 0}
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Back
        </button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canMutateWorkspace ? (
            <button
              type="button"
              onClick={() => void handleSave({ manual: true })}
              disabled={isSaving}
              className="inline-flex h-9 items-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
              data-testid="wizard-save-now"
            >
              {isSaving ? 'Saving…' : 'Save now'}
            </button>
          ) : null}
          {stepIndex < wizardSteps.length - 1 ? (
            <button
              type="button"
              onClick={() => setStepIndex((idx) => Math.min(wizardSteps.length - 1, idx + 1))}
              className="inline-flex h-9 items-center gap-1 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              data-testid="wizard-next"
            >
              {nextLabel ?? 'Next'}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : (
            <Link
              to={streamRuntimePath(streamId)}
              className="inline-flex h-9 items-center gap-1 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              data-testid="wizard-open-monitoring"
            >
              Open monitoring
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </nav>
      {streamDeleteOpen && state ? (
        <StreamDeleteConfirmDialog
          streamName={state.stream.name}
          confirmValue={streamDeleteConfirm}
          onConfirmValueChange={setStreamDeleteConfirm}
          busy={streamDeleteBusy}
          error={streamDeleteError}
          running={runtimeStatus === 'RUNNING'}
          onOpenChange={(open) => {
            if (!open && !streamDeleteBusy) {
              setStreamDeleteOpen(false)
              setStreamDeleteConfirm('')
              setStreamDeleteError(null)
            }
          }}
          onConfirm={() => void executeStreamDelete()}
        />
      ) : null}
    </div>
  )
}
