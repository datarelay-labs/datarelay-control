import { Loader2, Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import {
  fetchRouteEnrichmentUiConfig,
  fetchRouteMappingUiConfig,
  fetchRouteTransformEffective,
  saveRouteEnrichmentUiConfig,
  saveRouteMappingUiConfig,
  type RouteTransformEffective,
} from '../../api/gdcRouteTransform'
import {
  buildEnrichmentWithAdvancedFields,
  buildFieldMappingsWithTransformRules,
  extractPreservedFieldMappingMetadata,
  parseAdvancedFieldsFromEnrichment,
  parseTransformRulesFromFieldMappings,
} from '../../utils/advancedTransformConfig'
import { rowsFromFieldMappings } from '../../utils/mappingFieldMappings'
import { fieldMappingsFromRows } from '../../utils/mappingValidation'
import { loadMappingWorkspaceContext } from '../../utils/mappingSourceSample'
import {
  runEnrichmentExecPreview,
  runMappingDraftPreview,
  runRouteE2EDraftPreview,
} from '../../api/gdcRuntimePreview'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import {
  enrichmentDictFromRules,
  type WizardEnrichmentRule,
  wizardEnrichmentFromPersistedDict,
} from '../streams/wizard/enrichment-rules-model'
import { EnrichmentRulesEditor } from '../streams/wizard/enrichment-rules-editor'
import { AdvancedTransformWorkspace } from '../transform/advanced-transform-workspace'
import { MappingWorkspace } from '../mappings/mapping-workspace'
import { PanelChrome } from '../streams/mapping-json-tree'
import { isRouteTransformDirty, routeTransformFormFingerprint } from './route-delivery-dirty'

type Props = {
  routeId: number
  streamId: number | null
  /** When true, inherit/override, mapping, enrichment, and save cannot mutate. */
  readOnly?: boolean
  initialEffective?: RouteTransformEffective | null
  onEffectiveChange?: (effective: RouteTransformEffective | null) => void
  onDirtyChange?: (dirty: boolean) => void
}

function enrichmentRecord(rec: Record<string, unknown>): Record<string, unknown> {
  return rec
}

function splitRouteEnrichmentForEditors(rec: Record<string, unknown>) {
  const guidedSource: Record<string, unknown> = {}
  const reservedTopLevel: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rec)) {
    if (key === 'advanced_fields') continue
    if (key.startsWith('__') && key !== '__rules') {
      reservedTopLevel[key] = value
      continue
    }
    guidedSource[key] = value
  }

  const guided = wizardEnrichmentFromPersistedDict(guidedSource)
  return {
    guidedRules: guided.rules,
    guidedPassthrough: guided.advancedPassthrough,
    emitAdvancedAsTypeArray: guided.emitAdvancedAsTypeArray,
    reservedTopLevel,
    advancedRules: parseAdvancedFieldsFromEnrichment(rec),
  }
}

function buildRouteEnrichmentFromEditors(args: {
  guidedRules: readonly WizardEnrichmentRule[]
  guidedPassthrough: Record<string, unknown>
  emitAdvancedAsTypeArray: boolean
  reservedTopLevel: Record<string, unknown>
  advancedRules: readonly AdvancedTransformRuleDraft[]
}): Record<string, unknown> {
  const guided = enrichmentDictFromRules(args.guidedRules, {
    advancedPassthrough: args.guidedPassthrough,
    emitAdvancedAsTypeArray: args.emitAdvancedAsTypeArray,
  })
  return buildEnrichmentWithAdvancedFields(
    {
      ...args.reservedTopLevel,
      ...guided,
    },
    args.advancedRules,
  )
}

