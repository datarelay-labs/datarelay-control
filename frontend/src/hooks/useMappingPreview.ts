import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  runFinalEventDraftPreview,
  runMappingDraftPreview,
  runMappingValidate,
  type FinalEventDraftPreviewResponse,
  type MappingDraftPreviewResponse,
  type MappingValidationWarning,
} from '../api/gdcRuntimePreview'
import type { MappingRowModel } from '../components/streams/stream-mapping-model'
import { fieldMappingsFromRows } from '../utils/mappingValidation'

export type MappingPreviewState = {
  loading: boolean
  error: string | null
  mapped: MappingDraftPreviewResponse | null
  final: FinalEventDraftPreviewResponse | null
  validationWarnings: MappingValidationWarning[]
}

const EMPTY: MappingPreviewState = {
  loading: false,
  error: null,
  mapped: null,
  final: null,
  validationWarnings: [],
}

type UseMappingPreviewArgs = {
  rawPayload: unknown | null
  eventArrayPath: string
  eventRootPath: string
  rows: MappingRowModel[]
  fieldMappingsConfig?: Record<string, unknown>
  enrichment: Record<string, unknown>
  overridePolicy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  enabled?: boolean
  debounceMs?: number
  maxEvents?: number
}

export function useMappingPreview({
  rawPayload,
  eventArrayPath,
  eventRootPath,
  rows,
  fieldMappingsConfig,
  enrichment,
  overridePolicy = 'KEEP_EXISTING',
  enabled = true,
  debounceMs = 400,
  maxEvents = 5,
}: UseMappingPreviewArgs): MappingPreviewState & {
  refresh: () => void
} {
  const [state, setState] = useState<MappingPreviewState>(EMPTY)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reqIdRef = useRef(0)
  const resolvedFieldMappings = useMemo(
    () => fieldMappingsConfig ?? fieldMappingsFromRows(rows),
    [fieldMappingsConfig, rows],
  )

  const refresh = useCallback(() => {
    const reqId = ++reqIdRef.current
    if (!enabled || rawPayload === null || rawPayload === undefined) {
      setState(EMPTY)
      return
    }
    const fieldMappings = resolvedFieldMappings
    setState((s) => ({ ...s, loading: true, error: null }))

    void (async () => {
      try {
        const [validateRes, mappedRes, finalRes] = await Promise.all([
          runMappingValidate({
            payload: rawPayload,
            event_array_path: eventArrayPath || null,
            event_root_path: eventRootPath || null,
            field_mappings: fieldMappings,
          }),
          Object.keys(fieldMappings).length
            ? runMappingDraftPreview({
                payload: rawPayload,
                event_array_path: eventArrayPath || null,
                event_root_path: eventRootPath || null,
                field_mappings: fieldMappings,
                max_events: maxEvents,
              })
            : Promise.resolve(null),
          Object.keys(fieldMappings).length
            ? runFinalEventDraftPreview({
                payload: rawPayload,
                event_array_path: eventArrayPath || null,
                event_root_path: eventRootPath || null,
                field_mappings: fieldMappings,
                enrichment,
                override_policy: overridePolicy,
                max_events: maxEvents,
              })
            : Promise.resolve(null),
        ])
        if (reqId !== reqIdRef.current) return
        setState({
          loading: false,
          error: null,
          mapped: mappedRes,
          final: finalRes,
          validationWarnings: validateRes.warnings ?? [],
        })
      } catch (e) {
        if (reqId !== reqIdRef.current) return
        const message = e instanceof Error ? e.message : 'Preview request failed'
        setState({
          loading: false,
          error: message,
          mapped: null,
          final: null,
          validationWarnings: [],
        })
      }
    })()
  }, [enabled, rawPayload, eventArrayPath, eventRootPath, resolvedFieldMappings, enrichment, overridePolicy, maxEvents])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(refresh, debounceMs)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [refresh, debounceMs])

  return { ...state, refresh }
}
