import type { AdvancedTransformRuleDraft } from '../types/advancedTransform'

const TRANSFORM_RULES_KEY = 'transform_rules'
const ADVANCED_FIELDS_KEY = 'advanced_fields'
export const UNMAPPED_FIELDS_POLICY_KEY = 'unmapped_fields_policy'

const FIELD_MAPPING_PRESERVED_META_KEYS = new Set([
  'mapping_mode',
  'jsonata_expression',
  'regex_rules',
  'preserve_source_fields',
  UNMAPPED_FIELDS_POLICY_KEY,
])

/**
 * Preserve stored mapping metadata that legacy field editors do not own.
 * transform_rules is intentionally excluded because the active editor owns it.
 */
export function extractPreservedFieldMappingMetadata(
  fieldMappings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fieldMappings) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fieldMappings)) {
    if (key === TRANSFORM_RULES_KEY) continue
    if (
      FIELD_MAPPING_PRESERVED_META_KEYS.has(key) ||
      key.startsWith('_') ||
      typeof value !== 'string'
    ) {
      out[key] = value
    }
  }
  return out
}

function parseDefaultValue(raw: string): unknown {
  const t = raw.trim()
  if (!t) return undefined
  if (t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

export function ruleDraftToApiPayload(rule: AdvancedTransformRuleDraft): Record<string, unknown> {
  const output = rule.outputField.trim()
  const base: Record<string, unknown> = {
    mode: rule.mode,
  }
  if (rule.ruleId.trim()) base.rule_id = rule.ruleId.trim()
  base.field = output
  base.output_field = output

  if (rule.mode === 'jsonata') {
    base.expression = rule.expression.trim()
  } else {
    base.source_path = rule.sourcePath.trim() || '$.message'
    base.pattern = rule.pattern.trim()
    base.group = rule.group > 0 ? rule.group : 1
  }

  const def = parseDefaultValue(rule.defaultValue)
  if (def !== undefined) base.default_value = def

  return base
}

export function rulesToTransformRulesApi(rules: readonly AdvancedTransformRuleDraft[]): Record<string, unknown>[] {
  return rules.filter((r) => r.outputField.trim()).map(ruleDraftToApiPayload)
}

export function rulesToAdvancedFieldsApi(rules: readonly AdvancedTransformRuleDraft[]): Record<string, unknown>[] {
  return rulesToTransformRulesApi(rules)
}

export function buildFieldMappingsWithTransformRules(
  simpleMappings: Record<string, string>,
  rules: readonly AdvancedTransformRuleDraft[],
  unmappedFieldsPolicy: 'pass_through' | 'drop_unmapped' = 'pass_through',
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...simpleMappings }
  const tr = rulesToTransformRulesApi(rules)
  if (tr.length > 0) out[TRANSFORM_RULES_KEY] = tr
  if (unmappedFieldsPolicy === 'drop_unmapped') {
    out[UNMAPPED_FIELDS_POLICY_KEY] = 'drop_unmapped'
  }
  return out
}

export function buildEnrichmentWithAdvancedFields(
  staticFields: Record<string, unknown>,
  rules: readonly AdvancedTransformRuleDraft[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...staticFields }
  const af = rulesToAdvancedFieldsApi(rules)
  if (af.length > 0) out[ADVANCED_FIELDS_KEY] = af
  return out
}

function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : v != null ? String(v) : ''
}

export function ruleDraftFromApiPayload(
  raw: Record<string, unknown>,
  index: number,
): AdvancedTransformRuleDraft | null {
  const modeRaw = readString(raw, 'mode').toLowerCase()
  if (modeRaw !== 'jsonata' && modeRaw !== 'regex_extract') return null
  const output = readString(raw, 'output_field') || readString(raw, 'field')
  if (!output) return null

  const defaultRaw = raw.default_value ?? raw.fallback_value
  let defaultValue = ''
  if (defaultRaw !== undefined && defaultRaw !== null) {
    defaultValue = typeof defaultRaw === 'string' ? defaultRaw : JSON.stringify(defaultRaw)
  }

  return {
    id: `loaded-${index}-${output}`,
    uiMode: modeRaw === 'regex_extract' ? 'expert' : 'advanced',
    outputField: output,
    mode: modeRaw,
    expression: readString(raw, 'expression'),
    sourcePath: readString(raw, 'source_path') || readString(raw, 'path') || '$.message',
    pattern: readString(raw, 'pattern'),
    group: typeof raw.group === 'number' ? raw.group : Number(raw.group) || 1,
    defaultValue,
    ruleId: readString(raw, 'rule_id'),
  }
}

export function parseUnmappedFieldsPolicyFromFieldMappings(
  fieldMappings: Record<string, unknown> | undefined,
): 'pass_through' | 'drop_unmapped' {
  if (!fieldMappings) return 'pass_through'
  const raw = fieldMappings[UNMAPPED_FIELDS_POLICY_KEY]
  return raw === 'drop_unmapped' ? 'drop_unmapped' : 'pass_through'
}

export function parseTransformRulesFromFieldMappings(
  fieldMappings: Record<string, unknown> | undefined,
): AdvancedTransformRuleDraft[] {
  if (!fieldMappings) return []
  const raw = fieldMappings[TRANSFORM_RULES_KEY]
  if (!Array.isArray(raw)) return []
  const out: AdvancedTransformRuleDraft[] = []
  raw.forEach((item, i) => {
    if (item && typeof item === 'object') {
      const draft = ruleDraftFromApiPayload(item as Record<string, unknown>, i)
      if (draft) out.push(draft)
    }
  })
  return out
}

export function parseAdvancedFieldsFromEnrichment(
  enrichment: Record<string, unknown> | undefined,
): AdvancedTransformRuleDraft[] {
  if (!enrichment) return []
  const raw = enrichment[ADVANCED_FIELDS_KEY]
  if (!Array.isArray(raw)) return []
  const out: AdvancedTransformRuleDraft[] = []
  raw.forEach((item, i) => {
    if (item && typeof item === 'object') {
      const draft = ruleDraftFromApiPayload(item as Record<string, unknown>, i)
      if (draft) out.push(draft)
    }
  })
  return out
}

export function collectSourcePathOptions(sample: Record<string, unknown> | null): string[] {
  const paths = new Set<string>(['$.message'])
  if (!sample) return [...paths]
  const walk = (obj: unknown, prefix: string, depth: number) => {
    if (depth > 4) return
    if (obj === null || obj === undefined) return
    if (typeof obj === 'string') {
      paths.add(prefix)
      return
    }
    if (Array.isArray(obj)) {
      if (obj.length > 0) walk(obj[0], `${prefix}[0]`, depth + 1)
      return
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const next = prefix === '$' ? `$.${k}` : `${prefix}.${k}`
        walk(v, next, depth + 1)
      }
    }
  }
  walk(sample, '$', 0)
  for (const k of Object.keys(sample)) {
    paths.add(`$.${k}`)
  }
  return [...paths].sort()
}