export function RouteEditTransformPanel({
  routeId,
  streamId,
  readOnly = false,
  initialEffective,
  onEffectiveChange,
  onDirtyChange,
}: Props) {
  const effectivePreload =
    initialEffective != null && initialEffective.route_id === routeId ? initialEffective : undefined
  const effectivePreloadRef = useRef(effectivePreload)
  effectivePreloadRef.current = effectivePreload
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [inheritMapping, setInheritMapping] = useState(true)
  const [inheritEnrichment, setInheritEnrichment] = useState(true)
  const [rows, setRows] = useState<MappingRowModel[]>([])
  const [transformRules, setTransformRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [preservedFieldMappings, setPreservedFieldMappings] = useState<Record<string, unknown>>({})
  const [streamFieldMappings, setStreamFieldMappings] = useState<Record<string, unknown>>({})
  const [streamEventArrayPath, setStreamEventArrayPath] = useState('')
  const [streamEventRootPath, setStreamEventRootPath] = useState('')
  const [routeEnrichment, setRouteEnrichment] = useState<Record<string, unknown>>({})
  const [routeGuidedRules, setRouteGuidedRules] = useState<WizardEnrichmentRule[]>([])
  const [routeAdvancedRules, setRouteAdvancedRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [routeGuidedPassthrough, setRouteGuidedPassthrough] = useState<Record<string, unknown>>({})
  const [routeReservedEnrichment, setRouteReservedEnrichment] = useState<Record<string, unknown>>({})
  const [routeEmitAdvancedAsTypeArray, setRouteEmitAdvancedAsTypeArray] = useState(false)
  const [routeEnrichmentTab, setRouteEnrichmentTab] = useState<'guided' | 'advanced' | 'expert'>('guided')
  const [routeMappedSamples, setRouteMappedSamples] = useState<Array<Record<string, unknown>>>([])
  const [routeEnrichmentDraftPreview, setRouteEnrichmentDraftPreview] = useState<Record<string, unknown> | null>(null)
  const [routeEnrichmentDraftError, setRouteEnrichmentDraftError] = useState<string | null>(null)
  const [routeEnrichmentDraftLoading, setRouteEnrichmentDraftLoading] = useState(false)
  const [sourceExtractedEvents, setSourceExtractedEvents] = useState<Array<Record<string, unknown>>>([])
  const [streamEnrichment, setStreamEnrichment] = useState<Record<string, unknown>>({})
  const [routeEnrichmentEnabled, setRouteEnrichmentEnabled] = useState(true)
  const [streamEnrichmentEnabled, setStreamEnrichmentEnabled] = useState(true)
  const [routeEnrichmentPolicy, setRouteEnrichmentPolicy] = useState<
    'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  >('KEEP_EXISTING')
  const [streamEnrichmentPolicy, setStreamEnrichmentPolicy] = useState<
    'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  >('KEEP_EXISTING')
  const [streamTitle, setStreamTitle] = useState('Stream')
  const [connectorLabel, setConnectorLabel] = useState('—')
  const [sourceType, setSourceType] = useState<string | null>(null)
  const [eventArrayPath, setEventArrayPath] = useState('')
  const [eventRootPath, setEventRootPath] = useState('')
  const [routeRawPayloadMode, setRouteRawPayloadMode] = useState<string | null>(null)
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)
  const [sourceSample, setSourceSample] = useState<unknown>(null)
  const [effectivePreview, setEffectivePreview] = useState<Array<Record<string, unknown>>>([])
  const [effectivePreviewMessage, setEffectivePreviewMessage] = useState<string | null>(null)
  const [routeStageTimeline, setRouteStageTimeline] = useState<Array<Record<string, unknown>>>([])
  const [routePolicyAction, setRoutePolicyAction] = useState<string | null>(null)
  const loadGenRef = useRef(0)
  const refreshEffective = useCallback(async () => {
    const effective = await fetchRouteTransformEffective(routeId)
    onEffectiveChange?.(effective)
    return effective
  }, [onEffectiveChange, routeId])

  const load = useCallback(async (opts?: { skipEffective?: boolean }) => {
    if (streamId == null) {
      setLoading(false)
      return
    }
    const gen = ++loadGenRef.current
    setLoading(true)
    setSaveError(null)
    try {
      const [mappingCfg, enrichmentCfg, ctx] = await Promise.all([
        fetchRouteMappingUiConfig(routeId),
        fetchRouteEnrichmentUiConfig(routeId),
        loadMappingWorkspaceContext(streamId),
      ])
      if (gen !== loadGenRef.current) return
      const nextInheritMapping = mappingCfg?.inherit_stream_mapping ?? true
      const nextInheritEnrichment = enrichmentCfg?.inherit_stream_enrichment ?? true
      setInheritMapping(nextInheritMapping)
      setInheritEnrichment(nextInheritEnrichment)

      const fm = (mappingCfg?.mapping?.field_mappings ?? {}) as Record<string, unknown>
      const mappingRows = Object.keys(fm).length > 0 ? rowsFromFieldMappings(fm) : []
      const nextRules = parseTransformRulesFromFieldMappings(fm)
      const nextRouteEnrichment = (enrichmentCfg?.enrichment?.enrichment ?? {}) as Record<string, unknown>
      const nextStreamEnrichment = (enrichmentCfg?.stream_enrichment?.enrichment ?? {}) as Record<string, unknown>
      const routeEnrichmentEditors = splitRouteEnrichmentForEditors(nextRouteEnrichment)
      const normalizePolicy = (
        value: string | null | undefined,
      ): 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT' =>
        value === 'OVERRIDE' || value === 'ERROR_ON_CONFLICT' || value === 'KEEP_EXISTING'
          ? value
          : 'KEEP_EXISTING'
      setRouteEnrichment(nextRouteEnrichment)
      setRouteGuidedRules(routeEnrichmentEditors.guidedRules)
      setRouteAdvancedRules(routeEnrichmentEditors.advancedRules)
      setRouteGuidedPassthrough(routeEnrichmentEditors.guidedPassthrough)
      setRouteReservedEnrichment(routeEnrichmentEditors.reservedTopLevel)
      setRouteEmitAdvancedAsTypeArray(routeEnrichmentEditors.emitAdvancedAsTypeArray)
      setStreamEnrichment(nextStreamEnrichment)
      setRouteEnrichmentEnabled(enrichmentCfg?.enrichment?.enabled !== false)
      setStreamEnrichmentEnabled(enrichmentCfg?.stream_enrichment?.enabled !== false)
      setRouteEnrichmentPolicy(normalizePolicy(enrichmentCfg?.enrichment?.override_policy))
      setStreamEnrichmentPolicy(normalizePolicy(enrichmentCfg?.stream_enrichment?.override_policy))
      let nextArray = String(mappingCfg?.mapping?.event_array_path ?? '')
      let nextRoot = String(mappingCfg?.mapping?.event_root_path ?? '')
      setRouteRawPayloadMode(mappingCfg?.mapping?.raw_payload_mode ?? null)
      setRows(mappingRows)
      setTransformRules(nextRules)
      setPreservedFieldMappings(extractPreservedFieldMappingMetadata(fm))
      setStreamFieldMappings((mappingCfg?.stream_mapping?.field_mappings ?? {}) as Record<string, unknown>)
      setStreamEventArrayPath(String(mappingCfg?.stream_mapping?.event_array_path ?? ''))
      setStreamEventRootPath(String(mappingCfg?.stream_mapping?.event_root_path ?? ''))
      setEventArrayPath(nextArray)
      setEventRootPath(nextRoot)

      if (ctx) {
        setStreamTitle(ctx.cfg.stream_name || ctx.stream.name || `Stream ${streamId}`)
        setConnectorLabel(ctx.connectorName)
        setSourceType(ctx.cfg.source_type ?? ctx.stream.stream_type ?? null)
        setSourceSample(ctx.sample.rawPayload)
        setSourceExtractedEvents(
          ctx.sample.extractedEvents
            .filter(
              (event): event is Record<string, unknown> =>
                event != null && typeof event === 'object' && !Array.isArray(event),
            )
            .slice(0, 20),
        )
        if (!mappingCfg?.mapping?.event_array_path) {
          nextArray = String(ctx.cfg.mapping?.event_array_path ?? ctx.sample.eventArrayPath ?? '')
          setEventArrayPath(nextArray)
        }
        if (!mappingCfg?.mapping?.event_root_path) {
          nextRoot = String(ctx.cfg.mapping?.event_root_path ?? ctx.sample.eventRootPath ?? '')
          setEventRootPath(nextRoot)
        }
      }
      setSavedSnapshot(
        routeTransformFormFingerprint({
          inheritMapping: nextInheritMapping,
          inheritEnrichment: nextInheritEnrichment,
          rows: mappingRows,
          transformRules: nextRules,
          enrichment: nextRouteEnrichment,
          enrichmentEnabled: enrichmentCfg?.enrichment?.enabled !== false,
          enrichmentOverridePolicy: normalizePolicy(enrichmentCfg?.enrichment?.override_policy),
          eventArrayPath: nextArray,
          eventRootPath: nextRoot,
          rawPayloadMode: mappingCfg?.mapping?.raw_payload_mode ?? null,
        }),
      )
      if (opts?.skipEffective === true && effectivePreloadRef.current != null) {
        onEffectiveChange?.(effectivePreloadRef.current)
      } else {
        await refreshEffective()
      }
    } catch (e) {
      if (gen !== loadGenRef.current) return
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [onEffectiveChange, refreshEffective, routeId, streamId])

  useEffect(() => {
    const skipEffective = effectivePreloadRef.current != null
    void load({ skipEffective })
  }, [routeId, streamId, load])

  const handleRouteGuidedRulesChange = useCallback(
    (nextRules: WizardEnrichmentRule[]) => {
      if (readOnly) return
      setRouteGuidedRules(nextRules)
      setRouteEnrichment(
        buildRouteEnrichmentFromEditors({
          guidedRules: nextRules,
          guidedPassthrough: routeGuidedPassthrough,
          emitAdvancedAsTypeArray: routeEmitAdvancedAsTypeArray,
          reservedTopLevel: routeReservedEnrichment,
          advancedRules: routeAdvancedRules,
        }),
      )
    },
    [
      readOnly,
      routeAdvancedRules,
      routeEmitAdvancedAsTypeArray,
      routeGuidedPassthrough,
      routeReservedEnrichment,
    ],
  )

  const handleRouteAdvancedRulesChange = useCallback(
    (nextRules: AdvancedTransformRuleDraft[]) => {
      if (readOnly) return
      setRouteAdvancedRules(nextRules)
      setRouteEnrichment(
        buildRouteEnrichmentFromEditors({
          guidedRules: routeGuidedRules,
          guidedPassthrough: routeGuidedPassthrough,
          emitAdvancedAsTypeArray: routeEmitAdvancedAsTypeArray,
          reservedTopLevel: routeReservedEnrichment,
          advancedRules: nextRules,
        }),
      )
    },
    [
      readOnly,
      routeEmitAdvancedAsTypeArray,
      routeGuidedPassthrough,
      routeGuidedRules,
      routeReservedEnrichment,
    ],
  )

  const effectiveDraftEnrichmentEnabled = inheritEnrichment
    ? streamEnrichmentEnabled
    : routeEnrichmentEnabled
  const effectiveDraftEnrichmentPolicy = inheritEnrichment
    ? streamEnrichmentPolicy
    : routeEnrichmentPolicy
  const effectiveDraftEnrichment = effectiveDraftEnrichmentEnabled
    ? inheritEnrichment
      ? streamEnrichment
      : routeEnrichment
    : {}

  const draftFieldMappingsForEnrichment = useMemo(
    () =>
      inheritMapping
        ? streamFieldMappings
        : {
            ...preservedFieldMappings,
            ...buildFieldMappingsWithTransformRules(fieldMappingsFromRows(rows), transformRules),
          },
    [inheritMapping, preservedFieldMappings, rows, streamFieldMappings, transformRules],
  )
  const draftEventArrayPathForEnrichment = inheritMapping ? streamEventArrayPath : eventArrayPath
  const draftEventRootPathForEnrichment = inheritMapping ? streamEventRootPath : eventRootPath

  useEffect(() => {
    let cancelled = false
    if (sourceSample == null) {
      setRouteMappedSamples([])
      return
    }
    if (Object.keys(draftFieldMappingsForEnrichment).length === 0) {
      setRouteMappedSamples(sourceExtractedEvents)
      return
    }

    const timer = window.setTimeout(() => {
      void runMappingDraftPreview({
        payload: sourceSample,
        event_array_path: draftEventArrayPathForEnrichment || null,
        event_root_path: draftEventRootPathForEnrichment || null,
        field_mappings: draftFieldMappingsForEnrichment,
        max_events: 20,
      })
        .then((response) => {
          if (cancelled) return
          setRouteMappedSamples(
            response.mapped_events.filter(
              (event): event is Record<string, unknown> =>
                event != null && typeof event === 'object' && !Array.isArray(event),
            ),
          )
        })
        .catch(() => {
          if (!cancelled) setRouteMappedSamples([])
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    sourceSample,
    sourceExtractedEvents,
    draftFieldMappingsForEnrichment,
    draftEventArrayPathForEnrichment,
    draftEventRootPathForEnrichment,
  ])

  const routeMappedSample = routeMappedSamples[0] ?? null

  useEffect(() => {
    let cancelled = false
    if (inheritEnrichment || routeMappedSample == null) {
      setRouteEnrichmentDraftPreview(null)
      setRouteEnrichmentDraftError(null)
      setRouteEnrichmentDraftLoading(false)
      return
    }
    if (!routeEnrichmentEnabled) {
      setRouteEnrichmentDraftPreview(routeMappedSample)
      setRouteEnrichmentDraftError(null)
      setRouteEnrichmentDraftLoading(false)
      return
    }

    const timer = window.setTimeout(() => {
      setRouteEnrichmentDraftLoading(true)
      setRouteEnrichmentDraftError(null)
      void runEnrichmentExecPreview({
        mapped_event: routeMappedSample,
        enrichment: routeEnrichment,
        override_policy: routeEnrichmentPolicy,
      })
        .then((response) => {
          if (cancelled) return
          setRouteEnrichmentDraftPreview(response.final_event)
          const fieldErrors = response.field_errors ?? []
          setRouteEnrichmentDraftError(
            fieldErrors.length > 0
              ? fieldErrors
                  .map((item) => `${item.output_field || item.rule_id || 'field'}: ${item.error_message}`)
                  .join(' · ')
              : null,
          )
        })
        .catch((error) => {
          if (cancelled) return
          setRouteEnrichmentDraftPreview(null)
          setRouteEnrichmentDraftError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (!cancelled) setRouteEnrichmentDraftLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    inheritEnrichment,
    routeEnrichment,
    routeEnrichmentEnabled,
    routeEnrichmentPolicy,
    routeMappedSample,
  ])

  const routeMappedKeysLower = useMemo(
    () => new Set(Object.keys(routeMappedSample ?? {}).map((key) => key.toLowerCase())),
    [routeMappedSample],
  )
  const routeGuidedEnrichmentPayload = useMemo(
    () =>
      buildRouteEnrichmentFromEditors({
        guidedRules: routeGuidedRules,
        guidedPassthrough: routeGuidedPassthrough,
        emitAdvancedAsTypeArray: routeEmitAdvancedAsTypeArray,
        reservedTopLevel: routeReservedEnrichment,
        advancedRules: [],
      }),
    [
      routeEmitAdvancedAsTypeArray,
      routeGuidedPassthrough,
      routeGuidedRules,
      routeReservedEnrichment,
    ],
  )

  const currentTransform = useMemo(
    () => ({
      inheritMapping,
      inheritEnrichment,
      rows,
      transformRules,
      enrichment: routeEnrichment,
      enrichmentEnabled: routeEnrichmentEnabled,
      enrichmentOverridePolicy: routeEnrichmentPolicy,
      eventArrayPath,
      eventRootPath,
      rawPayloadMode: routeRawPayloadMode,
    }),
    [
      routeEnrichment,
      routeEnrichmentEnabled,
      routeEnrichmentPolicy,
      eventArrayPath,
      eventRootPath,
      routeRawPayloadMode,
      inheritMapping,
      inheritEnrichment,
      rows,
      transformRules,
    ],
  )
  const hasUnsavedChanges = isRouteTransformDirty(savedSnapshot, currentTransform)

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges)
  }, [hasUnsavedChanges, onDirtyChange])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedChanges])

  useEffect(() => {
    let cancelled = false
    if (sourceSample == null || initialEffective == null) {
      setEffectivePreview([])
      setEffectivePreviewMessage(null)
      return
    }
    void runRouteE2EDraftPreview({
      payload: sourceSample,
      stream_id: streamId as number,
      route_id: routeId,
      destination_type: 'WEBHOOK_POST',
      formatter_config: {},
      field_mappings: { ...(initialEffective.effective_field_mappings ?? {}) },
      enrichment: initialEffective.effective_enrichment ?? {},
      override_policy: (['KEEP_EXISTING', 'OVERRIDE', 'ERROR_ON_CONFLICT'].includes(initialEffective.effective_override_policy)
        ? initialEffective.effective_override_policy
        : 'KEEP_EXISTING') as 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT',
      max_events: 3,
    })
      .then((result) => {
        if (cancelled) return
        setEffectivePreview(result.final_events)
        setRouteStageTimeline(result.route_stage_timeline ?? [])
        setRoutePolicyAction(result.policy_action ?? null)
        setEffectivePreviewMessage(result.message)
      })
      .catch((error) => {
        if (cancelled) return
        setEffectivePreview([])
        setRouteStageTimeline([])
        setRoutePolicyAction(null)
        setEffectivePreviewMessage(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [initialEffective, routeId, sourceSample, streamId])

  const handleSave = async () => {
    if (readOnly || saving || streamId == null || !hasUnsavedChanges) return
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    try {
      if (inheritMapping) {
        await saveRouteMappingUiConfig(routeId, { inherit: true })
      } else {
        const fieldMappings = {
          ...preservedFieldMappings,
          ...buildFieldMappingsWithTransformRules(
            fieldMappingsFromRows(rows),
            transformRules,
          ),
        }
        if (Object.keys(fieldMappings).length === 0) {
          throw new Error('Add at least one mapping field or Advanced Transform rule before overriding Route Mapping.')
        }
        await saveRouteMappingUiConfig(routeId, {
          inherit: false,
          mapping: {
            field_mappings: fieldMappings,
            event_array_path: eventArrayPath.trim() || null,
            event_root_path: eventRootPath.trim() || null,
            raw_payload_mode: routeRawPayloadMode,
          },
        })
      }

      if (inheritEnrichment) {
        await saveRouteEnrichmentUiConfig(routeId, { inherit: true })
      } else {
        await saveRouteEnrichmentUiConfig(routeId, {
          inherit: false,
          enrichment: {
            enabled: routeEnrichmentEnabled,
            enrichment: routeEnrichment,
            override_policy: routeEnrichmentPolicy,
          },
        })
      }

      const mode =
        inheritMapping && inheritEnrichment
          ? 'Inherited'
          : !inheritMapping && !inheritEnrichment
            ? 'Overridden'
            : 'Mixed'
      setSaveSuccess(`Route Transform saved · ${mode}.`)
      await load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setSaveSuccess(null)
    } finally {
      setSaving(false)
    }
  }

  const inheritHint = useMemo(() => {
    if (inheritMapping && inheritEnrichment) {
      return 'Mapping and enrichment both use the parent Stream configuration at runtime.'
    }
    if (!inheritMapping && !inheritEnrichment) {
      return 'This Route overrides both Mapping and Enrichment.'
    }
    return inheritMapping
      ? 'Mixed: Mapping is inherited while Enrichment remains Route-specific.'
      : 'Mixed: Mapping is Route-specific while Enrichment is inherited.'
  }, [inheritMapping, inheritEnrichment])

  if (streamId == null) {
    return (
      <PanelChrome title="Transform">
        <p className="p-3 text-[12px] text-slate-600 dark:text-gdc-muted">Link this route to a stream before configuring transform.</p>
      </PanelChrome>
    )
  }

  if (loading) {
    return (
      <PanelChrome title="Transform">
        <div className="flex items-center gap-2 p-6 text-[12px] text-slate-600 dark:text-gdc-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading route transform…
        </div>
      </PanelChrome>
    )
  }

  return (
    <div className="space-y-3" data-testid="route-edit-transform-panel">
      <PanelChrome title="Transform mode">
        <div className="space-y-3 p-3">
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">{inheritHint}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-md border border-slate-200/80 bg-slate-50/60 p-2.5 text-[12px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100">
              <input
                type="checkbox"
                checked={inheritMapping}
                disabled={readOnly}
                onChange={(e) => setInheritMapping(e.target.checked)}
                data-testid="route-transform-inherit-mapping"
                className="mt-0.5 accent-violet-600"
              />
              <span>
                <span className="block">Inherit Stream Mapping</span>
                <span className="mt-0.5 block text-[10px] font-normal text-slate-500 dark:text-gdc-muted">
                  Off = this Route owns field mapping and Advanced Transform rules.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-slate-200/80 bg-slate-50/60 p-2.5 text-[12px] font-medium text-slate-800 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100">
              <input
                type="checkbox"
                checked={inheritEnrichment}
                disabled={readOnly}
                onChange={(e) => setInheritEnrichment(e.target.checked)}
                data-testid="route-transform-inherit-enrichment"
                className="mt-0.5 accent-violet-600"
              />
              <span>
                <span className="block">Inherit Stream Enrichment</span>
                <span className="mt-0.5 block text-[10px] font-normal text-slate-500 dark:text-gdc-muted">
                  Off = keep the Route-specific enrichment configuration.
                </span>
              </span>
            </label>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted"
              data-testid="route-transform-save-status"
              aria-live="polite"
            >
              {readOnly
                ? 'Read-only'
                : saving
                  ? 'Saving…'
                  : saveError
                    ? 'Save failed'
                    : saveSuccess
                      ? 'Saved'
                      : hasUnsavedChanges
                        ? 'Unsaved changes'
                        : 'Saved'}
            </span>
            {readOnly ? null : (
            <button
              type="button"
              disabled={saving || !hasUnsavedChanges}
              onClick={() => void handleSave()}
              data-testid="route-transform-save"
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60',
              )}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saving ? 'Saving…' : 'Save Transform'}
            </button>
            )}
          </div>
          {hasUnsavedChanges ? (
            <p className="text-[11px] text-amber-800 dark:text-amber-200" data-testid="route-transform-unsaved-hint">
              Transform edits are local until Save Transform. Runtime still uses the persisted mapping/enrichment.
            </p>
          ) : null}
          {saveError ? <p className="text-[12px] text-red-700 dark:text-red-300">{saveError}</p> : null}
          {saveSuccess ? <p className="text-[12px] text-emerald-700 dark:text-emerald-300">{saveSuccess}</p> : null}
        </div>
      </PanelChrome>

      <div>
        <section className="rounded-lg border border-violet-200/80 bg-violet-50/40 p-3 dark:border-violet-500/30 dark:bg-violet-500/[0.06]" data-testid="route-effective-final-event-preview">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">Effective Final Event</p>
            <p className="mt-0.5 text-[10px] text-slate-600 dark:text-gdc-muted">
              Persisted effective mapping + enrichment resolved for this Route ({initialEffective?.processing_status ?? '—'}).
            </p>
          </div>
          <span className="rounded-full border border-violet-200 bg-white px-2 py-0.5 text-[9px] font-semibold text-violet-700 dark:border-violet-500/30 dark:bg-gdc-card dark:text-violet-200">
            Runtime-resolved config
          </span>
        </div>
        {routeStageTimeline.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1" data-testid="route-effective-stage-timeline">
            {routeStageTimeline.map((stage, index) => (
              <span key={index} className="rounded-full border border-violet-200 bg-white px-2 py-0.5 text-[9px] text-violet-800 dark:border-violet-500/30 dark:bg-gdc-card dark:text-violet-200">
                {String(stage.stage ?? 'stage')}: {String(stage.status ?? stage.decision ?? 'completed')}
              </span>
            ))}
            {routePolicyAction ? <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] text-amber-800">Policy: {routePolicyAction}</span> : null}
          </div>
        ) : null}
        {effectivePreview.length > 0 ? (
          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-slate-950 p-2 text-[10px] leading-relaxed text-slate-100" data-testid="route-effective-final-event-json">
            {JSON.stringify(effectivePreview[0], null, 2)}
          </pre>
        ) : (
          <p className="mt-2 text-[10px] text-slate-500">{effectivePreviewMessage || 'Load a source sample to preview the effective Final Event.'}</p>
        )}
      </section>

      {inheritEnrichment ? (
        <section
          className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 dark:border-gdc-border dark:bg-gdc-section"
          data-testid="route-enrichment-inherited"
        >
          <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Stream Enrichment inherited</p>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
            The Route uses the Stream Enrichment configuration and its existing-field policy. Turn off Inherit Stream
            Enrichment to create or edit Route-specific enrichment rules.
          </p>
        </section>
      ) : (
        <section
          className="mt-3 rounded-lg border border-slate-200/80 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
          data-testid="route-enrichment-override-editor"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Route-specific Enrichment</p>
              <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">
                Rules execute after the effective Mapping and before Protection / Classification / Policy.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={routeEnrichmentEnabled}
                  disabled={readOnly}
                  onChange={(event) => setRouteEnrichmentEnabled(event.target.checked)}
                  className="accent-violet-600"
                />
                Enabled
              </label>
              <select
                value={routeEnrichmentPolicy}
                disabled={readOnly}
                onChange={(event) =>
                  setRouteEnrichmentPolicy(
                    event.target.value as 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT',
                  )
                }
                className="h-8 rounded-md border border-slate-200/90 bg-white px-2 text-[10px] font-semibold text-slate-800 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                aria-label="Route enrichment existing-field policy"
              >
                <option value="KEEP_EXISTING">Keep existing</option>
                <option value="OVERRIDE">Override existing</option>
                <option value="ERROR_ON_CONFLICT">Error on conflict</option>
              </select>
            </div>
          </div>

          {!routeEnrichmentEnabled ? (
            <p className="mt-2 rounded-md border border-amber-200/80 bg-amber-500/[0.06] px-2.5 py-2 text-[10px] text-amber-900 dark:border-amber-500/30 dark:text-amber-100">
              Route Enrichment is disabled. Rules remain editable and persisted, but runtime delivery skips this stage.
            </p>
          ) : null}

          <div className="mt-3 flex gap-1 border-b border-slate-200/80 dark:border-gdc-border" role="tablist" aria-label="Route enrichment editor">
            {[
              ['guided', 'Guided'],
              ['advanced', 'JSONata'],
              ['expert', 'Regex'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={routeEnrichmentTab === key}
                onClick={() => setRouteEnrichmentTab(key as 'guided' | 'advanced' | 'expert')}
                className={cn(
                  '-mb-px border-b-2 px-3 pb-2 text-[11px] font-semibold',
                  routeEnrichmentTab === key
                    ? 'border-violet-600 text-violet-700 dark:border-violet-400 dark:text-violet-300'
                    : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-gdc-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3">
            {routeEnrichmentTab === 'guided' ? (
              <EnrichmentRulesEditor
                rules={routeGuidedRules}
                onChange={readOnly ? () => undefined : handleRouteGuidedRulesChange}
                mappedKeysLower={routeMappedKeysLower}
                mappedSampleEvent={routeMappedSample ?? undefined}
                excludeRuleTypes={['lookup']}
                sectionTitle="Route Enrichment rules"
                addMenuLabel="Add enrichment rule"
                className={readOnly ? 'pointer-events-none opacity-60' : undefined}
                data-testid="route-enrichment-guided-editor"
              />
            ) : (
              <AdvancedTransformWorkspace
                stage="enrichment"
                contextLabel="Route Enrichment"
                sampleEvent={routeMappedSample}
                sampleEvents={routeMappedSamples}
                rules={routeAdvancedRules}
                onRulesChange={handleRouteAdvancedRulesChange}
                enrichmentStatic={routeGuidedEnrichmentPayload}
                overridePolicy={routeEnrichmentPolicy}
                filterUiMode={routeEnrichmentTab === 'expert' ? 'expert' : 'advanced'}
                readOnly={readOnly}
              />
            )}
          </div>

          <div
            className="mt-3 rounded-md border border-slate-200/80 bg-slate-950 p-2.5 dark:border-gdc-border"
            data-testid="route-enrichment-draft-final-event"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-300">Draft Final Event</p>
              <span className="text-[9px] text-slate-400">
                {routeEnrichmentDraftLoading
                  ? 'Running runtime preview…'
                  : routeEnrichmentDraftError
                    ? 'Preview has errors'
                    : routeEnrichmentEnabled
                      ? 'Unsaved Route Enrichment applied'
                      : 'Enrichment disabled · mapped event passthrough'}
              </span>
            </div>
            {routeEnrichmentDraftError ? (
              <p className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-200">
                {routeEnrichmentDraftError}
              </p>
            ) : null}
            <pre className="mt-2 max-h-52 overflow-auto font-mono text-[10px] leading-relaxed text-slate-100">
              {routeEnrichmentDraftLoading
                ? 'Computing…'
                : routeEnrichmentDraftPreview
                  ? JSON.stringify(routeEnrichmentDraftPreview, null, 2)
                  : 'No mapped sample is available for this draft.'}
            </pre>
          </div>
        </section>
      )}

      {inheritMapping ? (
        <section className="mt-3 rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 dark:border-gdc-border dark:bg-gdc-section">
          <p className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Stream Mapping inherited</p>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
            The Route does not own a Mapping draft while inheritance is enabled. The Effective Final Event above is the
            authoritative runtime view. Turn off Inherit Stream Mapping to create or edit a Route-specific Mapping.
          </p>
        </section>
      ) : (
        <MappingWorkspace
          streamId={streamId}
          streamTitle={streamTitle}
          connectorLabel={connectorLabel}
          sourceType={sourceType}
          initialRows={rows}
          enrichment={enrichmentRecord(effectiveDraftEnrichment)}
          enrichmentOverridePolicy={effectiveDraftEnrichmentPolicy}
          eventArrayPath={eventArrayPath}
          eventRootPath={eventRootPath}
          onRowsChange={readOnly ? () => undefined : setRows}
          onEventArrayPathChange={() => undefined}
          eventPathReadOnly
          transformRules={transformRules}
          onTransformRulesChange={readOnly ? () => undefined : setTransformRules}
          preservedFieldMappings={preservedFieldMappings}
          readOnly={readOnly}
        />
      )}
      </div>
    </div>
  )
}
