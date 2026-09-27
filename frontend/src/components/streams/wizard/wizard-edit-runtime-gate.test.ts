import { describe, expect, it } from 'vitest'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT, type WizardRouteDraft } from './wizard-state'
import {
  confirmDeliveryPanelServerFields,
  editRuntimeVerificationBlocked,
  mergeDeliveryPanelRouteDrafts,
  persistedWizardConfigSnapshot,
  shouldScheduleEditAutosave,
} from './wizard-edit-runtime-gate'

function routeDraft(partial: Partial<WizardRouteDraft> & Pick<WizardRouteDraft, 'key'>): WizardRouteDraft {
  return {
    destinationId: 1,
    enabled: true,
    failurePolicy: 'LOG_AND_CONTINUE',
    rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT },
    ...partial,
  }
}

describe('edit runtime save baselines', () => {
  it('does not autosave a confirmed draft or the same failed attempt, but does save a later edit', () => {
    expect(shouldScheduleEditAutosave('saved', 'saved', null)).toBe(false)
    expect(shouldScheduleEditAutosave('failed-draft', 'saved', 'failed-draft')).toBe(false)
    expect(shouldScheduleEditAutosave('corrected', 'saved', 'failed-draft')).toBe(true)
  })

  it('blocks runtime verification while dirty, saving, or failed, and allows it only when confirmed', () => {
    expect(
      editRuntimeVerificationBlocked({
        isSaving: false,
        saveFailed: false,
        persistErrorCount: 0,
        draftSnapshot: 'saved',
        confirmedSavedSnapshot: 'saved',
      }),
    ).toBe(false)
    expect(
      editRuntimeVerificationBlocked({
        isSaving: false,
        saveFailed: false,
        persistErrorCount: 0,
        draftSnapshot: 'dirty',
        confirmedSavedSnapshot: 'saved',
      }),
    ).toBe(true)
    expect(
      editRuntimeVerificationBlocked({
        isSaving: true,
        saveFailed: false,
        persistErrorCount: 0,
        draftSnapshot: 'saved',
        confirmedSavedSnapshot: 'saved',
      }),
    ).toBe(true)
    expect(
      editRuntimeVerificationBlocked({
        isSaving: false,
        saveFailed: true,
        persistErrorCount: 1,
        draftSnapshot: 'failed-draft',
        confirmedSavedSnapshot: 'saved',
      }),
    ).toBe(true)
  })

  it('ignores catalog, api test, and test-session fields when comparing persisted config', () => {
    const saved = buildInitialState()
    const noisy = buildInitialState()
    noisy.apiTest = { ...noisy.apiTest, rawBody: '{"ok":true}', statusCode: 200 }
    noisy.destinations = {
      ...noisy.destinations,
      destinationKindsById: { 5: 'WEBHOOK_POST' },
      destinationApiBacked: true,
    }
    noisy.stream = {
      ...noisy.stream,
      incrementalRequestTestedAt: 1_758_000_000_000,
    }
    expect(persistedWizardConfigSnapshot(noisy)).toBe(persistedWizardConfigSnapshot(saved))
    expect(shouldScheduleEditAutosave(persistedWizardConfigSnapshot(noisy), persistedWizardConfigSnapshot(saved), null)).toBe(false)

    const edited = buildInitialState()
    edited.stream = { ...edited.stream, name: 'Edited stream' }
    expect(shouldScheduleEditAutosave(persistedWizardConfigSnapshot(edited), persistedWizardConfigSnapshot(saved), null)).toBe(true)

    const previewOnly = buildInitialState()
    previewOnly.stream = { ...previewOnly.stream, incrementalRequestPattern: 'query_params', incrementalRequestDraft: 'cursor=1' }
    expect(persistedWizardConfigSnapshot(previewOnly)).toBe(persistedWizardConfigSnapshot(saved))
  })
})

describe('delivery panel refresh confirmation', () => {
  it('keeps local-only routes and pending removals dirty, and confirms only server delivery fields', () => {
    const localOverride = routeDraft({
      key: 'route-1',
      overrides: { transform: { rows: [] } } as WizardRouteDraft['overrides'],
    })
    const localOnly = routeDraft({ key: 'wr-new', destinationId: 9 })
    const confirmedRoute = routeDraft({ key: 'route-1' })
    const removed = routeDraft({ key: 'route-2', destinationId: 2 })
    const serverRoute = routeDraft({ key: 'route-1', enabled: false, updatedAt: 'token-2' })
    const serverRemoved = routeDraft({ key: 'route-2', destinationId: 2, enabled: true })

    const merged = mergeDeliveryPanelRouteDrafts(
      [localOverride, localOnly],
      [serverRoute, serverRemoved],
      [confirmedRoute, removed],
    )
    expect(merged.map((draft) => draft.key)).toEqual(['route-1', 'wr-new'])
    expect(merged[0]?.enabled).toBe(false)
    expect(merged[0]?.overrides).toBe(localOverride.overrides)

    const confirmed = buildInitialState()
    confirmed.destinations.routeDrafts = [confirmedRoute, removed]
    const nextConfirmed = confirmDeliveryPanelServerFields(confirmed, [serverRoute, serverRemoved])
    expect(nextConfirmed.destinations.routeDrafts[0]?.enabled).toBe(false)
    expect(nextConfirmed.destinations.routeDrafts[0]?.overrides).toBeUndefined()
    expect(nextConfirmed.destinations.routeDrafts.map((draft) => draft.key)).toEqual(['route-1', 'route-2'])

    const visible = buildInitialState()
    visible.destinations.routeDrafts = merged
    expect(persistedWizardConfigSnapshot(visible)).not.toBe(persistedWizardConfigSnapshot(nextConfirmed))
  })
})
