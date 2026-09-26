import { describe, expect, it, vi } from 'vitest'
import { wizardCreateIsStartEligible } from './wizard-create-fail-closed'
import { buildInitialState, type WizardState } from './wizard-state'
import { classifyPersistError, reconcileWizardAfterPartialPersist } from './wizard-partial-save-reconcile'

function draftWithError(error: string): WizardState {
  const state = buildInitialState()
  state.stream = { ...state.stream, name: 'Draft name' }
  state.outcome = {
    streamId: 9,
    routeId: 1,
    routeIds: [1],
    mappingSaved: false,
    enrichmentSaved: false,
    dataProtectionSaved: false,
    governanceSaved: false,
    schemaDriftPolicySaved: false,
    schemaDriftPolicyWarnings: [],
    dataProtectionEnforcementIncomplete: false,
    dataProtectionWarnings: [],
    errors: [error],
    apiBacked: true,
    createdAt: '2026-09-26T00:00:00Z',
  }
  return state
}

describe('reconcileWizardAfterPartialPersist', () => {
  it('replaces route-backed destinations from the server and keeps Start blocked', async () => {
    const state = draftWithError('route 3: save failed')
    const server = buildInitialState()
    server.destinations = {
      ...server.destinations,
      routeDrafts: [
        {
          key: 'route-44',
          destinationId: 5,
          enabled: true,
          failurePolicy: 'LOG_AND_CONTINUE',
          rateLimitJson: {},
          inherit: { transform: true, protection: true, classification: true, policy: true },
        },
      ],
    }
    const result = await reconcileWizardAfterPartialPersist(9, state, state.outcome?.errors ?? [], {
      refreshDestinations: vi.fn(async () => ({ destinations: server.destinations, routeIds: [44] })),
      hydrateStream: vi.fn(async () => null),
    })
    expect(result.readBack).toBe('applied')
    expect(result.state.outcome?.routeIds).toEqual([44])
    expect(result.state.outcome?.errors).toEqual(['route 3: save failed'])
    expect(result.state.stream.name).toBe('Draft name')
    expect(wizardCreateIsStartEligible(result.state.outcome)).toBe(false)
    expect(result.note).toMatch(/not shown as saved/i)
  })

  it('copies only the stream section when the stream save fails', async () => {
    const state = draftWithError('stream: name rejected')
    const hydrated = buildInitialState()
    hydrated.stream = { ...hydrated.stream, name: 'Server name' }
    hydrated.mapping = [{ id: 'm1', outputField: 'a', sourceJsonPath: '$.a' }]
    const result = await reconcileWizardAfterPartialPersist(9, state, ['stream: name rejected'], {
      refreshDestinations: vi.fn(async () => null),
      hydrateStream: vi.fn(async () => hydrated),
    })
    expect(result.readBack).toBe('applied')
    expect(result.state.stream.name).toBe('Server name')
    expect(result.state.mapping).toEqual(state.mapping)
    expect(wizardCreateIsStartEligible(result.state.outcome)).toBe(false)
  })

  it('replaces global mapping from the server and does not treat that as a destination refresh', async () => {
    const state = draftWithError('mapping-ui: timeout')
    state.mapping = [{ id: 'draft', outputField: 'draft', sourceJsonPath: '$.draft' }]
    const hydrated = buildInitialState()
    hydrated.mapping = [{ id: 'server', outputField: 'server', sourceJsonPath: '$.server' }]
    hydrated.enrichment = []
    const refreshDestinations = vi.fn(async () => null)
    const result = await reconcileWizardAfterPartialPersist(9, state, ['mapping-ui: timeout'], {
      refreshDestinations,
      hydrateStream: vi.fn(async () => hydrated),
    })
    expect(refreshDestinations).not.toHaveBeenCalled()
    expect(result.appliedMapping).toBe(true)
    expect(result.state.mapping).toEqual(hydrated.mapping)
    expect(result.state.destinations).toEqual(state.destinations)
    expect(result.readBack).toBe('applied')
    expect(wizardCreateIsStartEligible(result.state.outcome)).toBe(false)
  })

  it('does not claim data protection or unknown errors were reconciled', async () => {
    const state = draftWithError('policy-rules (pii): denied')
    const refreshDestinations = vi.fn()
    const result = await reconcileWizardAfterPartialPersist(9, state, ['policy-rules (pii): denied', '$.email: skipped'], {
      refreshDestinations,
      hydrateStream: vi.fn(),
    })
    expect(refreshDestinations).not.toHaveBeenCalled()
    expect(result.readBack).toBe('unavailable')
    expect(result.appliedDestinations).toBe(false)
    expect(result.state.stream.name).toBe('Draft name')
    expect(result.note).toMatch(/not confirmed as saved/i)
    expect(wizardCreateIsStartEligible(result.state.outcome)).toBe(false)
  })

  it.each([
    ['stream: name rejected', 'stream'],
    ['mapping-ui: timeout', 'mapping'],
    ['route 3: save failed', 'routes'],
    ['route 9 mapping: no', 'routes'],
    ['schema-drift-policy: no', 'unconfirmed'],
    ['policy-rules (pii): no', 'unconfirmed'],
    ['classification-rules (secret): no', 'unconfirmed'],
    ['protection-rules: no', 'unconfirmed'],
    ['route 4 policy: governance read-back still has delivery_behavior=drop', 'unconfirmed'],
    ['$.email: already has a runtime protection rule. Wizard rule was skipped.', 'unconfirmed'],
    ['something unexpected', 'unconfirmed'],
  ] as const)('classifies %s as %s', (error, concern) => {
    expect(classifyPersistError(error)).toBe(concern)
  })

  it('keeps the draft and says read-back is unavailable when the server read fails', async () => {
    const state = draftWithError('mapping-ui: timeout')
    const result = await reconcileWizardAfterPartialPersist(9, state, ['mapping-ui: timeout'], {
      refreshDestinations: vi.fn(async () => null),
      hydrateStream: vi.fn(),
    })
    expect(result.readBack).toBe('unavailable')
    expect(result.state.stream.name).toBe('Draft name')
    expect(result.state.outcome?.routeIds).toEqual([1])
    expect(result.note).toMatch(/not confirmed as saved/i)
    expect(wizardCreateIsStartEligible(result.state.outcome)).toBe(false)
  })
})
