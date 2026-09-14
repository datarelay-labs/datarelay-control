import {
  buildInitialState,
  migrateLegacyStepIndex,
  normalizeUnknownNormalFieldPolicy,
  normalizeUnknownSensitiveFieldPolicy,
  normalizeWizardDestinations,
  normalizeWizardProtectionAction,
  normalizeWizardRouteProtectionOverride,
  WIZARD_STEP_KEYS,
  type WizardLegacySubstepKey,
  type WizardState,
  type WizardStepKey,
} from './wizard-state'

export const WIZARD_DRAFT_KEY_V1 = 'gdc-stream-wizard-draft-v1' as const
export const WIZARD_DRAFT_KEY_V2 = 'gdc-stream-wizard-draft-v2' as const
export const WIZARD_DRAFT_VERSION = 2 as const

export type WizardDraftEnvelopeV2 = {
  version: typeof WIZARD_DRAFT_VERSION
  savedAt: number
  stepKey: WizardStepKey
  state: WizardState
}

type WizardDraftEnvelopeV1 = {
  savedAt?: number
  stepIndex?: number
  stepKey?: WizardLegacySubstepKey
  state?: Partial<WizardState>
}

/** Secret-bearing connector fields never persist in localStorage drafts. */
const SECRET_CONNECTOR_FIELDS = [
  'basicPassword',
  'bearerToken',
  'apiKeyValue',
  'oauthClientSecret',
  'loginPassword',
  'refreshToken',
] as const

const SENSITIVE_PARAM_NAMES = new Set([
  'api_key',
  'access_token',
  'client_secret',
  'token',
  'password',
  'bearer_token',
  'refresh_token',
  'secret',
  'private_key',
])

function isWizardStepKey(value: unknown): value is WizardStepKey {
  return typeof value === 'string' && (WIZARD_STEP_KEYS as readonly string[]).includes(value)
}

function normalizeDraftStepKey(stepKey: unknown): WizardStepKey {
  if (stepKey === 'data_protection' || stepKey === 'transform') return 'route_processing'
  return isWizardStepKey(stepKey) ? stepKey : 'connect'
}

function isSensitiveName(name: string): boolean {
  const key = name.toLowerCase().replace(/-/g, '_')
  if (SENSITIVE_PARAM_NAMES.has(key)) return true
  return key.includes('password') || key.includes('secret') || key.includes('token') || key.includes('api_key')
}

function scrubKvRows<T extends { key: string; value: string }>(rows: T[] | undefined): T[] {
  if (!Array.isArray(rows)) return []
  return rows.map((row) =>
    isSensitiveName(row.key) && row.value
      ? { ...row, value: '' }
      : row,
  )
}

function scrubRecordSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubRecordSecrets(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveName(k) && v != null && v !== '') {
        out[k] = ''
        continue
      }
      out[k] = scrubRecordSecrets(v)
    }
    return out
  }
  return value
}

/**
 * Whitelist-safe draft persistence: keep wizard progress, strip secrets and raw samples.
 * Applied on save and on load (migrates/scrubs legacy drafts).
 */
