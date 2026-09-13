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
import { buildFieldMappingsWithTransformRules, parseTransformRulesFromFieldMappings } from '../../utils/advancedTransformConfig'
import { rowsFromFieldMappings } from '../../utils/mappingFieldMappings'
import { fieldMappingsFromRows } from '../../utils/mappingValidation'
import { loadMappingWorkspaceContext } from '../../utils/mappingSourceSample'
import type { AdvancedTransformRuleDraft } from '../../types/advancedTransform'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { MappingWorkspace } from '../mappings/mapping-workspace'
import { PanelChrome } from '../streams/mapping-json-tree'
import { isRouteTransformDirty, routeTransformFormFingerprint } from './route-delivery-dirty'

type Props = {
  routeId: number
  streamId: number | null
  initialEffective?: RouteTransformEffective | null
  onEffectiveChange?: (effective: RouteTransformEffective | null) => void
  onDirtyChange?: (dirty: boolean) => void
}

function enrichmentRecord(rec: Record<string, unknown>): Record<string, unknown> {
  return rec
}

export function RouteEditTransformPanel({ routeId, streamId, initialEffective, onEffectiveChange, onDirtyChange }: Props) {
  const effectivePreload =
    initialEffective != null && initialEffective.route_id === routeId ? initialEffective : undefined
  const effectivePreloadRef = useRef(effectivePreload)
  effectivePreloadRef.current = effectivePreload
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)
  const [inheritStream, setInheritStream] = useState(true)
  const [rows, setRows] = useState<MappingRowModel[]>([])
  const [transformRules, setTransformRules] = useState<AdvancedTransformRuleDraft[]>([])
  const [enrichment, setEnrichment] = useState<Record<string, unknown>>({})
  const [streamTitle, setStreamTitle] = useState('Stream')
  const [connectorLabel, setConnectorLabel] = useState('—')
  const [sourceType, setSourceType] = useState<string | null>(null)
  const [eventArrayPath, setEventArrayPath] = useState('')
  const [eventRootPath, setEventRootPath] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null)
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
      const inheritMapping = mappingCfg?.inherit_stream_mapping ?? true
      const inheritEnrichment = enrichmentCfg?.inherit_stream_enrichment ?? true
      const nextInherit = inheritMapping && inheritEnrichment
      setInheritStream(nextInherit)

      const fm = (mappingCfg?.mapping?.field_mappings ?? {}) as Record<string, unknown>
      const mappingRows = Object.keys(fm).length > 0 ? rowsFromFieldMappings(fm) : []
      const nextRules = parseTransformRulesFromFieldMappings(fm)
      const nextEnrichment = (enrichmentCfg?.enrichment?.enrichment ?? {}) as Record<string, unknown>
      let nextArray = String(mappingCfg?.mapping?.event_array_path ?? '')
      let nextRoot = String(mappingCfg?.mapping?.event_root_path ?? '')
      setRows(mappingRows)
      setTransformRules(nextRules)
      setEnrichment(nextEnrichment)
      setEventArrayPath(nextArray)
      setEventRootPath(nextRoot)

      if (ctx) {
        setStreamTitle(ctx.cfg.stream_name || ctx.stream.name || `Stream ${streamId}`)
        setConnectorLabel(ctx.connectorName)
        setSourceType(ctx.cfg.source_type ?? ctx.stream.stream_type ?? null)
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
          inheritStream: nextInherit,
          rows: mappingRows,
          transformRules: nextRules,
          enrichment: nextEnrichment,
          eventArrayPath: nextArray,
          eventRootPath: nextRoot,
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

  const currentTransform = useMemo(
    () => ({
      inheritStream,
      rows,
      transformRules,
      enrichment,
      eventArrayPath,
      eventRootPath,
    }),
    [enrichment, eventArrayPath, eventRootPath, inheritStream, rows, transformRules],
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

  const workspaceDisabled = inheritStream

  const handleInheritChange = (checked: boolean) => {
    setInheritStream(checked)
  }

  const handleOverrideChange = (checked: boolean) => {
    setInheritStream(!checked)
  }

  const handleSave = async () => {
    if (saving || streamId == null || !hasUnsavedChanges) return
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)
    try {
      if (inheritStream) {
        await saveRouteMappingUiConfig(routeId, { inherit: true })
        await saveRouteEnrichmentUiConfig(routeId, { inherit: true })
      } else {
        const fieldMappings = buildFieldMappingsWithTransformRules(
          fieldMappingsFromRows(rows),
          transformRules,
        )
        if (Object.keys(fieldMappings).length === 0) {
          throw new Error('Add at least one mapping field before saving a route override.')
        }
        await saveRouteMappingUiConfig(routeId, {
          inherit: false,
          mapping: {
            field_mappings: fieldMappings,
            event_array_path: eventArrayPath.trim() || null,
            event_root_path: eventRootPath.trim() || null,
          },
        })
        await saveRouteEnrichmentUiConfig(routeId, {
          inherit: false,
          enrichment: {
            enabled: true,
            enrichment,
            override_policy: 'KEEP_EXISTING',
          },
        })
      }
      setSaveSuccess(inheritStream ? 'Route inherits stream transform.' : 'Route transform override saved.')
      await load()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setSaveSuccess(null)
    } finally {
      setSaving(false)
    }
  }

  const inheritHint = useMemo(() => {
    if (inheritStream) return 'Mapping and enrichment use the parent stream configuration at runtime.'
    return 'This route uses its own mapping and enrichment override.'
  }, [inheritStream])

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
          <label className="flex items-center gap-2 text-[12px] font-medium text-slate-800 dark:text-slate-100">
            <input
              type="checkbox"
              checked={inheritStream}
              onChange={(e) => handleInheritChange(e.target.checked)}
              data-testid="route-transform-inherit"
              className="accent-violet-600"
            />
            Inherit Stream Transform
          </label>
          <label className="flex items-center gap-2 text-[12px] font-medium text-slate-800 dark:text-slate-100">
            <input
              type="checkbox"
              checked={!inheritStream}
              onChange={(e) => handleOverrideChange(e.target.checked)}
              data-testid="route-transform-override"
              className="accent-violet-600"
            />
            Override Route Transform
          </label>
          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[11px] font-semibold text-slate-600 dark:text-gdc-muted"
              data-testid="route-transform-save-status"
              aria-live="polite"
            >
              {saving ? 'Saving…' : saveError ? 'Save failed' : saveSuccess ? 'Saved' : hasUnsavedChanges ? 'Unsaved changes' : 'Saved'}
            </span>
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

      <div className={cn(workspaceDisabled && 'pointer-events-none opacity-50')} aria-disabled={workspaceDisabled}>
        <MappingWorkspace
          streamId={streamId}
          streamTitle={streamTitle}
          connectorLabel={connectorLabel}
          sourceType={sourceType}
          initialRows={rows}
          enrichment={enrichmentRecord(enrichment)}
          eventArrayPath={eventArrayPath}
          eventRootPath={eventRootPath}
          onRowsChange={setRows}
          onEventArrayPathChange={setEventArrayPath}
          transformRules={transformRules}
          onTransformRulesChange={setTransformRules}
        />
      </div>
    </div>
  )
}
