import { ChevronLeft, ChevronRight, CheckCircle2, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { NAV_PATH, runtimeOverviewPath } from '../../config/nav-paths'
import { WIZARD_LABEL } from '../../lib/operator-vocabulary'
import { useSessionCapabilities } from '../../lib/rbac'
import { createStream } from '../../api/gdcStreams'
import { materializeConnectorTemplates } from '../../api/gdcConnectorTemplates'
import { saveStreamMappingUiConfigStrict } from '../../api/gdcRuntimeUi'
import { createRoute } from '../../api/gdcRoutes'
import { startRuntimeStream } from '../../api/gdcRuntime'
import {
  wizardCreateIsConfigurationIncomplete,
  wizardCreateIsStartEligible,
} from './wizard/wizard-create-fail-closed'
import { MULTI_STREAM_PARTIAL_UNCONFIRMED_NOTE, multiStreamPartialSaveIsUnconfirmed, reconcileWizardAfterPartialPersist } from './wizard/wizard-partial-save-reconcile'
import {
  buildStreamsToConfigureFromMaterialization,
  wizardPersistErrorLabel,
} from './wizard/wizard-multi-template-configure'
import { StepConnect } from './wizard/step-connect'
import { NewConnectorWizardPage } from '../connectors/new-connector-wizard-page'
import { clearWizardCatalogSnapshot } from './wizard/wizard-catalog-cache'
import { StepSample } from './wizard/step-sample'
import { StepDelivery } from './wizard/step-delivery'
import { StepRouteProcessing } from './wizard/step-route-processing'
import { StepDeploy } from './wizard/step-deploy'
import { WizardStepper } from './wizard/wizard-stepper'
import { wizardStagePurpose } from './wizard/wizard-stage-guidance'
import { computeDeployReadiness } from './wizard/wizard-deploy-readiness'
import {
  WIZARD_STEPS,
  buildSourceAuthPayload,
  buildInitialState,
  buildSourceConfig,
  buildStreamCreatePayload,
  buildRouteCreatePayloads,
  computeStepCompletion,
  enrichmentDictFromRows,
  buildWizardFieldMappingsPayload,
  wizardFieldMappingsReady,
  legacySubstepToWizardStep,
  type WizardConfigState,
  type WizardCreateOutcome,
  type WizardLegacySubstepKey,
  type WizardState,
  type WizardStepKey,
} from './wizard/wizard-state'
import {
  loadWizardDraft,
  saveWizardDraft,
  clearWizardDraft,
  wizardStepIndexForKey,
  type WizardDraftEnvelopeV2,
} from './wizard/wizard-draft-migration'
import {
  applySampleConfirmationToWizardState,
  canAdvanceFromWizardStep,
  mergeStreamSampleConfirmations,
  wizardSampleStepBlockReason,
  wizardRouteProcessingStepBlockReason,
  wizardStepReachable,
} from './wizard/wizard-step-gates'
import { wizardStepsWithSourcePresentation } from '../../utils/sourceTypePresentation'
import { wizardExtractEvents } from './wizard/wizard-json-extract'
import { buildApiTestExtractedEventsPatch, buildApiTestSuccessPatch } from '../../utils/wizardUnionSchema'
import {
  buildAnalysisForSample,
  getOperationalSample,
  type OperationalSampleId,
} from './wizard/wizard-operational-samples'
import { applyHttpImportToWizardState, type HttpImportWizardLocationState } from '../../utils/httpImportDraft'
import { IntentTemplatePicker } from './wizard/intent-template-picker'
import { WizardExitConfirmation } from './wizard/wizard-exit-confirmation'
import { applyWizardIntentTemplate, type WizardIntentTemplateId } from './wizard/intent-templates'
import { persistWizardDataProtectionIntents } from './wizard/wizard-data-protection-persist'
import { persistWizardRouteTransformOverrides, verifyWizardRouteTransformEffective } from './wizard/wizard-stream-persist'
import { persistWizardStreamGovernance } from './wizard/wizard-governance-persist'
import {
  persistWizardRouteGovernanceBundles,
  verifyWizardRouteGovernanceEffective,
} from './wizard/wizard-route-governance-bundle'
import {
  mergeSchemaDriftPolicyIntoConfigJson,
  persistWizardSchemaDriftPolicy,
} from './wizard/wizard-schema-drift-policy-persist'
import { persistWizardUnionSchema } from './wizard/wizard-union-schema-persist'
import {
  checkpointPathFromClick,
  eventRootPathFromClick,
  normalizeEventArrayPath,
  normalizeEventRootPath,
} from '../../utils/eventExtractionPaths'
import { normalizeCheckpointRelativePath } from '../../utils/recordSelectionPaths'

const NEXT_STEP_LABEL: Partial<Record<WizardStepKey, string>> = {
  connect: 'Sample & Record Selection',
  sample: 'Destinations',
  destinations: 'Route Processing',
  route_processing: 'Deploy',
}

export function NewStreamWizardPage() {
  const navigate = useNavigate()
  const capabilities = useSessionCapabilities()
  const canCreateStream = capabilities.workspace_mutations === true
  const location = useLocation()
  const importHydratedRef = useRef(false)
  const draftHydratedRef = useRef(false)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const connectorDialogRef = useRef<HTMLElement>(null)
  const connectorCloseButtonRef = useRef<HTMLButtonElement>(null)
  const connectorReturnFocusRef = useRef<HTMLElement | null>(null)
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [intentSelected, setIntentSelected] = useState(false)
  const [state, setState] = useState<WizardState>(() => buildInitialState())
  const [pendingDraft, setPendingDraft] = useState<WizardDraftEnvelopeV2 | null>(null)
  const [draftBannerVisible, setDraftBannerVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const [operationalSampleId, setOperationalSampleId] = useState<OperationalSampleId | null>(null)
  const [dataProtectionDrawerOpen, setDataProtectionDrawerOpen] = useState(false)
  const [connectorCreateOpen, setConnectorCreateOpen] = useState(false)
  const [connectorCreateBusy, setConnectorCreateBusy] = useState(false)
  const [connectorCatalogEpoch, setConnectorCatalogEpoch] = useState(0)

  const handleIntentSelect = useCallback((id: WizardIntentTemplateId) => {
    clearWizardDraft()
    setState(applyWizardIntentTemplate(id))
    setStepIndex(0)
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setOperationalSampleId(null)
    setIntentSelected(true)
  }, [])

  const wizardSteps = useMemo(
    () => wizardStepsWithSourcePresentation(WIZARD_STEPS, state.connector.sourceType),
    [state.connector.sourceType],
  )

  const currentStepKey = wizardSteps[stepIndex]?.key ?? 'connect'
  const completion = useMemo(() => computeStepCompletion(state), [state])

  useEffect(() => {
    // Do not show persisted configuration from another user's browser draft
    // to a role without the server-provided workspace mutation capability.
    if (!canCreateStream || draftHydratedRef.current) return
    draftHydratedRef.current = true
    const draft = loadWizardDraft()
    if (!draft) return
    setPendingDraft(draft)
    setDraftBannerVisible(true)
  }, [canCreateStream])

  const handleResumeDraft = useCallback(() => {
    if (!pendingDraft) return
    setState(applySampleConfirmationToWizardState(pendingDraft.state))
    setStepIndex(wizardStepIndexForKey(wizardSteps, pendingDraft.stepKey))
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setIntentSelected(true)
    setDraftNotice('Draft restored from local storage.')
    window.setTimeout(() => setDraftNotice(null), 4000)
  }, [pendingDraft, wizardSteps])

  const handleStartFresh = useCallback(() => {
    clearWizardDraft()
    setState(buildInitialState())
    setStepIndex(0)
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setOperationalSampleId(null)
    setIntentSelected(true)
  }, [])

  useEffect(() => {
    if (!canCreateStream || importHydratedRef.current) return
    const routeState = (location.state ?? {}) as HttpImportWizardLocationState
    const connectorId = routeState.connectorId
    if (connectorId == null) return
    importHydratedRef.current = true
    setState((prev) => applyHttpImportToWizardState(prev, { connectorId, streamDraft: routeState.streamDraft }))
    setDraftNotice('Stream fields prefilled from import. Review polling and mapping before creating.')
    setIntentSelected(true)
    setStepIndex(wizardStepIndexForKey(wizardSteps, 'connect'))
  }, [canCreateStream, location.state, wizardSteps])

  const navigateToWizardStep = useCallback(
    (key: WizardStepKey) => {
      const idx = wizardSteps.findIndex((s) => s.key === key)
      if (idx >= 0) setStepIndex(idx)
    },
    [wizardSteps],
  )

  const navigateToLegacySubstep = useCallback(
    (legacyKey: WizardLegacySubstepKey) => {
      if (legacyKey === 'data_protection') {
        setDataProtectionDrawerOpen(true)
      }
      navigateToWizardStep(legacySubstepToWizardStep(legacyKey))
    },
    [navigateToWizardStep],
  )

  const openConnectorCreate = () => {
    setConnectorCreateBusy(false)
    connectorReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConnectorCreateOpen(true)
  }

  useEffect(() => {
    if (!connectorCreateOpen) return
    connectorCloseButtonRef.current?.focus()
    return () => {
      // Source catalog refresh can replace the original button after a successful create.
      queueMicrotask(() => {
        const original = connectorReturnFocusRef.current
        if (original?.isConnected) original.focus()
        else document.querySelector<HTMLElement>('[data-testid="wizard-add-connector"]')?.focus()
        connectorReturnFocusRef.current = null
      })
    }
  }, [connectorCreateOpen])

  const handleConnectorDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const dialog = connectorDialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((element) =>
      !element.closest('[hidden], [aria-hidden="true"]') &&
      getComputedStyle(element).display !== 'none' &&
      getComputedStyle(element).visibility !== 'hidden',
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) {
      event.preventDefault()
      dialog.focus()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const closeConnectorCreate = () => {
    if (!connectorCreateBusy) setConnectorCreateOpen(false)
  }

  const handleConnectorCreated = useCallback((id: number) => {
    setConnectorCreateBusy(false)
    // Keep the entire parent draft in React memory, including sample confirmation.
    // Connector credentials stay in the create form and are never copied into storage.
    clearWizardCatalogSnapshot()
    setState((current) => ({
      ...current,
      connector: {
        ...current.connector,
        connectorId: id,
        sourceId: null,
        registryModuleId: null,
        selectedTemplateIds: [],
      },
    }))
    setConnectorCatalogEpoch((n) => n + 1)
    setConnectorCreateOpen(false)
  }, [])

  const updateConnector = useCallback((patch: Partial<WizardState['connector']>) => {
    setState((s) => ({ ...s, connector: { ...s.connector, ...patch } }))
  }, [])
  const updateStream = useCallback((patch: Partial<WizardState['stream']>) => {
    setState((s) => ({ ...s, stream: { ...s.stream, ...patch } }))
  }, [])
  const updateApiTest = useCallback(
    (next: WizardState['apiTest']) => {
      setState((s) => {
        const hadConfirmedSelection =
          s.stream.recordPathConfirmedForApiTestAt != null &&
          s.stream.checkpointConfirmedForApiTestAt != null
        let stream = mergeStreamSampleConfirmations(s.stream, next)

        if (hadConfirmedSelection && next.status === 'success' && next.ok && next.finishedAt != null) {
          if (s.stream.eventRootConfirmedForApiTestAt != null) {
            stream = { ...stream, eventRootConfirmedForApiTestAt: next.finishedAt }
          }

          const raw = next.parsedJson ?? next.rawResponse
          if (raw !== null && typeof raw === 'object') {
            const arrayPath = stream.useWholeResponseAsEvent ? '' : stream.eventArrayPath.trim()
            const extracted = wizardExtractEvents(raw, arrayPath, stream.eventRootPath)
            const apiTest = {
              ...next,
              ...buildApiTestExtractedEventsPatch(extracted, next.analysis, { stream, apiTest: next }),
            }
            return { ...s, apiTest, stream }
          }
        }

        return { ...s, apiTest: next, stream }
      })
    },
    [],
  )
  const patchStream = useCallback((patch: Partial<WizardConfigState>) => {
    setState((s) => ({ ...s, stream: { ...s.stream, ...patch } }))
  }, [])
  const setEventArrayPath = useCallback((path: string) => {
    setState((s) => {
      const raw = s.apiTest.parsedJson ?? s.apiTest.rawResponse
      const rawObj = raw !== null && typeof raw === 'object' ? raw : null
      const normalized = normalizeEventArrayPath(path) || (Array.isArray(rawObj) ? '$' : '')
      const useWhole = normalized.length === 0
      const nextStream = {
        ...s.stream,
        eventArrayPath: normalized,
        useWholeResponseAsEvent: useWhole,
        eventRootPath: '',
        eventRootConfirmedForApiTestAt: null,
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      }
      const extracted = wizardExtractEvents(rawObj, normalized, '')
      const mergedStream = mergeStreamSampleConfirmations(nextStream, s.apiTest)
      const gateState = { stream: mergedStream, apiTest: s.apiTest }
      return {
        ...s,
        stream: mergedStream,
        apiTest: {
          ...s.apiTest,
          ...buildApiTestExtractedEventsPatch(extracted, s.apiTest.analysis, gateState),
        },
      }
    })
  }, [])
  const setEventRootPath = useCallback((path: string) => {
    setState((s) => {
      const raw = s.apiTest.parsedJson ?? s.apiTest.rawResponse
      const rawObj = raw !== null && typeof raw === 'object' ? raw : null
      const arrayPath = s.stream.eventArrayPath.trim() || '$'
      const normalizedInputRoot = normalizeEventRootPath(path)
      const normalizedRoot =
        normalizedInputRoot && normalizedInputRoot.startsWith('$')
          ? eventRootPathFromClick(normalizedInputRoot, arrayPath) || normalizedInputRoot
          : normalizedInputRoot
      let eventArrayPath = s.stream.eventArrayPath
      let useWholeResponseAsEvent = s.stream.useWholeResponseAsEvent
      if (!useWholeResponseAsEvent && !eventArrayPath.trim()) {
        if (Array.isArray(rawObj)) {
          eventArrayPath = '$'
        } else if (rawObj != null) {
          useWholeResponseAsEvent = true
        }
      }
      const extractArrayPath = useWholeResponseAsEvent
        ? ''
        : eventArrayPath.trim() || (Array.isArray(rawObj) ? '$' : '')
      const extracted = wizardExtractEvents(rawObj, extractArrayPath, normalizedRoot)
      const eventRootConfirmedForApiTestAt =
        s.apiTest.status === 'success' && s.apiTest.ok && s.apiTest.finishedAt != null
          ? s.apiTest.finishedAt
          : null
      const nextStream = {
        ...s.stream,
        eventRootPath: normalizedRoot,
        eventArrayPath: useWholeResponseAsEvent ? '' : eventArrayPath.trim() || (Array.isArray(rawObj) ? '$' : ''),
        useWholeResponseAsEvent,
        eventRootConfirmedForApiTestAt,
        customExtractionValidatedForApiTestAt: null,
        customExtractionValidationOk: false,
      }
      const mergedStream = mergeStreamSampleConfirmations(nextStream, s.apiTest)
      const gateState = { stream: mergedStream, apiTest: s.apiTest }
      return {
        ...s,
        stream: mergedStream,
        apiTest: {
          ...s.apiTest,
          ...buildApiTestExtractedEventsPatch(extracted, s.apiTest.analysis, gateState),
        },
      }
    })
  }, [])
  const setCheckpoint = useCallback((patch: Partial<Pick<WizardConfigState, 'checkpointFieldType' | 'checkpointSourcePath' | 'checkpointMode'>>) => {
    setState((s) => {
      let checkpointSourcePath = patch.checkpointSourcePath ?? s.stream.checkpointSourcePath
      if (patch.checkpointSourcePath !== undefined && checkpointSourcePath.trim()) {
        const rawPath = checkpointSourcePath.trim()
        const arrayPath = s.stream.eventArrayPath.trim() || '$'
        if (rawPath.startsWith('$') && /\[\d+\]/.test(rawPath)) {
          checkpointSourcePath = checkpointPathFromClick(rawPath, arrayPath, 0)
        } else {
          checkpointSourcePath = normalizeCheckpointRelativePath(rawPath)
        }
      }
      return {
        ...s,
        stream: mergeStreamSampleConfirmations(s.stream, s.apiTest, {
          ...patch,
          ...(patch.checkpointSourcePath !== undefined ? { checkpointSourcePath } : {}),
          customExtractionValidatedForApiTestAt: null,
          customExtractionValidationOk: false,
        }),
      }
    })
  }, [])

  const loadOperationalSample = useCallback((id: OperationalSampleId) => {
    const sample = getOperationalSample(id)
    const startedAt = Date.now()
    const analysis = buildAnalysisForSample(sample, '', '')
    const samplePatch = buildApiTestSuccessPatch(sample.payload, analysis)
    setOperationalSampleId(id)
    setState((s) => ({
      ...s,
      stream: {
        ...s.stream,
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
        ...s.apiTest,
        status: 'success',
        ok: true,
        requestUrl: `local://operational-sample/${id}`,
        method: s.stream.httpMethod,
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
    }))
  }, [])
  const setMapping = useCallback((rows: WizardState['mapping']) => {
    setState((s) => ({ ...s, mapping: rows }))
  }, [])
  const setMappingMode = useCallback((mappingMode: WizardState['mappingMode']) => {
    setState((s) => ({ ...s, mappingMode }))
  }, [])
  const setFullEventJsonata = useCallback((fullEventJsonataExpression: string) => {
    setState((s) => ({ ...s, fullEventJsonataExpression }))
  }, [])
  const setFullEventRegexConfigJson = useCallback((fullEventRegexConfigJson: string) => {
    setState((s) => ({ ...s, fullEventRegexConfigJson }))
  }, [])
  const setTransformRules = useCallback((transformRules: WizardState['transformRules']) => {
    setState((s) => ({ ...s, transformRules }))
  }, [])
  const setEnrichment = useCallback((enrichment: WizardState['enrichment']) => {
    setState((s) => ({ ...s, enrichment }))
  }, [])
  const enableEnrichment = useCallback(() => {
    setState((s) => ({ ...s, enrichmentEnabled: true }))
  }, [])
  const setUnmappedFieldsPolicy = useCallback((unmappedFieldsPolicy: WizardState['unmappedFieldsPolicy']) => {
    setState((s) => ({ ...s, unmappedFieldsPolicy }))
  }, [])
  const setDestinations = useCallback((patch: Partial<WizardState['destinations']>) => {
    setState((s) => ({ ...s, destinations: { ...s.destinations, ...patch } }))
  }, [])
  const setDataProtection = useCallback((patch: Partial<WizardState['dataProtection']>) => {
    setState((s) => ({ ...s, dataProtection: { ...s.dataProtection, ...patch } }))
  }, [])

  const handleCreate = useCallback(async (options?: { startAfter?: boolean }) => {
    if (busy) return
    setBusy(true)
    setCreationError(null)
    const startAfter = options?.startAfter === true

    const workingState: WizardState = {
      ...state,
      connector: { ...state.connector },
      stream: { ...state.stream },
    }
    const outcome: WizardCreateOutcome = {
      streamId: null,
      routeId: null,
      routeIds: [],
      mappingSaved: false,
      enrichmentSaved: false,
      dataProtectionSaved: false,
      governanceSaved: false,
      schemaDriftPolicySaved: false,
      schemaDriftPolicyWarnings: [],
      dataProtectionEnforcementIncomplete: false,
      dataProtectionWarnings: [],
      errors: [],
      apiBacked: true,
      createdAt: null,
      materializedStreamIds: [],
    }

    const useTemplateMaterialization =
      workingState.connector.registryModuleId != null &&
      workingState.connector.selectedTemplateIds.length > 0

    /** Stream ids that receive downstream wizard configuration (protection, routes, governance, …). */
    const streamsToConfigure: Array<{ streamId: number; configJson?: Record<string, unknown> }> = []

    try {
      if (useTemplateMaterialization) {
        if (workingState.connector.connectorId == null) {
          throw new Error('Select a saved connector before materializing stream templates.')
        }
        const materialized = await materializeConnectorTemplates({
          connector_id: workingState.connector.connectorId,
          module_id: workingState.connector.registryModuleId!,
          templates: workingState.connector.selectedTemplateIds,
        })
        const createdStreams = materialized.created_streams
        if (createdStreams.length === 0) {
          throw new Error('Materialization returned no streams.')
        }
        outcome.materializedStreamIds = createdStreams.map((row) => row.stream_id)
        outcome.streamId = createdStreams[0]?.stream_id ?? null
        outcome.mappingSaved = true
        outcome.enrichmentSaved = true
        outcome.apiBacked = true
        streamsToConfigure.push(...buildStreamsToConfigureFromMaterialization(createdStreams))
      } else {
        if (workingState.connector.connectorId == null || workingState.connector.sourceId == null) {
          throw new Error('Select a saved connector and its linked source before creating a stream.')
        }
        void buildSourceConfig(workingState)
        void buildSourceAuthPayload(workingState)
        const payload = buildStreamCreatePayload(workingState)
        if (payload == null) {
          throw new Error('connector/source rows are required before stream creation')
        }
        const created = await createStream(payload)
        outcome.streamId = created.id
        outcome.apiBacked = true
        outcome.createdAt = created.created_at ?? null
        const createdConfigJson =
          created.config_json && typeof created.config_json === 'object' && !Array.isArray(created.config_json)
            ? { ...(created.config_json as Record<string, unknown>) }
            : { ...payload.config_json }

        const fieldMappings = buildWizardFieldMappingsPayload(workingState)
        const enrichmentDict = enrichmentDictFromRows(workingState.enrichment, {
          advancedPassthrough: workingState.enrichmentPassthrough,
        })
        const hasMapping = wizardFieldMappingsReady(workingState)
        const hasEnrichment = Object.keys(enrichmentDict).length > 0

        if (hasMapping || hasEnrichment) {
          try {
            await saveStreamMappingUiConfigStrict(created.id, {
              mapping: hasMapping
                ? {
                    field_mappings: fieldMappings,
                    raw_payload_mode: workingState.mappingRawPayloadMode ?? null,
                    event_array_path:
                      workingState.stream.useWholeResponseAsEvent || !workingState.stream.eventArrayPath.trim()
                        ? null
                        : workingState.stream.eventArrayPath.trim().startsWith('$')
                          ? workingState.stream.eventArrayPath.trim()
                          : `$.${workingState.stream.eventArrayPath.trim()}`,
                    event_root_path: workingState.stream.eventRootPath.trim()
                      ? workingState.stream.eventRootPath.trim().startsWith('$')
                        ? workingState.stream.eventRootPath.trim()
                        : `$.${workingState.stream.eventRootPath.trim()}`
                      : null,
                  }
                : null,
              enrichment: hasEnrichment
                ? {
                    enabled: workingState.enrichmentEnabled ?? true,
                    enrichment: enrichmentDict,
                    override_policy: workingState.enrichmentOverridePolicy ?? 'KEEP_EXISTING',
                  }
                : null,
            })
            outcome.mappingSaved = hasMapping
            outcome.enrichmentSaved = hasEnrichment
          } catch (err) {
            outcome.errors.push(
              `mapping-ui/save failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        streamsToConfigure.push({ streamId: created.id, configJson: createdConfigJson })
      }

      const multiStream = streamsToConfigure.length > 1
      const label = (streamId: number, message: string) =>
        wizardPersistErrorLabel(streamId, message, { multiStream })

      for (const target of streamsToConfigure) {
        let streamConfigJson = target.configJson

        if (workingState.dataProtection.intents.length > 0) {
          try {
            const protectionResult = await persistWizardDataProtectionIntents(target.streamId, workingState)
            outcome.dataProtectionSaved = outcome.dataProtectionSaved || protectionResult.saved
            outcome.dataProtectionEnforcementIncomplete =
              outcome.dataProtectionEnforcementIncomplete || protectionResult.enforcementIncomplete
            outcome.dataProtectionWarnings.push(...protectionResult.warnings)
            if (protectionResult.errors.length > 0) {
              outcome.errors.push(
                ...protectionResult.errors.map((err) => label(target.streamId, `data-protection: ${err}`)),
              )
            }
          } catch (err) {
            outcome.errors.push(
              label(
                target.streamId,
                `data-protection persist failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          }
        }

        try {
          const driftPolicyResult = await persistWizardSchemaDriftPolicy(
            target.streamId,
            workingState.dataProtection,
            { existingConfigJson: streamConfigJson },
          )
          outcome.schemaDriftPolicySaved = outcome.schemaDriftPolicySaved || driftPolicyResult.saved
          if (driftPolicyResult.saved && streamConfigJson) {
            streamConfigJson = mergeSchemaDriftPolicyIntoConfigJson(
              streamConfigJson,
              workingState.dataProtection,
            )
          }
          if (driftPolicyResult.errors.length > 0) {
            outcome.errors.push(
              ...driftPolicyResult.errors.map((err) => label(target.streamId, err)),
            )
          }
        } catch (err) {
          outcome.errors.push(
            label(
              target.streamId,
              `schema-drift-policy persist failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        }

        if (workingState.apiTest.unionSchema) {
          try {
            const unionSchemaResult = await persistWizardUnionSchema(
              target.streamId,
              workingState.apiTest.unionSchema,
              { existingConfigJson: streamConfigJson },
            )
            if (unionSchemaResult.errors.length > 0) {
              outcome.errors.push(
                ...unionSchemaResult.errors.map((err) => label(target.streamId, err)),
              )
            }
          } catch (err) {
            outcome.errors.push(
              label(
                target.streamId,
                `union-schema persist failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            )
          }
        }

        const createdRouteIdsByDraftKey: Record<string, number> = {}
        if (
          workingState.destinations.destinationApiBacked &&
          workingState.destinations.routeDrafts.length > 0
        ) {
          const drafts = workingState.destinations.routeDrafts
          const payloads = buildRouteCreatePayloads(target.streamId, workingState.destinations)
          for (let i = 0; i < drafts.length; i++) {
            const draft = drafts[i]
            const routePayload = payloads[i]
            if (!draft || !routePayload) continue
            try {
              const route = await createRoute(routePayload)
              createdRouteIdsByDraftKey[draft.key] = route.id
              outcome.routeId = route.id
              outcome.routeIds.push(route.id)
            } catch (err) {
              outcome.errors.push(
                label(
                  target.streamId,
                  `POST /routes/ failed (destination_id=${routePayload.destination_id}): ${err instanceof Error ? err.message : String(err)}`,
                ),
              )
            }
          }
        }

        if (Object.keys(createdRouteIdsByDraftKey).length > 0) {
          const xfErrors = await persistWizardRouteTransformOverrides(
            workingState.destinations.routeDrafts,
            createdRouteIdsByDraftKey,
          )
          if (xfErrors.length > 0) {
            outcome.errors.push(...xfErrors.map((err) => label(target.streamId, err)))
          }
          const verifyErrors = await verifyWizardRouteTransformEffective(
            workingState.destinations.routeDrafts,
            createdRouteIdsByDraftKey,
          )
          if (verifyErrors.length > 0) {
            outcome.errors.push(...verifyErrors.map((err) => label(target.streamId, err)))
          }
          const bundleErrors = await persistWizardRouteGovernanceBundles(
            workingState.destinations.routeDrafts,
            createdRouteIdsByDraftKey,
          )
          if (bundleErrors.length > 0) {
            outcome.errors.push(...bundleErrors.map((err) => label(target.streamId, err)))
          }
        }

        try {
          const governanceResult = await persistWizardStreamGovernance(
            target.streamId,
            workingState,
            createdRouteIdsByDraftKey,
          )
          outcome.governanceSaved = outcome.governanceSaved || governanceResult.saved
          if (governanceResult.warnings.length > 0) {
            outcome.dataProtectionWarnings.push(...governanceResult.warnings)
          }
          if (governanceResult.errors.length > 0) {
            outcome.errors.push(
              ...governanceResult.errors.map((err) => label(target.streamId, err)),
            )
          }
        } catch (err) {
          outcome.errors.push(
            label(
              target.streamId,
              `governance persist failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        }

        if (Object.keys(createdRouteIdsByDraftKey).length > 0) {
          const effectiveErrors = await verifyWizardRouteGovernanceEffective(
            workingState.destinations.routeDrafts,
            createdRouteIdsByDraftKey,
            workingState.dataProtection,
          )
          if (effectiveErrors.length > 0) {
            outcome.errors.push(...effectiveErrors.map((err) => label(target.streamId, err)))
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      outcome.errors.push(
        useTemplateMaterialization ? `Template materialization failed: ${message}` : `POST /streams/ failed: ${message}`,
      )
      setCreationError(message)
    } finally {
      let destinationReadBack: WizardState['destinations'] | null = null
      let streamReadBack: WizardState['stream'] | null = null
      let mappingReadBack: Pick<
        WizardState,
        | 'mapping'
        | 'mappingMode'
        | 'fullEventJsonataExpression'
        | 'fullEventRegexConfigJson'
        | 'unmappedFieldsPolicy'
        | 'enrichment'
      > | null = null
      if (multiStreamPartialSaveIsUnconfirmed(streamsToConfigure.length, outcome.errors.length)) {
        outcome.reconciliationNote = MULTI_STREAM_PARTIAL_UNCONFIRMED_NOTE
      } else if (outcome.errors.length > 0 && outcome.streamId != null) {
        try {
          const reconciled = await reconcileWizardAfterPartialPersist(
            outcome.streamId,
            { ...workingState, outcome },
            outcome.errors,
          )
          if (reconciled.note) outcome.reconciliationNote = reconciled.note
          if (reconciled.appliedDestinations) {
            destinationReadBack = reconciled.state.destinations
            const readBackOutcome = reconciled.state.outcome
            if (readBackOutcome) {
              outcome.routeId = readBackOutcome.routeId
              outcome.routeIds = readBackOutcome.routeIds
            }
          }
          if (reconciled.appliedStream) streamReadBack = reconciled.state.stream
          if (reconciled.appliedMapping) {
            mappingReadBack = {
              mapping: reconciled.state.mapping,
              mappingMode: reconciled.state.mappingMode,
              fullEventJsonataExpression: reconciled.state.fullEventJsonataExpression,
              fullEventRegexConfigJson: reconciled.state.fullEventRegexConfigJson,
              unmappedFieldsPolicy: reconciled.state.unmappedFieldsPolicy,
              enrichment: reconciled.state.enrichment,
            }
          }
        } catch {
          outcome.reconciliationNote =
            'Could not read back persisted state after the save error. This draft is not confirmed as saved.'
        }
      }
      setState((current) => ({
        ...current,
        ...(destinationReadBack ? { destinations: destinationReadBack } : {}),
        ...(streamReadBack ? { stream: streamReadBack } : {}),
        ...(mappingReadBack ?? {}),
        outcome,
      }))
      // Fail-closed: keep draft when configuration is incomplete so the operator can repair.
      if (wizardCreateIsStartEligible(outcome)) {
        clearWizardDraft()
      }
      navigateToWizardStep('deploy')
      setBusy(false)
    }

    if (startAfter && wizardCreateIsStartEligible(outcome)) {
      setIsStarting(true)
      try {
        const ids =
          outcome.materializedStreamIds && outcome.materializedStreamIds.length > 0
            ? outcome.materializedStreamIds
            : outcome.streamId != null
              ? [outcome.streamId]
              : []
        const messages: string[] = []
        for (const sid of ids) {
          const res = await startRuntimeStream(sid)
          messages.push(res?.message ?? `stream ${sid}: Runtime API unavailable.`)
        }
        setState((s) => ({
          ...s,
          startMessage: messages.length <= 1 ? (messages[0] ?? null) : messages.join(' · '),
        }))
      } finally {
        setIsStarting(false)
      }
    } else if (startAfter && wizardCreateIsConfigurationIncomplete(outcome)) {
      setState((s) => ({
        ...s,
        startMessage: 'Start blocked: stream configuration is incomplete. Resolve persist errors before starting.',
      }))
    }
  }, [busy, navigateToWizardStep, state])

  const handleStart = useCallback(async () => {
    if (!wizardCreateIsStartEligible(state.outcome) || isStarting) return
    const ids =
      state.outcome?.materializedStreamIds && state.outcome.materializedStreamIds.length > 0
        ? state.outcome.materializedStreamIds
        : state.outcome?.streamId != null
          ? [state.outcome.streamId]
          : []
    if (ids.length === 0) return
    setIsStarting(true)
    const messages: string[] = []
    for (const sid of ids) {
      const res = await startRuntimeStream(sid)
      messages.push(res?.message ?? `stream ${sid}: Runtime API unavailable.`)
    }
    setState((s) => ({
      ...s,
      startMessage: messages.length <= 1 ? (messages[0] ?? null) : messages.join(' · '),
    }))
    setIsStarting(false)
  }, [isStarting, state.outcome])

  const saveDraft = useCallback(() => {
    try {
      saveWizardDraft(state, currentStepKey)
      setDraftNotice('Draft saved locally.')
      window.setTimeout(() => setDraftNotice(null), 4000)
    } catch {
      setDraftNotice('Unable to save draft.')
      window.setTimeout(() => setDraftNotice(null), 4000)
    }
  }, [currentStepKey, state])

  const preserveDraftBeforeDestinationPrerequisite = useCallback(() => {
    try {
      saveWizardDraft(state, 'destinations')
      return true
    } catch {
      setDraftNotice('Unable to save draft. Stay in the wizard and try again.')
      window.setTimeout(() => setDraftNotice(null), 4000)
      return false
    }
  }, [state])

  const handleCreateAnother = useCallback(() => {
    clearWizardDraft()
    setState(buildInitialState())
    setStepIndex(0)
    setCreationError(null)
    setOperationalSampleId(null)
    setPendingDraft(null)
    setDraftBannerVisible(false)
    setIntentSelected(false)
  }, [])

  const isDeployStep = currentStepKey === 'deploy'
  const streamCreated = state.outcome?.streamId != null

  // Never navigate away from an in-progress wizard without an explicit choice.
  // The draft serializer already strips secrets and raw samples; do not autosave.
  const requestCancel = () => {
    if (!intentSelected || streamCreated) {
      navigate(NAV_PATH.streams)
    } else {
      setExitConfirmationOpen(true)
    }
  }
  const keepEditing = () => {
    setExitConfirmationOpen(false)
    queueMicrotask(() => cancelButtonRef.current?.focus())
  }
  const saveAndExit = () => {
    try {
      saveWizardDraft(state, currentStepKey)
      setExitConfirmationOpen(false)
      navigate(NAV_PATH.streams)
    } catch {
      setExitConfirmationOpen(false)
      setDraftNotice('Unable to save the local draft. You are still in the wizard; review browser storage and try again.')
    }
  }
  const discardAndExit = () => {
    try {
      clearWizardDraft()
      setExitConfirmationOpen(false)
      navigate(NAV_PATH.streams)
    } catch {
      setExitConfirmationOpen(false)
      setDraftNotice('Unable to clear the saved draft. You are still in the wizard.')
    }
  }
  useEffect(() => {
    if (!intentSelected || streamCreated) return
    // Reload/close cannot use our in-app dialog; the browser owns this prompt.
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [intentSelected, streamCreated])

  const stepGateOpen = canAdvanceFromWizardStep(currentStepKey, state)
  const canAdvance = (!isDeployStep || !streamCreated) && stepGateOpen
  const nextStepBlockReason = useMemo(() => {
    if (stepGateOpen) return undefined
    if (currentStepKey === 'sample') return wizardSampleStepBlockReason(state)
    if (currentStepKey === 'route_processing') return wizardRouteProcessingStepBlockReason(state)
    return 'Complete required fields on this step before continuing.'
  }, [currentStepKey, state, stepGateOpen])
  const deployReadiness = useMemo(() => computeDeployReadiness(state), [state])

  const goToNextStep = useCallback(() => {
    setStepIndex((idx) => {
      const nextIdx = Math.min(wizardSteps.length - 1, idx + 1)
      const nextKey = wizardSteps[nextIdx]?.key
      if (nextKey && !wizardStepReachable(nextKey, state)) return idx
      return nextIdx
    })
  }, [state, wizardSteps])

  const persistenceLabel = state.connector.apiBacked
    ? 'Changes will be saved to Data Relay Control when you create the stream.'
    : 'Local draft · Connector and Source availability are not yet verified. No runtime changes have been applied.'

  const nextLabel = NEXT_STEP_LABEL[currentStepKey]

  const stagePurpose = wizardStagePurpose(currentStepKey)

  if (!canCreateStream) {
    return (
      <section
        data-testid="wizard-create-readonly"
        role="status"
        className="rounded-xl border border-amber-200 bg-amber-50/60 p-6 dark:border-amber-500/30 dark:bg-amber-500/10"
      >
        <h2 className="text-lg font-semibold text-amber-950 dark:text-amber-100">
          Creating Data Flows requires workspace write access
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-amber-900 dark:text-amber-200">
          Your current session does not allow Connector or Stream creation. Review existing Streams,
          or ask an administrator for workspace write access. The server still enforces every permission.
        </p>
        <Link
          to={NAV_PATH.streams}
          className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700"
        >
          View existing Streams
        </Link>
      </section>
    )
  }

  return (
    <div className="flex h-fit w-full min-w-0 grow-0 flex-col gap-5 pb-8" data-testid="new-stream-wizard">
      {/* Toolbar only — App Shell owns the page title */}
      <div className="flex flex-col gap-3 border-b border-slate-200/80 pb-4 dark:border-gdc-divider sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="max-w-2xl text-sm text-slate-600 dark:text-gdc-muted" data-testid="wizard-stage-purpose">
            {stagePurpose}
          </p>
          <p className="text-xs text-slate-500 dark:text-gdc-muted">{persistenceLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={requestCancel}
            disabled={busy || isStarting}
            className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            Cancel
          </button>
        </div>
      </div>

      {exitConfirmationOpen ? (
        <WizardExitConfirmation
          onKeepEditing={keepEditing}
          onSaveDraftAndLeave={saveAndExit}
          onDiscardAndLeave={discardAndExit}
        />
      ) : null}
      {connectorCreateOpen ? (
        <div role="presentation" className="fixed inset-0 z-[150] overflow-y-auto bg-slate-950/60 p-2 sm:p-6">
          <section ref={connectorDialogRef} onKeyDown={handleConnectorDialogKeyDown} role="dialog" aria-modal="true" aria-label="Add Connector to Data Flow" tabIndex={-1} className="mx-auto max-w-5xl rounded-xl bg-white p-4 shadow-2xl dark:bg-gdc-panel sm:p-6">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-200 pb-3 dark:border-gdc-border">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Add Connector to this Data Flow</p>
              <button ref={connectorCloseButtonRef} type="button" disabled={connectorCreateBusy} onClick={closeConnectorCreate} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 dark:border-gdc-border dark:text-slate-100">
                Return to Data Flow
              </button>
            </div>
            <NewConnectorWizardPage
              onCreated={handleConnectorCreated}
              onCancel={closeConnectorCreate}
              onBusyChange={setConnectorCreateBusy}
            />
          </section>
        </div>
      ) : null}
      {!intentSelected && !draftBannerVisible ? (
        <IntentTemplatePicker onSelect={handleIntentSelect} />
      ) : null}

      {creationError ? (
        <p className="rounded-md border border-red-200/80 bg-red-500/[0.06] p-3 text-[12px] font-medium text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          Unable to create the stream: {creationError}
        </p>
      ) : null}

      {intentSelected || draftBannerVisible ? <WizardStepper
        wizardSteps={wizardSteps}
        stepIndex={stepIndex}
        setStepIndex={setStepIndex}
        completion={completion}
        state={state}
      /> : null}

      {draftBannerVisible && pendingDraft ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2.5 dark:border-amber-500/35 dark:bg-amber-500/10"
          data-testid="wizard-draft-banner"
        >
          <p className="text-[12px] font-medium text-amber-900 dark:text-amber-100">Saved draft found.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleResumeDraft}
              className="inline-flex h-8 items-center rounded-md bg-gdc-primary px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
              data-testid="wizard-draft-resume"
            >
              Resume draft
            </button>
            <button
              type="button"
              onClick={handleStartFresh}
              className="inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
              data-testid="wizard-draft-start-fresh"
            >
              Start fresh
            </button>
          </div>
        </div>
      ) : null}

      {draftNotice ? (
        <p className="rounded-md border border-emerald-200/80 bg-emerald-500/[0.06] px-3 py-2 text-[11px] font-medium text-emerald-800 dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-200">
          {draftNotice}
        </p>
      ) : null}

      {intentSelected || draftBannerVisible ? <div>
        {currentStepKey === 'connect' ? (
          <StepConnect
            key={connectorCatalogEpoch}
            state={state}
            onConnectorChange={updateConnector}
            onStreamChange={updateStream}
            onCreateConnector={openConnectorCreate}
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
        {currentStepKey === 'destinations' ? (
          <StepDelivery
            state={state}
            onChange={setDestinations}
            onOpenDestinationPrerequisite={preserveDraftBeforeDestinationPrerequisite}
            showCreateDraftReturnGuidance
          />
        ) : null}
        {currentStepKey === 'route_processing' ? (
          <StepRouteProcessing
            state={state}
            onChangeMapping={setMapping}
            onChangeMappingMode={setMappingMode}
            onChangeFullEventJsonata={setFullEventJsonata}
            onChangeFullEventRegexConfigJson={setFullEventRegexConfigJson}
            onChangeTransformRules={setTransformRules}
            onChangeEnrichment={setEnrichment}
            onEnableEnrichment={enableEnrichment}
            onChangeUnmappedFieldsPolicy={setUnmappedFieldsPolicy}
            onChangeDataProtection={setDataProtection}
            onChangeDestinations={setDestinations}
            dataProtectionDrawerOpen={dataProtectionDrawerOpen}
            onDataProtectionDrawerOpenChange={setDataProtectionDrawerOpen}
          />
        ) : null}
        {currentStepKey === 'deploy' ? (
          <StepDeploy
            state={state}
            busy={busy}
            isStarting={isStarting}
            onStart={() => void handleStart()}
            onNavigateToLegacySubstep={navigateToLegacySubstep}
          />
        ) : null}
      </div> : null}

      {intentSelected || draftBannerVisible ? <nav
        className="sticky bottom-0 z-20 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-gdc-border dark:bg-gdc-panel"
        aria-label="Wizard navigation"
        data-testid="wizard-action-bar"
      >
        {isDeployStep && streamCreated ? (
          <button
            type="button"
            onClick={() => navigate(NAV_PATH.streams)}
            className="inline-flex h-9 items-center rounded-lg border border-transparent px-1 text-sm font-semibold text-slate-600 hover:text-slate-900 dark:text-gdc-muted dark:hover:text-slate-100"
          >
            Exit Wizard
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStepIndex((idx) => Math.max(0, idx - 1))}
            disabled={stepIndex === 0}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            Back
          </button>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isDeployStep && streamCreated ? (
            <>
              <button
                type="button"
                onClick={() => handleCreateAnother()}
                className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                Create Another Stream
              </button>
              <Link
                to={
                  state.outcome?.streamId != null
                    ? runtimeOverviewPath({ stream_id: state.outcome.streamId })
                    : NAV_PATH.runtime
                }
                className="inline-flex h-9 items-center gap-1 rounded-lg bg-gdc-primary px-4 text-sm font-semibold text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              >
                {WIZARD_LABEL.goToOperations}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </>
          ) : (
            <>
              {currentStepKey === 'route_processing' || currentStepKey === 'deploy' ? (
                <button
                  type="button"
                  onClick={() => saveDraft()}
                  className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200 dark:hover:bg-gdc-rowHover"
                  data-testid="wizard-save-draft"
                >
                  Save as Draft
                </button>
              ) : null}
              {isDeployStep && !streamCreated ? (
                <button
                  type="button"
                  onClick={() => void handleCreate({ startAfter: true })}
                  disabled={busy || isStarting || !deployReadiness.canCreate}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gdc-primary px-4 text-sm font-semibold text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="deploy-create-and-start"
                >
                  {busy || isStarting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {busy || isStarting ? 'Creating & Starting…' : 'Create & Start Stream'}
                </button>
              ) : null}
              {!isDeployStep ? (
                <button
                  type="button"
                  onClick={goToNextStep}
                  disabled={!canAdvance}
                  title={nextStepBlockReason}
                  className="inline-flex h-9 items-center gap-1 rounded-lg bg-gdc-primary px-4 text-sm font-semibold text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="wizard-next"
                >
                  {nextLabel ? (
                    <>
                      Next: {nextLabel}
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </>
                  )}
                </button>
              ) : null}
            </>
          )}
        </div>
      </nav> : null}
    </div>
  )
}
