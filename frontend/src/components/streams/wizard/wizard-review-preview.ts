/**
 * Pure helpers for the Stream wizard Review step — mapping preview helpers.
 * Enrichment final events are produced by the backend enrichment-exec API.
 */

import { resolveJsonPath } from '../mapping-jsonpath'
import { applyMappingWithPassThrough } from '../../../utils/mappingPassThrough'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import type { WizardMappingRow } from './wizard-state'

export type { WizardEnrichmentRule }

export function enrichmentValueKind(rule: WizardEnrichmentRule): 'static' | 'auto' | WizardEnrichmentRule['type'] {
  if (rule.type !== 'static') return rule.type
  const v = rule.staticValue.trim()
  if (!v) return 'static'
  if (v.replace(/\s/g, '').toLowerCase() === '{{now_utc}}') return 'auto'
  if (v.startsWith('{{') && v.includes('}}')) return 'auto'
  return 'static'
}

export function buildMappedBaseFromState(
  sampleEvent: Record<string, unknown> | null,
  mapping: WizardMappingRow[],
  unmappedFieldsPolicy: 'pass_through' | 'drop_unmapped' = 'pass_through',
): Record<string, unknown> {
  if (!sampleEvent) return {}
  return applyMappingWithPassThrough(sampleEvent, mapping, resolveJsonPath, unmappedFieldsPolicy)
}

export function countDuplicateEnrichmentKeys(rules: WizardEnrichmentRule[]): number {
  const counts = new Map<string, number>()
  for (const rule of rules) {
    const k = rule.fieldName.trim().toLowerCase()
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  let dups = 0
  for (const n of counts.values()) {
    if (n > 1) dups += n - 1
  }
  return dups
}

export function getNestedPreviewValue(
  event: Record<string, unknown> | null | undefined,
  path: string,
): unknown {
  if (!event || !path.trim()) return undefined
  const parts = path.trim().split('.')
  let cur: unknown = event
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