export function scrubWizardDraftState(state: WizardState): WizardState {
  const base = buildInitialState()
  const connector = { ...base.connector, ...state.connector }
  for (const field of SECRET_CONNECTOR_FIELDS) {
    connector[field] = ''
  }
  connector.commonHeaders = scrubKvRows(connector.commonHeaders)
  connector.loginHeaders = scrubRecordSecrets(connector.loginHeaders ?? {}) as Record<string, string>
  connector.schemaFormValues = scrubRecordSecrets(connector.schemaFormValues ?? {}) as Record<
    string,
    string | boolean | number
  >

  const stream = { ...base.stream, ...state.stream }
  stream.headers = scrubKvRows(stream.headers)
  stream.params = scrubKvRows(stream.params)

  const apiTest = {
    ...base.apiTest,
    ...state.apiTest,
    // Never persist raw response / sample material in browser storage.
    rawBody: null,
    parsedJson: null,
    rawResponse: null,
    extractedEvents: [],
    responseSample: null,
    responseHeaders: {},
    targetResponseBody: null,
    unionSchema: state.apiTest.unionSchema ?? null,
    eventCount: state.apiTest.eventCount ?? 0,
    analysis: state.apiTest.analysis
      ? {
          ...state.apiTest.analysis,
          sampleEvent: null,
        }
      : null,
    actualRequestSent: state.apiTest.actualRequestSent
      ? {
          ...state.apiTest.actualRequestSent,
          queryParams: scrubRecordSecrets(state.apiTest.actualRequestSent.queryParams ?? {}) as Record<
            string,
            unknown
          >,
          jsonBodyMasked: scrubRecordSecrets(state.apiTest.actualRequestSent.jsonBodyMasked),
        }
      : null,
  }

  return {
    ...base,
    ...state,
    connector,
    stream,
    apiTest,
    destinations: normalizeWizardDestinations(state.destinations),
    dataPolicy: { ...base.dataPolicy, ...state.dataPolicy },
    dataProtection: {
      ...base.dataProtection,
      ...state.dataProtection,
      unknownNormalFieldPolicy: normalizeUnknownNormalFieldPolicy(
        state.dataProtection?.unknownNormalFieldPolicy,
      ),
      unknownSensitiveFieldPolicy: normalizeUnknownSensitiveFieldPolicy(
        state.dataProtection?.unknownSensitiveFieldPolicy,
      ),
      intents: Array.isArray(state.dataProtection?.intents)
        ? state.dataProtection.intents.map((intent) => ({
            key: intent.key || `dp-${Math.random().toString(36).slice(2, 10)}`,
            detectedField: intent.detectedField ?? '',
            protectionAction: normalizeWizardProtectionAction(intent.protectionAction),
            deliveryBehavior: intent.deliveryBehavior ?? 'continue',
          }))
        : base.dataProtection.intents,
      routeOverrides: Array.isArray(state.dataProtection?.routeOverrides)
        ? state.dataProtection.routeOverrides.map((override) => normalizeWizardRouteProtectionOverride(override))
        : base.dataProtection.routeOverrides,
    },
    mapping: Array.isArray(state.mapping) ? state.mapping : base.mapping,
    enrichment: Array.isArray(state.enrichment) ? state.enrichment : base.enrichment,
    transformRules: Array.isArray(state.transformRules) ? state.transformRules : base.transformRules,
    unmappedFieldsPolicy:
      state.unmappedFieldsPolicy === 'drop_unmapped' ? 'drop_unmapped' : base.unmappedFieldsPolicy,
    outcome: state.outcome?.streamId == null ? state.outcome : null,
  }
}

function hydrateWizardState(raw: Partial<WizardState> | undefined): WizardState {
  const base = buildInitialState()
  if (!raw) return scrubWizardDraftState(base)
  return scrubWizardDraftState({
    ...base,
    ...raw,
    connector: { ...base.connector, ...raw.connector },
    stream: { ...base.stream, ...raw.stream },
    apiTest: { ...base.apiTest, ...raw.apiTest },
    destinations: normalizeWizardDestinations(raw.destinations),
    dataPolicy: { ...base.dataPolicy, ...raw.dataPolicy },
    dataProtection: {
      ...base.dataProtection,
      ...raw.dataProtection,
      unknownNormalFieldPolicy: normalizeUnknownNormalFieldPolicy(
        raw.dataProtection?.unknownNormalFieldPolicy,
      ),
      unknownSensitiveFieldPolicy: normalizeUnknownSensitiveFieldPolicy(
        raw.dataProtection?.unknownSensitiveFieldPolicy,
      ),
      intents: Array.isArray(raw.dataProtection?.intents)
        ? raw.dataProtection.intents.map((intent) => ({
            key: intent.key || `dp-${Math.random().toString(36).slice(2, 10)}`,
            detectedField: intent.detectedField ?? '',
            protectionAction: normalizeWizardProtectionAction(intent.protectionAction),
            deliveryBehavior: intent.deliveryBehavior ?? 'continue',
          }))
        : base.dataProtection.intents,
      routeOverrides: Array.isArray(raw.dataProtection?.routeOverrides)
        ? raw.dataProtection.routeOverrides.map((override) => normalizeWizardRouteProtectionOverride(override))
        : base.dataProtection.routeOverrides,
    },
    mapping: Array.isArray(raw.mapping) ? raw.mapping : base.mapping,
    enrichment: Array.isArray(raw.enrichment) ? raw.enrichment : base.enrichment,
    transformRules: Array.isArray(raw.transformRules) ? raw.transformRules : base.transformRules,
    unmappedFieldsPolicy:
      raw.unmappedFieldsPolicy === 'drop_unmapped' ? 'drop_unmapped' : base.unmappedFieldsPolicy,
  })
}

