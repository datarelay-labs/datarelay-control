import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import type { ClassificationLevel } from './gdcClassification'

const RT = `${GDC_API_PREFIX}/runtime`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type RouteClassificationRule = {
  id: number
  route_id: number
  stream_id: number
  name: string
  enabled: boolean
  condition_json: Record<string, unknown>
  classification_level: ClassificationLevel
  created_at: string
  updated_at: string
}

export type RouteClassificationRulesResponse = {
  route_id: number
  stream_id: number
  rules: RouteClassificationRule[]
  rule_count: number
}

export type RouteClassificationEffective = {
  route_id: number
  stream_id: number
  persisted_source: 'route' | 'stream'
  fallback_used: boolean
  rule_count: number
  processing_status: 'Inherited' | 'Overridden' | 'Mixed'
  message: string
}

export async function fetchRouteClassificationRules(
  routeId: number,
  enabledOnly = false,
): Promise<RouteClassificationRulesResponse | null> {
  const q = enabledOnly ? '?enabled_only=true' : ''
  return safeRequestJson<RouteClassificationRulesResponse>(
    `${RT}/routes/${routeId}/classification-rules${q}`,
    readJsonOpts,
  )
}

export async function replaceRouteClassificationRules(
  routeId: number,
  rules: Array<{
    name: string
    enabled?: boolean
    condition_json: { sensitivity_class: string }
    classification_level: ClassificationLevel
  }>,
): Promise<RouteClassificationRulesResponse> {
  return requestJson(`${RT}/routes/${routeId}/classification-rules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  })
}

export async function createRouteClassificationRule(
  routeId: number,
  body: {
    name: string
    enabled?: boolean
    condition_json: { sensitivity_class: string }
    classification_level: ClassificationLevel
  },
): Promise<{ rule: RouteClassificationRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/classification-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function patchRouteClassificationRule(
  routeId: number,
  ruleId: number,
  body: {
    name?: string
    enabled?: boolean
    condition_json?: { sensitivity_class: string }
    classification_level?: ClassificationLevel
  },
): Promise<{ rule: RouteClassificationRule } | null> {
  return requestJson(`${RT}/routes/${routeId}/classification-rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteRouteClassificationRule(routeId: number, ruleId: number): Promise<void> {
  await requestJson(`${RT}/routes/${routeId}/classification-rules/${ruleId}`, {
    method: 'DELETE',
  })
}

export async function fetchRouteClassificationEffective(
  routeId: number,
  options?: GdcSignalOptions,
): Promise<RouteClassificationEffective | null> {
  return safeRequestJson<RouteClassificationEffective>(
    `${RT}/routes/${routeId}/classification/effective`,
    readJsonWithSignal(readJsonOpts, options?.signal),
  )
}
