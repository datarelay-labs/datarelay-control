import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import type { ProtectionMode } from './gdcProtection'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type RouteProtectionRule = {
  id: number
  route_id: number
  stream_id: number
  field_path: string
  sensitivity_class: string
  protection_mode: ProtectionMode
  enabled: boolean
  source_finding_id: number | null
  created_by: string
  created_at: string
  updated_at: string
}

export type RouteProtectionRulesResponse = {
  route_id: number
  stream_id: number
  protection_enabled: boolean
  rules: RouteProtectionRule[]
  rule_count: number
}

export type RouteProtectionEffective = {
  route_id: number
  stream_id: number
  persisted_source: 'route' | 'stream'
  fallback_used: boolean
  rule_count: number
  processing_status: 'Inherited' | 'Overridden' | 'Mixed'
  message: string
}

export async function fetchRouteProtectionRules(
  routeId: number,
  enabledOnly = false,
): Promise<RouteProtectionRulesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<RouteProtectionRulesResponse>(
    `${RT}/routes/${routeId}/protection-rules${q}`,
    readJsonOpts,
  )
}

export async function replaceRouteProtectionRules(
  routeId: number,
  rules: Array<{
    field_path: string
    sensitivity_class: string
    protection_mode: ProtectionMode
    enabled?: boolean
    source_finding_id?: number | null
  }>,
): Promise<RouteProtectionRulesResponse> {
  return requestJson(`${RT}/routes/${routeId}/protection-rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  })
}

export async function createRouteProtectionRule(
  routeId: number,
  body: {
    field_path: string
    sensitivity_class: string
    protection_mode: ProtectionMode
    enabled?: boolean
    source_finding_id?: number | null
  },
): Promise<{ rule: RouteProtectionRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/protection-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchRouteProtectionRule(
  routeId: number,
  ruleId: number,
  body: { protection_mode?: ProtectionMode; enabled?: boolean; sensitivity_class?: string },
): Promise<{ rule: RouteProtectionRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/protection-rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRouteProtectionRule(routeId: number, ruleId: number): Promise<void> {
  await requestJson(`${RT}/routes/${routeId}/protection-rules/${ruleId}`, {
    method: 'DELETE',
  })
}

export async function fetchRouteProtectionEffective(
  routeId: number,
  options?: GdcSignalOptions,
): Promise<RouteProtectionEffective | null> {
  return safeRequestJson<RouteProtectionEffective>(
    `${RT}/routes/${routeId}/protection/effective`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}
