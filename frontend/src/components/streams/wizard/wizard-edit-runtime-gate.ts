import type { WizardConfigState, WizardRouteDraft, WizardState } from './wizard-state'

const PERSISTED_STREAM_FIELDS = [
  'name',
  'httpMethod',
  'endpoint',
  'headers',
  'params',
  'requestBody',
  'pollingIntervalSec',
  'timeoutSec',
  'eventArrayPath',
  'eventRootPath',
  'useWholeResponseAsEvent',
  'checkpointFieldType',
  'checkpointSourcePath',
  'checkpointMode',
  'checkpointSecondaryPath',
  'schemaRootPath',
  'initialDelaySec',
  'paginationType',
  'paginationCursorParam',
  'paginationPageSize',
  'paginationMaxPages',
  'rateLimitPerMinute',
  'rateLimitBurst',
  'maxObjectsPerRun',
  'remoteDirectory',
  'filePattern',
  'remoteRecursive',
  'parserType',
  'maxFilesPerRun',
  'maxFileSizeMb',
  'encoding',
  'csvDelimiter',
  'lineEventField',
  'includeFileMetadata',
  'sqlQuery',
  'dbCheckpointColumn',
  'dbCheckpointMode',
  'incrementalRequestPattern',
  'incrementalRequestDraft',
  'recordSelectionMode',
] as const satisfies readonly (keyof WizardConfigState)[]

function persistedRouteDraft(draft: WizardRouteDraft) {
  return {
    key: draft.key,
    destinationId: draft.destinationId,
    enabled: draft.enabled,
    failurePolicy: draft.failurePolicy,
    rateLimitJson: draft.rateLimitJson,
    inherit: draft.inherit,
    overrides: draft.overrides ?? null,
    formatterConfig: draft.formatterConfig ?? null,
    messagePrefixEnabled: draft.messagePrefixEnabled ?? null,
    messagePrefixTemplate: draft.messagePrefixTemplate ?? null,
  }
}

/** Fields written by edit persistence. Catalog, preview, and test-session metadata are excluded. */
export function persistedWizardConfigSnapshot(state: WizardState): string {
  const stream: Record<string, unknown> = {}
  for (const key of PERSISTED_STREAM_FIELDS) stream[key] = state.stream[key]
  return JSON.stringify({
    sourceType: state.connector.sourceType,
    stream,
    mapping: state.mapping,
    mappingRawPayloadMode: state.mappingRawPayloadMode ?? null,
    mappingMode: state.mappingMode,
    fullEventJsonataExpression: state.fullEventJsonataExpression,
    fullEventRegexConfigJson: state.fullEventRegexConfigJson,
    transformRules: state.transformRules,
    unmappedFieldsPolicy: state.unmappedFieldsPolicy,
    enrichment: state.enrichment,
    enrichmentEnabled: state.enrichmentEnabled ?? null,
    enrichmentOverridePolicy: state.enrichmentOverridePolicy ?? null,
    enrichmentPassthrough: state.enrichmentPassthrough ?? null,
    destinations: {
      routeDrafts: state.destinations.routeDrafts.map(persistedRouteDraft),
      messagePrefixTemplate: state.destinations.messagePrefixTemplate,
      messagePrefixEnabledByDestinationId: state.destinations.messagePrefixEnabledByDestinationId,
    },
    dataProtection: {
      intents: state.dataProtection.intents,
      routeOverrides: state.dataProtection.routeOverrides,
      routeClassificationOverrides: state.dataProtection.routeClassificationOverrides,
      unknownNormalFieldPolicy: state.dataProtection.unknownNormalFieldPolicy,
      unknownSensitiveFieldPolicy: state.dataProtection.unknownSensitiveFieldPolicy,
    },
  })
}

/** Advance one persisted concern without treating unrelated draft fields as saved. */
export function replacePersistedConcernSnapshot(
  confirmedSnapshot: string,
  next: WizardState,
  concern: 'destinations' | 'stream' | 'dataProtection',
): string {
  let base: Record<string, unknown>
  try {
    base = JSON.parse(confirmedSnapshot) as Record<string, unknown>
  } catch {
    return persistedWizardConfigSnapshot(next)
  }
  const projected = JSON.parse(persistedWizardConfigSnapshot(next)) as Record<string, unknown>
  base[concern] = projected[concern]
  return JSON.stringify(base)
}

