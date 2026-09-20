import { describe, expect, it } from 'vitest'
import {
  legacySubstepToWizardStep,
  migrateLegacyStepIndex,
  normalizeWizardProtectionAction,
  WIZARD_STEPS,
  computeLegacySubstepCompletion,
  computeStepCompletion,
  buildInitialState,
} from './wizard-state'
import {
  parseWizardDraftV2,
  loadWizardDraft,
  WIZARD_DRAFT_KEY_V1,
  WIZARD_DRAFT_KEY_V2,
  WIZARD_DRAFT_VERSION,
  saveWizardDraft,
  clearWizardDraft,
  stateForDraftPersistence,
} from './wizard-draft-migration'

describe('wizard-state v5.2 WIZARD_STEPS', () => {
  it('exposes 5 top-level stepper keys in Destination First order', () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual([
      'connect',
      'sample',
      'destinations',
      'route_processing',
      'deploy',
    ])
  })
})

describe('legacySubstepToWizardStep', () => {
  it('maps legacy substeps to v5.2 steps', () => {
    expect(legacySubstepToWizardStep('connector')).toBe('connect')
    expect(legacySubstepToWizardStep('api_test')).toBe('connect')
    expect(legacySubstepToWizardStep('preview')).toBe('sample')
    expect(legacySubstepToWizardStep('mapping')).toBe('route_processing')
    expect(legacySubstepToWizardStep('enrichment')).toBe('route_processing')
    expect(legacySubstepToWizardStep('data_protection')).toBe('route_processing')
    expect(legacySubstepToWizardStep('destinations')).toBe('destinations')
    expect(legacySubstepToWizardStep('review')).toBe('deploy')
    expect(legacySubstepToWizardStep('done')).toBe('deploy')
  })
})

describe('migrateLegacyStepIndex', () => {
  it('maps legacy 9-step indices to v5.2 5-step indices', () => {
    expect(migrateLegacyStepIndex(0)).toBe(0)
    expect(migrateLegacyStepIndex(2)).toBe(0)
    expect(migrateLegacyStepIndex(3)).toBe(1)
    expect(migrateLegacyStepIndex(4)).toBe(3)
    expect(migrateLegacyStepIndex(6)).toBe(3)
    expect(migrateLegacyStepIndex(7)).toBe(2)
    expect(migrateLegacyStepIndex(8)).toBe(4)
  })
})

describe('computeStepCompletion v3 aggregation', () => {
  it('aggregates legacy substeps into five top-level steps', () => {
    const state = buildInitialState()
    const finishedAt = Date.now()
    state.connector.connectorId = 1
    state.connector.sourceId = 2
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.parsedJson = { id: 'evt-1' }
    state.apiTest.finishedAt = finishedAt
    state.apiTest.eventCount = 1
    state.stream.useWholeResponseAsEvent = true
    state.stream.checkpointSourcePath = '$.ts'
    state.stream.recordPathConfirmedForApiTestAt = finishedAt
    state.stream.checkpointConfirmedForApiTestAt = finishedAt
    state.mapping = [{ id: 'm1', outputField: 'id', sourceJsonPath: '$.id' }]

    const legacy = computeLegacySubstepCompletion(state)
    const v3 = computeStepCompletion(state)

    expect(legacy.connector).toBe('complete')
    expect(v3.connect).toBe('complete')
    expect(v3.sample).toBe('complete')
    expect(v3.destinations).toBe('in_progress')
    expect(v3.route_processing).toBe('in_progress')
  })
})

