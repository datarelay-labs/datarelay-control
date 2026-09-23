/**
 * Enrichment rule types for the Stream Creation Wizard (Static, Calculated, Lookup, Conditional, Normalize).
 */

export type EnrichmentRuleType = 'static' | 'calculated' | 'lookup' | 'conditional' | 'normalize'

/** JSON-like static enrichment values accepted by runtime `_is_json_like`. */
export type WizardStaticPersistedValue =
  | string
  | number
  | boolean
  | null
  | WizardStaticPersistedValue[]
  | { [key: string]: WizardStaticPersistedValue }

export type WizardEnrichmentRule = {
  id: string
  /** Display label in the rule card header */
  label: string
  /** Target output field path */
  fieldName: string
  type: EnrichmentRuleType
  enabled: boolean
  /** Static Value (editor display string). */
  staticValue: string
  /**
   * Original JSON-like value from persistence (scalar, object, or array).
   * Used on save so hydrate→persist does not coerce typed/nested values into strings.
   * Cleared when the operator edits `staticValue` in the UI.
   */
  staticPersistedValue?: WizardStaticPersistedValue
  /** Calculated */
  expression: string
  /** Lookup */
  lookupTable: string
  lookupKeyField: string
  /** Conditional */
  conditions: Array<{ id: string; when: string; then: string }>
  conditionalDefault: string
  /** Normalize */
  normalizeSourceField: string
  normalizeFormat: 'iso8601' | 'lowercase' | 'uppercase' | 'trim'
}

export type EnrichmentRuleTypeMeta = {
  type: EnrichmentRuleType
  label: string
  shortLabel: string
  description: string
}

export const ENRICHMENT_RULE_TYPES: ReadonlyArray<EnrichmentRuleTypeMeta> = [
  { type: 'static', label: 'Static Value', shortLabel: 'Static', description: 'Set a fixed value' },
  { type: 'calculated', label: 'Calculated', shortLabel: 'Calculated', description: 'Expression-based computation' },
  { type: 'lookup', label: 'Lookup', shortLabel: 'Lookup', description: 'Reference lookup table' },
  { type: 'conditional', label: 'Conditional', shortLabel: 'Conditional', description: 'If-then logic' },
  { type: 'normalize', label: 'Normalize', shortLabel: 'Normalize', description: 'Standardize format' },
]

export const QUICK_ADD_PRESETS: ReadonlyArray<{ field: string; value: string; label: string }> = [
  { field: 'vendor', value: 'Cybereason', label: 'Vendor' },
  { field: 'product', value: 'EDR', label: 'Product' },
  { field: 'log_type', value: 'malop', label: 'Log type' },
  { field: 'event_source', value: 'connector', label: 'Event source' },
  { field: 'collector_name', value: 'gdc-collector', label: 'Collector' },
  { field: 'tenant', value: 'default', label: 'Tenant' },
]

export function newEnrichmentRuleId(): string {
  return `enr-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
}

export function newConditionId(): string {
  return `cond-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
}

export function defaultRuleForType(type: EnrichmentRuleType, index: number): WizardEnrichmentRule {
  const n = index + 1
  const base = {
    id: newEnrichmentRuleId(),
    enabled: true,
    fieldName: '',
    staticValue: '',
    expression: '',
    lookupTable: 'aws-regions',
    lookupKeyField: 'region',
    conditions: [{ id: newConditionId(), when: '', then: '' }],
    conditionalDefault: '',
    normalizeSourceField: 'timestamp',
    normalizeFormat: 'iso8601' as const,
  }
  switch (type) {
    case 'static':
      return { ...base, type, label: 'New Static', fieldName: `metadata.field_${n}`, staticValue: '' }
    case 'calculated':
      return {
        ...base,
        type,
        label: 'New Calculated',
        fieldName: `metadata.field_${n}`,
        expression: "eventName.includes('Delete') ? 8 : eventName.includes('Create') ? 5 : 3",
      }
    case 'lookup':
      return {
        ...base,
        type,
        label: 'Region Display Name',
        fieldName: 'metadata.cloud.region_name',
        lookupKeyField: 'region',
      }
    case 'conditional':
      return {
        ...base,
        type,
        label: 'Outcome Status',
        fieldName: 'metadata.outcome',
        conditions: [
          { id: newConditionId(), when: "status === 'success'", then: 'success' },
          { id: newConditionId(), when: "status === 'failure'", then: 'failure' },
        ],
        conditionalDefault: 'unknown',
      }
    case 'normalize':
      return {
        ...base,
        type,
        label: 'Timestamp ISO',
        fieldName: 'metadata.timestamp',
        normalizeSourceField: 'timestamp',
        normalizeFormat: 'iso8601',
      }
    default:
      return { ...base, type: 'static', label: 'New Static', fieldName: `metadata.field_${n}` }
  }
}

