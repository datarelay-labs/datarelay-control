import type { WizardState } from './wizard-state'
import {
  hydrateWizardStateFromStream,
  refreshWizardDestinationsFromStream,
  type WizardDestinationsRefresh,
} from './wizard-stream-hydrate'

export type PersistConcern = 'stream' | 'mapping' | 'routes' | 'unconfirmed'

const READ_BACK_APPLIED =
  'Read back persisted state for the concerns that failed to save. Those changes are not shown as saved.'
const READ_BACK_UNCONFIRMED =
  'Failed changes were not reconstructed from the server and are not confirmed as saved.'
const READ_BACK_UNAVAILABLE =
  'Could not read back persisted state after the save error. This draft is not confirmed as saved.'

/**
 * Classify a real persist error string. Unknown and non-round-trippable concerns stay unconfirmed.
 * Do not treat an unknown error as a destination refresh.
 */
export function classifyPersistError(error: string): PersistConcern {
  const text = error.toLowerCase()
  if (text.includes('mapping-ui')) return 'mapping'
  if (text.includes('schema-drift')) return 'unconfirmed'
  if (
    text.includes('policy-rules') ||
    text.includes('classification-rules') ||
    text.includes('protection-rules')
  ) {
    return 'unconfirmed'
  }
  if (/\broute\b/.test(text) && /\b(protection|classification|policy|governance)\b/.test(text)) return 'unconfirmed'
  if (text.includes('governance persist') || text.includes('governance read-back')) return 'unconfirmed'
  if (/\broute\b/.test(text) || text.includes('delete route') || text.includes('destination')) return 'routes'
  if (text.includes('stream:') || text.includes('post /streams') || text.includes('template materialization')) {
    return 'stream'
  }
  return 'unconfirmed'
}

export function applyDestinationReadBack(state: WizardState, refresh: WizardDestinationsRefresh): WizardState {
  return {
    ...state,
    destinations: refresh.destinations,
    outcome: state.outcome
      ? {
          ...state.outcome,
          routeId: refresh.routeIds[0] ?? null,
          routeIds: refresh.routeIds,
        }
      : state.outcome,
  }
}

export function applyStreamReadBack(state: WizardState, hydrated: WizardState): WizardState {
  return {
    ...state,
    stream: hydrated.stream,
  }
}

export function applyMappingReadBack(state: WizardState, hydrated: WizardState): WizardState {
  return {
    ...state,
    mapping: hydrated.mapping,
    mappingMode: hydrated.mappingMode,
    fullEventJsonataExpression: hydrated.fullEventJsonataExpression,
    fullEventRegexConfigJson: hydrated.fullEventRegexConfigJson,
    unmappedFieldsPolicy: hydrated.unmappedFieldsPolicy,
    enrichment: hydrated.enrichment,
  }
}

export async function reconcileWizardAfterPartialPersist(
  streamId: number,
  state: WizardState,
  errors: string[],
  readers: {
    refreshDestinations?: (id: number) => Promise<WizardDestinationsRefresh | null>
    hydrateStream?: (id: number) => Promise<WizardState | null>
  } = {},
): Promise<{
  state: WizardState
  note: string | null
  readBack: 'applied' | 'unavailable' | 'none'
  appliedDestinations: boolean
  appliedStream: boolean
  appliedMapping: boolean
}> {
  const empty = {
    state,
    note: null,
    readBack: 'none' as const,
    appliedDestinations: false,
    appliedStream: false,
    appliedMapping: false,
  }
  if (errors.length === 0) return empty

  const concerns = new Set(errors.map((error) => classifyPersistError(error)))
  const refreshDestinations = readers.refreshDestinations ?? refreshWizardDestinationsFromStream
  const hydrateStream = readers.hydrateStream ?? hydrateWizardStateFromStream
  let next = state
  let appliedDestinations = false
  let appliedStream = false
  let appliedMapping = false
  let readerFailed = false
  const needsHydrate = concerns.has('stream') || concerns.has('mapping')
  const hydrated = needsHydrate ? await hydrateStream(streamId) : null
  if (needsHydrate && hydrated == null) readerFailed = true

  if (concerns.has('routes')) {
    const refreshed = await refreshDestinations(streamId)
    if (refreshed == null) readerFailed = true
    else {
      next = applyDestinationReadBack(next, refreshed)
      appliedDestinations = true
    }
  }
  if (concerns.has('stream') && hydrated) {
    next = applyStreamReadBack(next, hydrated)
    appliedStream = true
  }
  if (concerns.has('mapping') && hydrated) {
    next = applyMappingReadBack(next, hydrated)
    appliedMapping = true
  }

  const reconstructable = ['stream', 'mapping', 'routes'].filter((concern) => concerns.has(concern as PersistConcern))
  const reconstructed =
    (concerns.has('stream') ? appliedStream : true) &&
    (concerns.has('mapping') ? appliedMapping : true) &&
    (concerns.has('routes') ? appliedDestinations : true) &&
    reconstructable.length > 0
  const unconfirmed = concerns.has('unconfirmed') || readerFailed || (reconstructable.length > 0 && !reconstructed)
  const applied = appliedDestinations || appliedStream || appliedMapping
  const note = unconfirmed ? (readerFailed && !applied ? READ_BACK_UNAVAILABLE : READ_BACK_UNCONFIRMED) : applied ? READ_BACK_APPLIED : READ_BACK_UNCONFIRMED
  if (next.outcome && note) {
    next = { ...next, outcome: { ...next.outcome, reconciliationNote: note, errors } }
  }
  return {
    state: next,
    note,
    readBack: unconfirmed ? 'unavailable' : applied ? 'applied' : 'unavailable',
    appliedDestinations,
    appliedStream,
    appliedMapping,
  }
}