describe('wizard-draft-migration', () => {
  it('migrates v1 draft envelope to v2 with stepKey', () => {
    const state = buildInitialState()
    state.stream.name = 'Draft stream'
    const v1 = JSON.stringify({
      savedAt: 1,
      stepIndex: 4,
      state,
    })
    const parsed = parseWizardDraftV2(v1)
    expect(parsed?.version).toBe(WIZARD_DRAFT_VERSION)
    expect(parsed?.stepKey).toBe('route_processing')
    expect(parsed?.state.stream.name).toBe('Draft stream')
  })

  it('reads v2 draft envelope directly', () => {
    const state = buildInitialState()
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'sample',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.stepKey).toBe('sample')
  })

  it('migrates legacy stepIndex 6 to route_processing (includes former data protection step)', () => {
    const state = buildInitialState()
    const v1 = JSON.stringify({
      savedAt: 1,
      stepIndex: 6,
      state,
    })
    const parsed = parseWizardDraftV2(v1)
    expect(parsed?.stepKey).toBe('route_processing')
  })

  it('migrates v2 drafts saved on data_protection to route_processing', () => {
    const state = buildInitialState()
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'data_protection',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.stepKey).toBe('route_processing')
  })

  it('migrates v2 drafts saved on transform to route_processing', () => {
    const state = buildInitialState()
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'transform',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.stepKey).toBe('route_processing')
  })

  it('normalizes legacy remove protection action to drop_field when hydrating draft', () => {
    const state = buildInitialState()
    state.dataProtection.intents = [
      {
        key: 'legacy-remove',
        detectedField: '$.ssn',
        protectionAction: 'remove' as never,
        deliveryBehavior: 'quarantine',
      },
    ]
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'route_processing',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.state.dataProtection.intents[0]?.protectionAction).toBe('drop_field')
  })

  it('normalizeWizardProtectionAction maps remove to drop_field', () => {
    expect(normalizeWizardProtectionAction('remove')).toBe('drop_field')
  })

  it('does not persist outcome.streamId into reusable draft', () => {
    const state = buildInitialState()
    state.outcome = {
      streamId: 42,
      routeId: 1,
      routeIds: [1],
      mappingSaved: true,
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
    localStorage.setItem('gdc-stream-wizard-draft-v2', '')
    saveWizardDraft(state, 'deploy')
    const raw = localStorage.getItem(WIZARD_DRAFT_KEY_V2)
    expect(raw).toBeTruthy()
    const parsed = parseWizardDraftV2(raw!)
    expect(parsed?.state.outcome?.streamId ?? null).toBeNull()
  })

  it('stateForDraftPersistence strips stream creation outcome', () => {
    const state = buildInitialState()
    state.outcome = {
      streamId: 99,
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
    expect(stateForDraftPersistence(state).outcome).toBeNull()
  })

  it('clearWizardDraft removes v1 and v2 keys', () => {
    localStorage.setItem(WIZARD_DRAFT_KEY_V1, '{}')
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, '{}')
    clearWizardDraft()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V1)).toBeNull()
    expect(localStorage.getItem(WIZARD_DRAFT_KEY_V2)).toBeNull()
  })

  it('exports stable draft key constants', () => {
    expect(WIZARD_DRAFT_KEY_V1).toBe('gdc-stream-wizard-draft-v1')
    expect(migrateLegacyStepIndex(7)).toBe(2)
  })

  it('restores schema drift policy fields from draft', () => {
    const state = buildInitialState()
    state.dataProtection.unknownNormalFieldPolicy = 'require_review'
    state.dataProtection.unknownSensitiveFieldPolicy = 'quarantine'
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'route_processing',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.state.dataProtection.unknownNormalFieldPolicy).toBe('require_review')
    expect(parsed?.state.dataProtection.unknownSensitiveFieldPolicy).toBe('quarantine')
  })

  it('defaults missing schema drift policy fields when hydrating draft', () => {
    const state = buildInitialState()
    delete (state.dataProtection as { unknownNormalFieldPolicy?: string }).unknownNormalFieldPolicy
    delete (state.dataProtection as { unknownSensitiveFieldPolicy?: string }).unknownSensitiveFieldPolicy
    const v2 = JSON.stringify({
      version: WIZARD_DRAFT_VERSION,
      savedAt: 2,
      stepKey: 'route_processing',
      state,
    })
    const parsed = parseWizardDraftV2(v2)
    expect(parsed?.state.dataProtection.unknownNormalFieldPolicy).toBe('pass_through')
    expect(parsed?.state.dataProtection.unknownSensitiveFieldPolicy).toBe('auto_protect')
  })

  it('restores routeOverrides from draft', () => {
    const state = buildInitialState()
    state.dataProtection.routeOverrides = [
      {
        key: 'o1',
        fieldPath: '$.email',
        routeDraftKey: 'r1',
        protectionAction: 'tokenize',
        deliveryBehavior: 'continue',
        enabled: true,
      },
    ]
    saveWizardDraft(state, 'route_processing')
    const loaded = parseWizardDraftV2(localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? '')
    expect(loaded?.state.dataProtection.routeOverrides).toHaveLength(1)
    expect(loaded?.state.dataProtection.routeOverrides[0]).toMatchObject({
      fieldPath: '$.email',
      routeDraftKey: 'r1',
      protectionAction: 'tokenize',
    })
  })

  it('scrubs secrets and raw samples from browser drafts on save and load', () => {
    const state = buildInitialState()
    state.connector.bearerToken = 'wizard-bearer-secret'
    state.connector.apiKeyValue = 'wizard-api-key-secret'
    state.connector.basicPassword = 'wizard-basic-pass'
    state.connector.oauthClientSecret = 'wizard-oauth-secret'
    state.connector.loginPassword = 'wizard-login-pass'
    state.connector.refreshToken = 'wizard-refresh-secret'
    state.stream.params = [{ id: 'p1', key: 'api_key', value: 'query-secret' }]
    state.apiTest.rawBody = '{"token":"raw-body-secret"}'
    state.apiTest.parsedJson = { access_token: 'parsed-secret' }
    state.apiTest.rawResponse = { password: 'raw-response-secret' }
    state.apiTest.extractedEvents = [{ token: 'event-secret' }]
    state.apiTest.responseSample = { client_secret: 'sample-secret' }
    state.apiTest.analysis = {
      responseSummary: {
        root_type: 'object',
        approx_size_bytes: 1,
        top_level_keys: [],
        item_count_root: null,
        truncation: null,
      },
      detectedArrays: [],
      detectedCheckpointCandidates: [],
      sampleEvent: { token: 'analysis-sample-secret' },
      selectedEventArrayDefault: null,
      flatPreviewFields: [],
      previewError: null,
    }

    saveWizardDraft(state, 'connect')
    const raw = localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? ''
    expect(raw).not.toContain('wizard-bearer-secret')
    expect(raw).not.toContain('wizard-api-key-secret')
    expect(raw).not.toContain('query-secret')
    expect(raw).not.toContain('raw-body-secret')
    expect(raw).not.toContain('parsed-secret')
    expect(raw).not.toContain('event-secret')
    expect(raw).not.toContain('analysis-sample-secret')

    const loaded = parseWizardDraftV2(raw)
    expect(loaded?.state.connector.bearerToken).toBe('')
    expect(loaded?.state.connector.apiKeyValue).toBe('')
    expect(loaded?.state.stream.params[0]?.value).toBe('')
    expect(loaded?.state.apiTest.rawBody).toBeNull()
    expect(loaded?.state.apiTest.parsedJson).toBeNull()
    expect(loaded?.state.apiTest.rawResponse).toBeNull()
    expect(loaded?.state.apiTest.extractedEvents).toEqual([])
    expect(loaded?.state.apiTest.responseSample).toBeNull()
    expect(loaded?.state.apiTest.analysis?.sampleEvent).toBeNull()
  })

  it('scrubs legacy drafts that still contain secrets on load', () => {
    const legacy = {
      version: WIZARD_DRAFT_VERSION,
      savedAt: 1,
      stepKey: 'connect' as const,
      state: {
        ...buildInitialState(),
        connector: {
          ...buildInitialState().connector,
          bearerToken: 'legacy-draft-secret',
        },
        apiTest: {
          ...buildInitialState().apiTest,
          rawBody: 'legacy-raw-body',
          extractedEvents: [{ id: 1 }],
        },
      },
    }
    localStorage.setItem(WIZARD_DRAFT_KEY_V2, JSON.stringify(legacy))
    const loaded = loadWizardDraft()
    expect(loaded?.state.connector.bearerToken).toBe('')
    expect(loaded?.state.apiTest.rawBody).toBeNull()
    expect(loaded?.state.apiTest.extractedEvents).toEqual([])
    const rewritten = localStorage.getItem(WIZARD_DRAFT_KEY_V2) ?? ''
    expect(rewritten).not.toContain('legacy-draft-secret')
    expect(rewritten).not.toContain('legacy-raw-body')
  })
})
