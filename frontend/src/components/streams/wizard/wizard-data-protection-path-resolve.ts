import { runEnrichmentExecPreview, runTransformPreview } from '../../../api/gdcRuntimePreview'
import { parseFullEventRegexConfigText } from './wizard-full-event-regex-config'
import { runWizardLocalTransformPreview } from './wizard-full-event-preview'
import { flattenSampleFields } from './wizard-json-extract'
import { resolveJsonPath } from '../mapping-jsonpath'
import { buildMappedBaseFromState } from './wizard-review-preview'
import {
  buildWizardFieldMappingsPayload,
  enrichmentDictFromRows,
  type WizardState,
} from './wizard-state'

export type ProtectionPathResolveResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; error: string }

export function normalizeProtectionJsonPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('$') ? trimmed : `$.${trimmed}`
}

function leafSegment(fieldPath: string): string {
  const normalized = normalizeProtectionJsonPath(fieldPath)
  const leaf = normalized.split('.').pop() ?? normalized
  return leaf.replace(/\[\d+\]/g, '').replace(/^\$\.?/, '').toLowerCase()
}

export function collectRuntimeEventFieldPaths(event: Record<string, unknown> | null): string[] {
  if (!event) return []
  return flattenSampleFields(event)
}

export function pathExistsOnEvent(event: Record<string, unknown>, fieldPath: string): boolean {
  const normalized = normalizeProtectionJsonPath(fieldPath)
  if (!normalized || normalized === '$') return false
  const value = resolveJsonPath(event, normalized)
  return value !== undefined
}

/** Mapping source → enriched output aliases for deploy-time path resolution. */
export function buildProtectionPathAliasMap(state: WizardState): Map<string, string> {
  const aliases = new Map<string, string>()

  if (state.mappingMode === 'basic_jsonpath') {
    for (const row of state.mapping) {
      const source = normalizeProtectionJsonPath(row.sourceJsonPath)
      const outputField = row.outputField.trim()
      if (!source || !outputField) continue
      aliases.set(source, normalizeProtectionJsonPath(outputField))
    }
    for (const rule of state.transformRules) {
      if (rule.mode !== 'regex_extract') continue
      const source = normalizeProtectionJsonPath(rule.sourcePath)
      const output = normalizeProtectionJsonPath(rule.outputField)
      if (source && output) aliases.set(source, output)
    }
  }

  if (state.mappingMode === 'full_event_regex') {
    const parsed = parseFullEventRegexConfigText(state.fullEventRegexConfigJson)
    if (parsed.ok) {
      for (const rule of parsed.config.rules) {
        const source = normalizeProtectionJsonPath(rule.source_path)
        const output = normalizeProtectionJsonPath(rule.output_field)
        if (source && output) aliases.set(source, output)
      }
    }
  }

  for (const rule of state.enrichment) {
    if (!rule.enabled) continue
    const target = rule.fieldName.trim()
    if (!target) continue
    const targetPath = normalizeProtectionJsonPath(target)
    if (rule.type === 'normalize') {
      const sourceField = rule.normalizeSourceField.trim()
      if (sourceField) {
        aliases.set(normalizeProtectionJsonPath(sourceField), targetPath)
      }
    }
  }

  return aliases
}

