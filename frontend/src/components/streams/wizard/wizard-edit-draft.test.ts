import { beforeEach, describe, expect, it } from 'vitest'
import { buildInitialState } from './wizard-state'
import {
  clearStreamEditDraft,
  loadStreamEditDraft,
  restoreStreamEditDraft,
  saveStreamEditDraft,
  streamEditDraftStorageKey,
} from './wizard-edit-draft'

describe('stream edit local draft', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores one sanitized draft per Stream without raw samples or credentials', () => {
    const state = buildInitialState()
    state.streamUpdatedAt = '2026-10-14T07:00:00Z'
    state.stream.name = 'Local draft name'
    state.connector.bearerToken = 'NEVER_PERSIST_EDIT_TOKEN'
    state.apiTest.rawResponse = { secret: 'NEVER_PERSIST_RAW_SAMPLE' }
    state.apiTest.parsedJson = { secret: 'NEVER_PERSIST_PARSED_SAMPLE' }

    saveStreamEditDraft(10, state, 'route_processing')

    const raw = localStorage.getItem(streamEditDraftStorageKey(10))
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('NEVER_PERSIST_EDIT_TOKEN')
    expect(raw).not.toContain('NEVER_PERSIST_RAW_SAMPLE')
    expect(raw).not.toContain('NEVER_PERSIST_PARSED_SAMPLE')
    expect(localStorage.getItem(streamEditDraftStorageKey(11))).toBeNull()

    const loaded = loadStreamEditDraft(10)
    expect(loaded?.stepKey).toBe('route_processing')
    expect(loaded?.state.stream.name).toBe('Local draft name')
    expect(loaded?.state.connector.bearerToken).toBe('')
    expect(loaded?.state.apiTest.rawResponse).toBeNull()
  })

  it('restores only against the exact authoritative saved revision', () => {
    const authoritative = buildInitialState()
    authoritative.streamUpdatedAt = 'saved-revision-a'
    authoritative.stream.name = 'Server name'
    authoritative.connector.connectorId = 77

    const draft = buildInitialState()
    draft.streamUpdatedAt = 'saved-revision-a'
    draft.stream.name = 'Pending local name'
    draft.connector.connectorId = 12
    const envelope = saveStreamEditDraft(10, draft, 'connect')

    const restored = restoreStreamEditDraft(authoritative, envelope)
    expect(restored?.stream.name).toBe('Pending local name')
    expect(restored?.connector.connectorId).toBe(77)
    expect(restored?.streamUpdatedAt).toBe('saved-revision-a')

    authoritative.streamUpdatedAt = 'saved-revision-b'
    expect(restoreStreamEditDraft(authoritative, envelope)).toBeNull()
  })

  it('clears only the requested Stream draft', () => {
    const state = buildInitialState()
    saveStreamEditDraft(10, state, 'connect')
    saveStreamEditDraft(11, state, 'sample')

    clearStreamEditDraft(10)

    expect(loadStreamEditDraft(10)).toBeNull()
    expect(loadStreamEditDraft(11)?.stepKey).toBe('sample')
  })
})
