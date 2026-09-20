import type { WizardMappingRow } from './wizard-state'

/**
 * Shared mapping merge helpers for the wizard Mapping step.
 *
 * Priority (highest → lowest):
 *   1. Existing manual rows (never overwritten; `origin` undefined or `'manual'`)
 *   2. Stellar Cyber metadata suggestions (`origin: 'stellar'`)
 *   3. Auto-suggest top-level fields fallback (`origin: 'auto'`)
 */

export type StellarSuggestion = {
  outputField: string
  sourceJsonPath: string
}

export type StellarMergeAnalysis = {
  matched: StellarSuggestion[]
  unmapped: StellarSuggestion[]
  conflicts: StellarSuggestion[]
}

/** Last path segment normalized for use as a default output field name. */
export function suggestOutputFieldFromKey(keyOrPath: string): string {
  const segments = keyOrPath.split(/[.[\]]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? 'field'
  return last.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase() || 'field'
}

/** Top-level JSONPath for each key on the sample event object (`$.fieldName`). */
export function collectTopLevelSourceFieldPaths(sampleEvent: Record<string, unknown> | null): string[] {
  if (!sampleEvent || typeof sampleEvent !== 'object' || Array.isArray(sampleEvent)) return []
  return Object.keys(sampleEvent).map((key) => `$.${key}`)
}

export function mappedSourcePathSet(rows: ReadonlyArray<WizardMappingRow>): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const s = r.sourceJsonPath.trim()
    if (s) out.add(s)
  }
  return out
}

/** Top-level sample keys that have no mapping row yet. */
export function unmappedTopLevelSourcePaths(
  rows: ReadonlyArray<WizardMappingRow>,
  sampleEvent: Record<string, unknown> | null,
): string[] {
  const mapped = mappedSourcePathSet(rows)
  return collectTopLevelSourceFieldPaths(sampleEvent).filter((p) => !mapped.has(p))
}

export function analyzeStellarSuggestions(
  current: ReadonlyArray<WizardMappingRow>,
  suggestions: ReadonlyArray<StellarSuggestion>,
): StellarMergeAnalysis {
  const byOutput = new Map<string, WizardMappingRow>()
  const bySource = new Map<string, WizardMappingRow>()
  for (const r of current) {
    const o = r.outputField.trim()
    const s = r.sourceJsonPath.trim()
    if (o) byOutput.set(o.toLowerCase(), r)
    if (s) bySource.set(s, r)
  }
  const matched: StellarSuggestion[] = []
  const unmapped: StellarSuggestion[] = []
  const conflicts: StellarSuggestion[] = []
  for (const s of suggestions) {
    const oExisting = byOutput.get(s.outputField.toLowerCase())
    const sExisting = bySource.get(s.sourceJsonPath)
    if (!oExisting && !sExisting) {
      unmapped.push(s)
      continue
    }
    if (
      oExisting &&
      sExisting &&
      oExisting.id === sExisting.id &&
      oExisting.sourceJsonPath === s.sourceJsonPath &&
      oExisting.outputField.toLowerCase() === s.outputField.toLowerCase()
    ) {
      matched.push(s)
      continue
    }
    if (
      (oExisting && oExisting.sourceJsonPath !== s.sourceJsonPath) ||
      (sExisting && sExisting.outputField.toLowerCase() !== s.outputField.toLowerCase())
    ) {
      conflicts.push(s)
    } else {
      matched.push(s)
    }
  }
  return { matched, unmapped, conflicts }
}

/**
 * Same logic as the Mapping step "Auto-suggest top-level fields" button: for each
 * top-level key on the sample event, append a row when that `$.key` source path
 * is not already mapped. Does not overwrite existing rows.
 */
export function applyAutoSuggestTopLevel(
  rows: ReadonlyArray<WizardMappingRow>,
  sampleEvent: Record<string, unknown> | null,
  newRowId: () => string,
): WizardMappingRow[] {
  if (!sampleEvent || typeof sampleEvent !== 'object' || Array.isArray(sampleEvent)) {
    return [...rows]
  }
  const next: WizardMappingRow[] = [...rows]
  const seen = mappedSourcePathSet(next)
  for (const key of Object.keys(sampleEvent)) {
    const path = `$.${key}`
    if (seen.has(path)) continue
    next.push({
      id: newRowId(),
      outputField: suggestOutputFieldFromKey(key),
      sourceJsonPath: path,
      origin: 'auto',
    })
    seen.add(path)
  }
  return next
}

export type MetadataMappingApplyResult = {
  rows: WizardMappingRow[]
  stellarAdded: number
  autoAdded: number
  unmappedSourceFields: number
}

/**
 * Metadata Mapping > Apply pipeline:
 *   1. Preserve current rows (manual + prior mappings)
 *   2. Merge Stellar suggestions (unmapped candidates only)
 *   3. Auto-suggest fallback for remaining top-level source fields
 */
export function applyMetadataMappingWithAutoFallback(
  current: ReadonlyArray<WizardMappingRow>,
  stellarSuggestions: ReadonlyArray<StellarSuggestion>,
  sampleEvent: Record<string, unknown> | null,
  newRowId: () => string,
): MetadataMappingApplyResult {
  let next: WizardMappingRow[] = [...current]
  const beforeStellar = next.length

  const { unmapped: stellarUnmapped } = analyzeStellarSuggestions(next, stellarSuggestions)
  for (const s of stellarUnmapped) {
    next.push({
      id: newRowId(),
      outputField: s.outputField,
      sourceJsonPath: s.sourceJsonPath,
      origin: 'stellar',
    })
  }
  const stellarAdded = next.length - beforeStellar

  const beforeAuto = next.length
  next = applyAutoSuggestTopLevel(next, sampleEvent, newRowId)
  const autoAdded = next.length - beforeAuto

  const unmappedSourceFields = unmappedTopLevelSourcePaths(next, sampleEvent).length

  return { rows: next, stellarAdded, autoAdded, unmappedSourceFields }
}