function stepKeyFromLegacyEnvelope(envelope: WizardDraftEnvelopeV1): WizardStepKey {
  if (typeof envelope.stepIndex === 'number' && Number.isFinite(envelope.stepIndex)) {
    return WIZARD_STEP_KEYS[migrateLegacyStepIndex(Math.max(0, Math.floor(envelope.stepIndex)))] ?? 'connect'
  }
  if (envelope.stepKey === 'connector' || envelope.stepKey === 'stream' || envelope.stepKey === 'api_test') {
    return 'connect'
  }
  if (envelope.stepKey === 'preview') return 'sample'
  if (envelope.stepKey === 'mapping' || envelope.stepKey === 'enrichment' || envelope.stepKey === 'data_protection') {
    return 'route_processing'
  }
  if (envelope.stepKey === 'destinations') return 'destinations'
  if (envelope.stepKey === 'review' || envelope.stepKey === 'done') return 'deploy'
  return 'connect'
}

function migrateV1Envelope(envelope: WizardDraftEnvelopeV1): WizardDraftEnvelopeV2 {
  return {
    version: WIZARD_DRAFT_VERSION,
    savedAt: envelope.savedAt ?? Date.now(),
    stepKey: stepKeyFromLegacyEnvelope(envelope),
    state: hydrateWizardState(envelope.state),
  }
}

export function parseWizardDraftV2(raw: string): WizardDraftEnvelopeV2 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WizardDraftEnvelopeV2> & WizardDraftEnvelopeV1
    if (parsed.version === WIZARD_DRAFT_VERSION && parsed.state) {
      return {
        version: WIZARD_DRAFT_VERSION,
        savedAt: parsed.savedAt ?? Date.now(),
        stepKey: normalizeDraftStepKey(parsed.stepKey),
        state: hydrateWizardState(parsed.state),
      }
    }
    if (parsed.state) {
      return migrateV1Envelope(parsed)
    }
    return null
  } catch {
    return null
  }
}

export function loadWizardDraft(): WizardDraftEnvelopeV2 | null {
  if (typeof localStorage === 'undefined') return null
  const v2Raw = localStorage.getItem(WIZARD_DRAFT_KEY_V2)
  if (v2Raw) {
    const parsed = parseWizardDraftV2(v2Raw)
    if (parsed) {
      // Rewrite legacy drafts that still contain secrets / raw samples.
      try {
        localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(parsed))
      } catch {
        /* ignore quota errors during scrub rewrite */
      }
      return parsed
    }
  }
  const v1Raw = localStorage.getItem(WIZARD_DRAFT_KEY_V1)
  if (!v1Raw) return null
  const migrated = parseWizardDraftV2(v1Raw)
  if (!migrated) return null
  try {
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(migrated))
    localStorage.removeItem(WIZARD_DRAFT_KEY_V1)
  } catch {
    /* ignore quota errors during migration */
  }
  return migrated
}

/** Strip creation outcome so drafts stay reusable for a new stream. */
export function stateForDraftPersistence(state: WizardState): WizardState {
  return scrubWizardDraftState(state.outcome?.streamId == null ? state : { ...state, outcome: null })
}

export function saveWizardDraft(state: WizardState, stepKey: WizardStepKey): void {
  const envelope: WizardDraftEnvelopeV2 = {
    version: WIZARD_DRAFT_VERSION,
    savedAt: Date.now(),
    stepKey,
    state: stateForDraftPersistence(state),
  }
  localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(envelope))
}

export function clearWizardDraft(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(WIZARD_DRAFT_KEY_V2)
  localStorage.removeItem(WIZARD_DRAFT_KEY_V1)
}

export function wizardStepIndexForKey(steps: ReadonlyArray<{ key: WizardStepKey }>, stepKey: WizardStepKey): number {
  const idx = steps.findIndex((s) => s.key === stepKey)
  return idx >= 0 ? idx : 0
}
