import { scrubWizardDraftState } from './wizard-draft-migration'
import type { WizardState, WizardStepKey } from './wizard-state'

const STREAM_EDIT_DRAFT_VERSION = 1 as const
const STREAM_EDIT_DRAFT_KEY_PREFIX = 'gdc-stream-edit-draft-v1:' as const

export type StreamEditDraftEnvelope = {
  version: typeof STREAM_EDIT_DRAFT_VERSION
  streamId: number
  baseStreamUpdatedAt: string | null
  savedAt: number
  stepKey: WizardStepKey
  state: WizardState
}

function normalizeRevision(value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

export function streamEditDraftStorageKey(streamId: number): string {
  return STREAM_EDIT_DRAFT_KEY_PREFIX + String(streamId)
}

export function saveStreamEditDraft(
  streamId: number,
  state: WizardState,
  stepKey: WizardStepKey,
): StreamEditDraftEnvelope {
  const envelope: StreamEditDraftEnvelope = {
    version: STREAM_EDIT_DRAFT_VERSION,
    streamId,
    baseStreamUpdatedAt: normalizeRevision(state.streamUpdatedAt),
    savedAt: Date.now(),
    stepKey,
    state: scrubWizardDraftState(state),
  }
  localStorage.setItem(streamEditDraftStorageKey(streamId), JSON.stringify(envelope))
  return envelope
}

export function loadStreamEditDraft(streamId: number): StreamEditDraftEnvelope | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(streamEditDraftStorageKey(streamId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StreamEditDraftEnvelope>
    if (
      parsed.version !== STREAM_EDIT_DRAFT_VERSION ||
      parsed.streamId !== streamId ||
      typeof parsed.savedAt !== 'number' ||
      !parsed.state ||
      typeof parsed.stepKey !== 'string'
    ) {
      return null
    }
    return {
      version: STREAM_EDIT_DRAFT_VERSION,
      streamId,
      baseStreamUpdatedAt: normalizeRevision(parsed.baseStreamUpdatedAt),
      savedAt: parsed.savedAt,
      stepKey: parsed.stepKey as WizardStepKey,
      state: scrubWizardDraftState(parsed.state as WizardState),
    }
  } catch {
    return null
  }
}

export function clearStreamEditDraft(streamId: number): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(streamEditDraftStorageKey(streamId))
}

export function restoreStreamEditDraft(
  authoritative: WizardState,
  envelope: StreamEditDraftEnvelope,
): WizardState | null {
  if (normalizeRevision(authoritative.streamUpdatedAt) !== envelope.baseStreamUpdatedAt) return null
  return {
    ...authoritative,
    ...envelope.state,
    // The server load owns identity and source credentials. Browser drafts never replace them.
    connector: authoritative.connector,
    streamUpdatedAt: authoritative.streamUpdatedAt,
    outcome: authoritative.outcome,
  }
}