/** Confirmed baseline changes only after load or a successful persist. */
export function shouldScheduleEditAutosave(
  draftSnapshot: string,
  confirmedSavedSnapshot: string,
  failedAttemptSnapshot: string | null,
): boolean {
  if (draftSnapshot === confirmedSavedSnapshot) return false
  if (failedAttemptSnapshot != null && draftSnapshot === failedAttemptSnapshot) return false
  return true
}

/** Start and Run Now require the visible draft to match the last confirmed save. Stop stays separate. */
export function editRuntimeVerificationBlocked(input: {
  isSaving: boolean
  saveFailed: boolean
  persistErrorCount: number
  draftSnapshot: string
  confirmedSavedSnapshot: string
}): boolean {
  if (input.isSaving) return true
  if (input.saveFailed) return true
  if (input.persistErrorCount > 0) return true
  return input.draftSnapshot !== input.confirmedSavedSnapshot
}

function prefixMatches(local: WizardRouteDraft, confirmed: WizardRouteDraft | undefined): boolean {
  if (!confirmed) return false
  return (
    local.messagePrefixEnabled === confirmed.messagePrefixEnabled &&
    local.messagePrefixTemplate === confirmed.messagePrefixTemplate &&
    JSON.stringify(local.formatterConfig ?? null) === JSON.stringify(confirmed.formatterConfig ?? null)
  )
}

/**
 * Delivery-panel refresh keeps local-only drafts and pending removals.
 * Server delivery fields update the visible draft. Unsaved prefix state stays local.
 */
export function mergeDeliveryPanelRouteDrafts(
  local: readonly WizardRouteDraft[],
  server: readonly WizardRouteDraft[],
  confirmed: readonly WizardRouteDraft[],
): WizardRouteDraft[] {
  const localByKey = new Map(local.map((draft) => [draft.key, draft]))
  const confirmedByKey = new Map(confirmed.map((draft) => [draft.key, draft]))
  const serverKeys = new Set(server.map((draft) => draft.key))
  const merged: WizardRouteDraft[] = []
  for (const serverDraft of server) {
    const localDraft = localByKey.get(serverDraft.key)
    if (!localDraft) {
      if (confirmedByKey.has(serverDraft.key)) continue
      merged.push(serverDraft)
      continue
    }
    const keepLocalPrefix = !prefixMatches(localDraft, confirmedByKey.get(serverDraft.key))
    merged.push({
      ...localDraft,
      destinationId: serverDraft.destinationId,
      enabled: serverDraft.enabled,
      failurePolicy: serverDraft.failurePolicy,
      updatedAt: serverDraft.updatedAt ?? localDraft.updatedAt,
      ...(keepLocalPrefix
        ? {}
        : {
            formatterConfig: serverDraft.formatterConfig ?? localDraft.formatterConfig,
            messagePrefixEnabled: serverDraft.messagePrefixEnabled ?? localDraft.messagePrefixEnabled,
            messagePrefixTemplate: serverDraft.messagePrefixTemplate ?? localDraft.messagePrefixTemplate,
          }),
    })
  }
  for (const localDraft of local) {
    if (!serverKeys.has(localDraft.key)) merged.push(localDraft)
  }
  return merged
}

/** Confirmed destinations adopt only server delivery fields. Local overrides stay unconfirmed. */
export function confirmDeliveryPanelServerFields(
  confirmed: WizardState,
  serverDrafts: readonly WizardRouteDraft[],
): WizardState {
  const serverByKey = new Map(serverDrafts.map((draft) => [draft.key, draft]))
  const routeDrafts = confirmed.destinations.routeDrafts.map((draft) => {
    const server = serverByKey.get(draft.key)
    if (!server) return draft
    return {
      ...draft,
      destinationId: server.destinationId,
      enabled: server.enabled,
      failurePolicy: server.failurePolicy,
      updatedAt: server.updatedAt ?? draft.updatedAt,
      formatterConfig: server.formatterConfig ?? draft.formatterConfig,
      messagePrefixEnabled: server.messagePrefixEnabled ?? draft.messagePrefixEnabled,
      messagePrefixTemplate: server.messagePrefixTemplate ?? draft.messagePrefixTemplate,
    }
  })
  return { ...confirmed, destinations: { ...confirmed.destinations, routeDrafts } }
}
