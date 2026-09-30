import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

const RT = `${GDC_API_PREFIX}/runtime`

export type RouteMappingUiConfig = {
  route_id: number
  stream_id: number
  inherit_stream_mapping: boolean
  mapping: {
    exists: boolean
    event_array_path: string | null
    event_root_path: string | null
    field_mappings: Record<string, unknown>
    raw_payload_mode: string | null
  }
  stream_mapping: {
    exists: boolean
    event_array_path: string | null
    event_root_path: string | null
    field_mappings: Record<string, unknown>
    raw_payload_mode: string | null
  }
  message: string
}

export type RouteEnrichmentUiConfig = {
  route_id: number
  stream_id: number
  inherit_stream_enrichment: boolean
  enrichment: {
    exists: boolean
    enabled: boolean
    enrichment: Record<string, unknown>
    override_policy: string | null
  }
  stream_enrichment: {
    exists: boolean
    enabled: boolean
    enrichment: Record<string, unknown>
    override_policy: string | null
  }
  message: string
}

export type RouteTransformEffective = {
  route_id: number
  stream_id: number
  persisted_source: 'route' | 'stream' | 'mixed'
  mapping_source: 'route' | 'stream'
  enrichment_source: 'route' | 'stream'
  fallback_used: boolean
  mapping_count: number
  enrichment_count: number
  effective_field_mappings: Record<string, unknown>
  effective_enrichment: Record<string, unknown>
  effective_override_policy: string
  processing_status: 'Inherited' | 'Overridden' | 'Mixed'
  message: string
}

export type RouteMappingUiSaveRequest = {
  inherit?: boolean
  mapping?: {
    event_array_path?: string | null
    event_root_path?: string | null
    field_mappings: Record<string, unknown>
    raw_payload_mode?: string | null
  } | null
}

export type RouteEnrichmentUiSaveRequest = {
  inherit?: boolean
  enrichment?: {
    enabled?: boolean
    enrichment?: Record<string, unknown>
    override_policy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  } | null
}

export async function fetchRouteMappingUiConfig(routeId: number): Promise<RouteMappingUiConfig | null> {
  return safeRequestJson<RouteMappingUiConfig>(`${RT}/routes/${routeId}/mapping-ui/config`)
}

export async function saveRouteMappingUiConfig(
  routeId: number,
  payload: RouteMappingUiSaveRequest,
): Promise<{ route_id: number; stream_id: number; mapping_saved: boolean; inherit_stream_mapping: boolean; message: string }> {
  return requestJson(`${RT}/routes/${routeId}/mapping-ui/save`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function fetchRouteEnrichmentUiConfig(routeId: number): Promise<RouteEnrichmentUiConfig | null> {
  return safeRequestJson<RouteEnrichmentUiConfig>(`${RT}/routes/${routeId}/enrichment-ui/config`)
}

export async function saveRouteEnrichmentUiConfig(
  routeId: number,
  payload: RouteEnrichmentUiSaveRequest,
): Promise<{ route_id: number; stream_id: number; enrichment_saved: boolean; inherit_stream_enrichment: boolean; message: string }> {
  return requestJson(`${RT}/routes/${routeId}/enrichment-ui/save`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function fetchRouteTransformEffective(
  routeId: number,
  options?: GdcSignalOptions,
): Promise<RouteTransformEffective | null> {
  return safeRequestJson<RouteTransformEffective>(
    `${RT}/routes/${routeId}/transform/effective`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}
