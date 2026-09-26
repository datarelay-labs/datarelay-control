import { describe, expect, it } from 'vitest'
import { editRuntimeVerificationBlocked, shouldScheduleEditAutosave } from './wizard-edit-runtime-gate'

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
})