export function resolveProtectionFieldPath(
  selectedPath: string,
  runtimePaths: readonly string[],
  aliasMap: ReadonlyMap<string, string>,
): ProtectionPathResolveResult {
  const normalized = normalizeProtectionJsonPath(selectedPath)
  if (!normalized) {
    return { ok: false, error: 'Protection field path is required.' }
  }

  const pathSet = new Set(runtimePaths.map(normalizeProtectionJsonPath))

  if (pathSet.has(normalized)) {
    return { ok: true, resolvedPath: normalized }
  }

  const aliased = aliasMap.get(normalized)
  if (aliased && pathSet.has(aliased)) {
    return { ok: true, resolvedPath: aliased }
  }

  const leaf = leafSegment(normalized)
  const leafMatches = [...pathSet].filter((path) => leafSegment(path) === leaf)
  if (leafMatches.length === 1) {
    return { ok: true, resolvedPath: leafMatches[0]! }
  }
  if (leafMatches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous protection path ${normalized}; matches: ${leafMatches.join(', ')}`,
    }
  }

  return {
    ok: false,
    error: `Protection path ${normalized} does not exist on the runtime enriched event.`,
  }
}

function firstWizardSampleEvent(state: WizardState): Record<string, unknown> | null {
  const sample = state.apiTest.extractedEvents[0] ?? state.apiTest.analysis?.sampleEvent ?? null
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null
  return sample as Record<string, unknown>
}

/** Field paths of the raw loaded sample event (before mapping/enrichment). */
export function collectWizardSamplePaths(state: WizardState): string[] {
  return collectRuntimeEventFieldPaths(firstWizardSampleEvent(state))
}

// Without strictNullChecks a truthiness check does not narrow this union; compare to false.
function isAmbiguousPathResult(result: ProtectionPathResolveResult): boolean {
  return result.ok === false && result.error.startsWith('Ambiguous')
}

/**
 * Resolve a protection field against the preview-derived runtime paths first, then fall back to the
 * paths the Data Protection step itself offered (mapping applied synchronously) and finally to the raw
 * loaded sample. The preview call can fail or return nothing while the sample and mapping clearly
 * contain the field; that must not reject a path the user picked from the loaded sample (F-149).
 */
export function resolveProtectionFieldPathWithFallbacks(
  selectedPath: string,
  runtimePaths: readonly string[],
  fallbackPathSets: ReadonlyArray<readonly string[]>,
  aliasMap: ReadonlyMap<string, string>,
): ProtectionPathResolveResult {
  let result = resolveProtectionFieldPath(selectedPath, runtimePaths, aliasMap)
  if (result.ok || isAmbiguousPathResult(result)) return result
  for (const paths of fallbackPathSets) {
    if (paths.length === 0) continue
    const attempt = resolveProtectionFieldPath(selectedPath, paths, aliasMap)
    if (attempt.ok || isAmbiguousPathResult(attempt)) return attempt
    result = attempt
  }
  const known = runtimePaths.length > 0 || fallbackPathSets.some((paths) => paths.length > 0)
  if (!known) {
    return {
      ok: false,
      error: `Protection path ${normalizeProtectionJsonPath(selectedPath)} cannot be checked because no sample event is loaded. Load a sample (API test / Data Sample step) so the path can be verified.`,
    }
  }
  return result
}

/**
 * Cheap pre-write check: protection paths that are definitively absent from every known sample/mapping
 * path set. Returns no errors when no sample is available (the persist step reports that case itself).
 */
export async function precheckWizardProtectionPaths(state: WizardState): Promise<string[]> {
  const fieldIntents = state.dataProtection.intents.filter(
    (intent) => intent.detectedField.trim() && intent.protectionAction !== 'audit',
  )
  if (fieldIntents.length === 0) return []
  const mappedPaths = collectWizardProtectionFieldCandidatesSync(state)
  const samplePaths = collectWizardSamplePaths(state)
  if (mappedPaths.length === 0 && samplePaths.length === 0) return []
  const enriched = await buildWizardEnrichedEventForProtection(state)
  const aliasMap = buildProtectionPathAliasMap(state)
  const errors: string[] = []
  for (const intent of fieldIntents) {
    const result = resolveProtectionFieldPathWithFallbacks(
      intent.detectedField,
      enriched.paths,
      [mappedPaths, samplePaths],
      aliasMap,
    )
    if (result.ok === false) errors.push(`data-protection: ${intent.detectedField}: ${result.error}`)
  }
  return errors
}

async function buildMappedEventForProtection(state: WizardState): Promise<Record<string, unknown>> {
  const sample = state.apiTest.extractedEvents[0] ?? state.apiTest.analysis?.sampleEvent ?? null
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    return {}
  }

  const fieldMappings = buildWizardFieldMappingsPayload(state)
  if (Object.keys(fieldMappings).length === 0) {
    return buildMappedBaseFromState(sample as Record<string, unknown>, state.mapping)
  }

  try {
    const preview = await runTransformPreview({
      stage: 'mapping',
      sample_event: sample as Record<string, unknown>,
      field_mappings: fieldMappings,
    })
    if (preview.save_blocked || preview.errors.length > 0) return {}
    const transformed = preview.transformed_result
    return transformed && typeof transformed === 'object' && !Array.isArray(transformed)
      ? (transformed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Final enriched event used for protection path resolution (matches runtime namespace). */
export async function buildWizardEnrichedEventForProtection(
  state: WizardState,
): Promise<{ event: Record<string, unknown>; paths: string[]; error?: string }> {
  const mapped = await buildMappedEventForProtection(state)
  const enrichmentPayload = enrichmentDictFromRows(state.enrichment, {
    advancedPassthrough: state.enrichmentPassthrough,
  })

  if (state.enrichmentEnabled === false || Object.keys(enrichmentPayload).length === 0) {
    return {
      event: mapped,
      paths: collectRuntimeEventFieldPaths(mapped),
    }
  }

  try {
    const preview = await runEnrichmentExecPreview({
      mapped_event: mapped,
      enrichment: enrichmentPayload,
      override_policy: state.enrichmentOverridePolicy ?? 'KEEP_EXISTING',
    })
    const finalEvent = preview.final_event ?? mapped
    const fieldErrors = preview.field_errors ?? []
    return {
      event: finalEvent,
      paths: collectRuntimeEventFieldPaths(finalEvent),
      ...(fieldErrors.length > 0
        ? {
            error: fieldErrors
              .map((item) => `${item.output_field || item.rule_id || 'field'}: ${item.error_message}`)
              .join(' · '),
          }
        : {}),
    }
  } catch (err) {
    return {
      event: mapped,
      paths: collectRuntimeEventFieldPaths(mapped),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function collectWizardProtectionFieldCandidatesSync(state: WizardState): string[] {
  const mapped = buildWizardProtectionMappedEventSync(state)
  if (!mapped) return []
  return collectRuntimeEventFieldPaths(mapped)
}

function buildWizardProtectionMappedEventSync(state: WizardState): Record<string, unknown> | null {
  const sample = state.apiTest.extractedEvents[0] ?? state.apiTest.analysis?.sampleEvent ?? null
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null

  let mapped: Record<string, unknown>
  if (state.mappingMode === 'full_event_regex') {
    const parsed = parseFullEventRegexConfigText(state.fullEventRegexConfigJson)
    if (!parsed.ok) return null
    const preview = runWizardLocalTransformPreview(sample as Record<string, unknown>, {
      isExpert: true,
      regexConfig: parsed.config,
    })
    mapped = preview.transformed_result ?? {}
  } else if (state.mappingMode === 'full_event_jsonata') {
    // Full-event JSONata cannot be executed synchronously in the UI. Keep only known configured outputs.
    mapped = {}
  } else {
    mapped = buildMappedBaseFromState(sample as Record<string, unknown>, state.mapping)
    for (const rule of state.transformRules) {
      const output = rule.outputField.trim()
      if (output && !(output in mapped)) mapped[output] = null
    }
  }

  if (state.enrichmentEnabled !== false) for (const rule of state.enrichment) {
    if (!rule.enabled) continue
    const key = rule.fieldName.trim()
    if (!key) continue
    const segments = key.split('.')
    let cur: Record<string, unknown> = mapped
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!
      const next = cur[seg]
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        cur[seg] = {}
      }
      cur = cur[seg] as Record<string, unknown>
    }
    const leaf = segments[segments.length - 1]
    if (leaf && !(leaf in cur)) {
      cur[leaf] = rule.type === 'static' ? rule.staticValue : null
    }
  }

  return mapped
}

export function collectWizardProtectionFieldSamplesSync(
  state: WizardState,
): Map<string, unknown[]> {
  const mapped = buildWizardProtectionMappedEventSync(state)
  if (!mapped) return new Map()

  const paths = collectRuntimeEventFieldPaths(mapped)
  const samples = new Map<string, unknown[]>()
  for (const path of paths) {
    const value = resolveJsonPath(mapped, path)
    if (value === undefined) continue
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      samples.set(path, [value])
    }
  }
  return samples
}