/** Legacy wizard rows `{ id, fieldName, value }` → rule model. */
export function normalizeWizardEnrichmentRule(raw: unknown): WizardEnrichmentRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string') return null

  if (typeof o.type === 'string' && ENRICHMENT_RULE_TYPES.some((t) => t.type === o.type)) {
    const type = o.type as EnrichmentRuleType
    const conditions = Array.isArray(o.conditions)
      ? o.conditions
          .map((c) => {
            if (!c || typeof c !== 'object') return null
            const row = c as Record<string, unknown>
            return {
              id: typeof row.id === 'string' ? row.id : newConditionId(),
              when: String(row.when ?? ''),
              then: String(row.then ?? ''),
            }
          })
          .filter((c): c is { id: string; when: string; then: string } => c != null)
      : [{ id: newConditionId(), when: '', then: '' }]

    return {
      id: o.id,
      label: String(o.label ?? 'Enrichment'),
      fieldName: String(o.fieldName ?? ''),
      type,
      enabled: o.enabled !== false,
      staticValue: String(o.staticValue ?? o.value ?? ''),
      expression: String(o.expression ?? ''),
      lookupTable: String(o.lookupTable ?? 'aws-regions'),
      lookupKeyField: String(o.lookupKeyField ?? ''),
      conditions: conditions.length > 0 ? conditions : [{ id: newConditionId(), when: '', then: '' }],
      conditionalDefault: String(o.conditionalDefault ?? ''),
      normalizeSourceField: String(o.normalizeSourceField ?? 'timestamp'),
      normalizeFormat:
        o.normalizeFormat === 'lowercase' ||
        o.normalizeFormat === 'uppercase' ||
        o.normalizeFormat === 'trim'
          ? o.normalizeFormat
          : 'iso8601',
    }
  }

  if ('fieldName' in o || 'value' in o) {
    return {
      ...defaultRuleForType('static', 0),
      id: o.id,
      label: String(o.fieldName ?? 'Static'),
      fieldName: String(o.fieldName ?? ''),
      staticValue: String(o.value ?? ''),
      type: 'static',
      enabled: true,
    }
  }
  return null
}

export function normalizeWizardEnrichmentRules(raw: unknown): WizardEnrichmentRule[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => normalizeWizardEnrichmentRule(r)).filter((r): r is WizardEnrichmentRule => r != null)
}

/**
 * Rebuild wizard enrichment rules from a persisted enrichment dict
 * (`{ field: staticValue, __rules?: { field: advancedPayload } }`).
 */
export function formatStaticPersistedValueForEditor(value: WizardStaticPersistedValue): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isJsonLikeStaticValue(value: unknown): value is WizardStaticPersistedValue {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(value)) return value.every((item) => isJsonLikeStaticValue(item))
  if (t === 'object') {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, nested]) => typeof key === 'string' && isJsonLikeStaticValue(nested),
    )
  }
  return false
}

export function wizardEnrichmentRulesFromPersistedDict(
  rec: Record<string, unknown> | null | undefined,
): WizardEnrichmentRule[] {
  if (!rec || typeof rec !== 'object') return []
  const rules: WizardEnrichmentRule[] = []
  const advancedRaw = rec.__rules
  const advanced =
    advancedRaw && typeof advancedRaw === 'object' && !Array.isArray(advancedRaw)
      ? (advancedRaw as Record<string, unknown>)
      : {}

  for (const [fieldName, value] of Object.entries(rec)) {
    if (fieldName === '__rules') continue
    if (typeof value === 'string') {
      rules.push({
        ...defaultRuleForType('static', rules.length),
        label: fieldName,
        fieldName,
        staticValue: value,
      })
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      rules.push({
        ...defaultRuleForType('static', rules.length),
        label: fieldName,
        fieldName,
        staticValue: String(value),
        staticPersistedValue: value,
      })
      continue
    }
    if (value === null) {
      rules.push({
        ...defaultRuleForType('static', rules.length),
        label: fieldName,
        fieldName,
        staticValue: 'null',
        staticPersistedValue: null,
      })
      continue
    }
    // Nested object/array static values (runtime `_is_json_like`); keep lossless raw.
    if (isJsonLikeStaticValue(value) && (Array.isArray(value) || typeof value === 'object')) {
      rules.push({
        ...defaultRuleForType('static', rules.length),
        label: fieldName,
        fieldName,
        staticValue: formatStaticPersistedValueForEditor(value),
        staticPersistedValue: value,
      })
    }
  }

  for (const [fieldName, payload] of Object.entries(advanced)) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const o = payload as Record<string, unknown>
    const typeRaw = typeof o.type === 'string' ? o.type : 'calculated'
    const type: EnrichmentRuleType =
      typeRaw === 'lookup' ||
      typeRaw === 'conditional' ||
      typeRaw === 'normalize' ||
      typeRaw === 'static' ||
      typeRaw === 'calculated'
        ? typeRaw
        : 'calculated'
    const conditions = Array.isArray(o.conditions)
      ? o.conditions
          .map((c) => {
            if (!c || typeof c !== 'object') return null
            const row = c as Record<string, unknown>
            return {
              id: newConditionId(),
              when: String(row.when ?? ''),
              then: String(row.then ?? ''),
            }
          })
          .filter((c): c is { id: string; when: string; then: string } => c != null)
      : [{ id: newConditionId(), when: '', then: '' }]
    rules.push({
      ...defaultRuleForType(type, rules.length),
      label: String(o.label ?? fieldName),
      fieldName,
      type,
      enabled: o.enabled !== false,
      expression: String(o.expression ?? ''),
      lookupTable: String(o.lookup_table ?? o.lookupTable ?? 'aws-regions'),
      lookupKeyField: String(o.lookup_key_field ?? o.lookupKeyField ?? ''),
      conditions: conditions.length > 0 ? conditions : [{ id: newConditionId(), when: '', then: '' }],
      conditionalDefault: String(o.default ?? o.conditionalDefault ?? ''),
      normalizeSourceField: String(o.source_field ?? o.normalizeSourceField ?? 'timestamp'),
      normalizeFormat:
        o.format === 'lowercase' || o.format === 'uppercase' || o.format === 'trim'
          ? o.format
          : o.normalizeFormat === 'lowercase' ||
              o.normalizeFormat === 'uppercase' ||
              o.normalizeFormat === 'trim'
            ? o.normalizeFormat
            : 'iso8601',
      staticValue: String(o.staticValue ?? o.value ?? ''),
    })
  }

  return rules
}

