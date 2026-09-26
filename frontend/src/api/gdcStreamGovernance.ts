import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, requestJson, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const RT = `${GDC_API_PREFIX}/runtime`
const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type GovernanceRouteOverride = {
  override_key?: string | null
  field_path?: string | null
  route_id: number
  protection_action?: string | null
  delivery_behavior?: string | null
  classification_level?: string | null
  enabled: boolean
}

export type GovernanceRule = {
  rule_key?: string | null
  field_path: string
  sensitivity_type?: string | null
  default_protection_action: string
  default_delivery_behavior: string
  enabled: boolean
  route_overrides?: GovernanceRouteOverride[]
}

export type StreamGovernanceDocument = {
  enabled: boolean
  rules: GovernanceRule[]
  route_overrides: GovernanceRouteOverride[]
}

export type StreamGovernanceResponse = StreamGovernanceDocument & {
  stream_id: number
  updated_at?: string | null
}

export type EffectiveProtectionAction = {
  protection_action: string | null
  protection_mode: string | null
  delivery_behavior: string | null
  source: string
  mutates_field: boolean
  enforcement: string | null
}

export type EffectiveRouteOverrideRef = {
  override_key?: string | null
  protection_action?: string | null
  delivery_behavior?: string | null
  classification_level?: string | null
  enabled: boolean
}

export type EffectivePerRouteField = {
  route_id: number
  effective: EffectiveProtectionAction
  override: EffectiveRouteOverrideRef | null
}

export type EffectiveFieldStreamDefault = {
  protection_action: string | null
  delivery_behavior: string | null
  sensitivity_type: string | null
}

export type EffectiveProtectionField = {
  field_path: string
  stream_default: EffectiveFieldStreamDefault | null
  per_route: EffectivePerRouteField[]
}

export type EffectiveProtectionRouteRef = {
  route_id: number
  destination_name: string | null
  enabled: boolean
}

export type EffectiveProtectionSummary = {
  protection_rule_count: number
  route_override_count: number
  routes_with_divergence: number
}

export type EffectiveProtectionResponse = {
  stream_id: number
  generated_at: string
  routes: EffectiveProtectionRouteRef[]
  fields: EffectiveProtectionField[]
  summary: EffectiveProtectionSummary
}

export async function fetchStreamGovernance(
  streamId: number,
): Promise<StreamGovernanceResponse | null> {
  return safeRequestJson<StreamGovernanceResponse>(`${RT}/streams/${streamId}/governance`, readJsonOpts)
}

export async function putStreamGovernance(
  streamId: number,
  body: StreamGovernanceDocument & { expected_updated_at: string },
): Promise<StreamGovernanceResponse> {
  return requestJson(`${RT}/streams/${streamId}/governance`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function fetchEffectiveProtection(
  streamId: number,
): Promise<EffectiveProtectionResponse | null> {
  return safeRequestJson<EffectiveProtectionResponse>(
    `${RT}/streams/${streamId}/governance/effective-protection`,
    readJsonOpts,
  )
}
