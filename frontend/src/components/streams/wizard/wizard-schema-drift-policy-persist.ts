import { fetchStreamById, updateStream } from '../../../api/gdcStreams'
import {
  normalizeUnknownNormalFieldPolicy,
  normalizeUnknownSensitiveFieldPolicy,
  type WizardDataProtectionState,
} from './wizard-state'

function normalizeConfigJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) }
  }
  return {}
}

export type SchemaDriftPolicyPersistPayload = {
  unknown_normal_field_policy: ReturnType<typeof normalizeUnknownNormalFieldPolicy>
  unknown_sensitive_field_policy: ReturnType<typeof normalizeUnknownSensitiveFieldPolicy>
}

export type SchemaDriftPolicyPersistResult = {
  saved: boolean
  errors: string[]
  streamUpdatedAt?: string | null
}

export function buildSchemaDriftPolicyPersistPayload(
  dataProtection: Pick<WizardDataProtectionState, 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'>,
): SchemaDriftPolicyPersistPayload {
  return {
    unknown_normal_field_policy: normalizeUnknownNormalFieldPolicy(dataProtection.unknownNormalFieldPolicy),
    unknown_sensitive_field_policy: normalizeUnknownSensitiveFieldPolicy(
      dataProtection.unknownSensitiveFieldPolicy,
    ),
  }
}

export function mergeSchemaDriftPolicyIntoConfigJson(
  existing: Record<string, unknown>,
  dataProtection: Pick<WizardDataProtectionState, 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'>,
): Record<string, unknown> {
  const policy = buildSchemaDriftPolicyPersistPayload(dataProtection)
  const governance =
    existing.governance && typeof existing.governance === 'object' && !Array.isArray(existing.governance)
      ? { ...(existing.governance as Record<string, unknown>) }
      : {}
  return {
    ...existing,
    governance: {
      ...governance,
      schema_drift_policy: policy,
    },
  }
}

export async function persistWizardSchemaDriftPolicy(
  streamId: number,
  dataProtection: Pick<WizardDataProtectionState, 'unknownNormalFieldPolicy' | 'unknownSensitiveFieldPolicy'>,
  options?: {
    existingConfigJson?: Record<string, unknown> | null
    expectedUpdatedAt?: string | null
  },
): Promise<SchemaDriftPolicyPersistResult> {
  let existing = options?.existingConfigJson
  if (existing === undefined) {
    const stream = await fetchStreamById(streamId)
    existing = normalizeConfigJson(stream?.config_json)
  } else {
    existing = normalizeConfigJson(existing)
  }

  const mergedConfigJson = mergeSchemaDriftPolicyIntoConfigJson(existing, dataProtection)

  try {
    const updated = await updateStream(streamId, {
      config_json: mergedConfigJson,
      ...(options?.expectedUpdatedAt ? { expected_updated_at: options.expectedUpdatedAt } : {}),
    })
    return { saved: true, errors: [], streamUpdatedAt: updated.updated_at ?? options?.expectedUpdatedAt ?? null }
  } catch (err) {
    return {
      saved: false,
      errors: [
        `schema-drift-policy: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
}