function isNowUtcTemplate(s: string): boolean {
  return s.trim().replace(/\s/g, '').toLowerCase() === '{{now_utc}}'
}

function isTemplateValue(s: string): boolean {
  const t = s.trim()
  return t.startsWith('{{') && t.includes('}}')
}

export function resolveStaticPreviewValue(raw: string): unknown {
  if (isNowUtcTemplate(raw)) return new Date().toISOString()
  return raw
}

export function enrichmentRuleSourceLabel(rule: WizardEnrichmentRule): string {
  if (rule.type !== 'static') return rule.type
  const v = rule.staticValue.trim()
  if (!v) return 'Static'
  if (isNowUtcTemplate(v)) return 'Auto (System Time)'
  if (isTemplateValue(v)) return 'Auto'
  return 'Static'
}

export function enrichmentDictFromRules(rules: readonly WizardEnrichmentRule[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const advanced: Record<string, unknown> = {}

  for (const rule of rules) {
    const key = rule.fieldName.trim()
    if (!key || !rule.enabled) continue

    if (rule.type === 'static') {
      out[key] =
        rule.staticPersistedValue !== undefined ? rule.staticPersistedValue : rule.staticValue
      continue
    }

    const payload: Record<string, unknown> = {
      type: rule.type,
      label: rule.label,
      enabled: rule.enabled,
    }
    if (rule.type === 'calculated') payload.expression = rule.expression
    if (rule.type === 'lookup') {
      payload.lookup_table = rule.lookupTable
      payload.lookup_key_field = rule.lookupKeyField
    }
    if (rule.type === 'conditional') {
      payload.conditions = rule.conditions.map((c) => ({ when: c.when, then: c.then }))
      payload.default = rule.conditionalDefault
    }
    if (rule.type === 'normalize') {
      payload.source_field = rule.normalizeSourceField
      payload.format = rule.normalizeFormat
    }
    advanced[key] = payload
  }

  if (Object.keys(advanced).length > 0) out.__rules = advanced
  return out
}

export function countRulesByType(rules: readonly WizardEnrichmentRule[]): Record<EnrichmentRuleType | 'all', number> {
  const active = rules.filter((r) => r.fieldName.trim() && r.enabled)
  const counts: Record<EnrichmentRuleType | 'all', number> = {
    all: active.length,
    static: 0,
    calculated: 0,
    lookup: 0,
    conditional: 0,
    normalize: 0,
  }
  for (const r of active) counts[r.type] += 1
  return counts
}

export type EnrichmentIssueLike = {
  code: string
  severity?: 'error' | 'warning'
  message: string
  rule_type?: string | null
  target_field?: string | null
  field?: string | null
}

/** Match backend validation/preview issues to a wizard rule card. */
export function issuesForEnrichmentRule(
  rule: WizardEnrichmentRule,
  issues: readonly EnrichmentIssueLike[],
): EnrichmentIssueLike[] {
  const target = rule.fieldName.trim().toLowerCase()
  return issues.filter((issue) => {
    const issueTarget = (issue.target_field ?? '').trim().toLowerCase()
    if (target && issueTarget === target) return true
    if (!target && issue.rule_type === rule.type) return true
    return false
  })
}

export function countDuplicateEnrichmentFieldNames(rules: readonly WizardEnrichmentRule[]): number {
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
