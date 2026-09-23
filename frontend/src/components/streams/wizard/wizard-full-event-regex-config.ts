/** Wizard-only regex config parsing and preview payload builders (not persisted). */

export type FullEventRegexRuleDocument = {
  output_field: string
  source_path: string
  pattern: string
  group: number
  default?: unknown
}

export type FullEventRegexConfigDocument = {
  preserve_source: boolean
  rules: FullEventRegexRuleDocument[]
}

export type ParseFullEventRegexConfigResult =
  | { ok: true; config: FullEventRegexConfigDocument }
  | { ok: false; error: string }

/** Shown in the editor when empty — structure only, not a runnable example. */
export const FULL_EVENT_REGEX_CONFIG_PLACEHOLDER = `{
  "preserve_source": false,
  "rules": [
    {
      "output_field": "",
      "source_path": "",
      "pattern": "",
      "group": 1,
      "default": null
    }
  ]
}`

function ruleFromUnknown(raw: unknown, index: number): FullEventRegexRuleDocument | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const output_field = String(obj.output_field ?? obj.field ?? '').trim()
  const source_path = String(obj.source_path ?? obj.source_field ?? obj.path ?? '').trim()
  const pattern = String(obj.pattern ?? '').trim()
  if (!output_field || !source_path || !pattern) {
    throw new Error(`rules[${index}]: output_field, source_path, and pattern are required`)
  }
  const groupRaw = obj.group ?? obj.capture_group ?? 1
  const group = Number(groupRaw)
  if (!Number.isFinite(group) || group < 0) {
    throw new Error(`rules[${index}]: group must be a non-negative integer`)
  }
  const rule: FullEventRegexRuleDocument = {
    output_field,
    source_path,
    pattern,
    group,
  }
  if ('default' in obj) rule.default = obj.default
  else if ('default_value' in obj) rule.default = obj.default_value
  return rule
}

export function parseFullEventRegexConfigText(text: string): ParseFullEventRegexConfigResult {
  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: 'Paste a JSON regex transform config.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Config must be a JSON object.' }
  }
  const obj = parsed as Record<string, unknown>
  const preserveRaw = obj.preserve_source ?? obj.preserve_source_fields
  const preserve_source = preserveRaw === true

  const rulesRaw = obj.rules ?? obj.regex_rules
  if (!Array.isArray(rulesRaw)) {
    return { ok: false, error: 'Config must include a "rules" array.' }
  }
  if (rulesRaw.length === 0) {
    return { ok: false, error: 'At least one rule is required in "rules".' }
  }
  try {
    const rules: FullEventRegexRuleDocument[] = []
    rulesRaw.forEach((item, i) => {
      const rule = ruleFromUnknown(item, i)
      if (rule) rules.push(rule)
      else throw new Error(`rules[${i}]: must be an object`)
    })
    return { ok: true, config: { preserve_source, rules } }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid rule entry' }
  }
}

function storedRuleFromDocument(rule: FullEventRegexRuleDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    output_field: rule.output_field,
    source_path: rule.source_path,
    pattern: rule.pattern,
    capture_group: rule.group,
  }
  if (rule.default !== undefined) out.default_value = rule.default
  return out
}

function editorRuleFromDocument(rule: FullEventRegexRuleDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {
    output_field: rule.output_field,
    source_path: rule.source_path,
    pattern: rule.pattern,
    group: rule.group,
  }
  if (rule.default !== undefined) out.default = rule.default
  return out
}

function fullEventRegexConfigToPreviewFieldMappings(
  doc: FullEventRegexConfigDocument,
): Record<string, unknown> {
  return {
    mapping_mode: 'full_event_regex',
    preserve_source_fields: doc.preserve_source,
    regex_rules: doc.rules.map(storedRuleFromDocument),
  }
}

/**
 * Reconstruct the wizard editor document from persisted field_mappings.
 * Canonical persist shape uses top-level `preserve_source_fields` + `regex_rules`
 * (not nested `regex_config`).
 */
export function fullEventRegexConfigDocumentFromFieldMappings(
  fieldMappings: Record<string, unknown>,
): FullEventRegexConfigDocument | null {
  if (fieldMappings.mapping_mode !== 'full_event_regex') return null

  // Legacy nested blob, if present.
  if (fieldMappings.regex_config != null && typeof fieldMappings.regex_config === 'object') {
    const parsed = parseFullEventRegexConfigText(JSON.stringify(fieldMappings.regex_config))
    if (parsed.ok) return parsed.config
  }

  const preserve_source = fieldMappings.preserve_source_fields === true
  const rulesRaw = fieldMappings.regex_rules ?? fieldMappings.rules
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) return null

  try {
    const rules: FullEventRegexRuleDocument[] = []
    rulesRaw.forEach((item, i) => {
      const rule = ruleFromUnknown(item, i)
      if (rule) rules.push(rule)
      else throw new Error(`rules[${i}]: must be an object`)
    })
    return { preserve_source, rules }
  } catch {
    return null
  }
}

/** Wizard editor JSON for a persisted full-event Regex mapping, or empty when not Regex. */
export function fullEventRegexConfigJsonFromFieldMappings(
  fieldMappings: Record<string, unknown>,
): string {
  const doc = fullEventRegexConfigDocumentFromFieldMappings(fieldMappings)
  if (!doc) return ''
  return JSON.stringify(
    {
      preserve_source: doc.preserve_source,
      rules: doc.rules.map(editorRuleFromDocument),
    },
    null,
    2,
  )
}

export function buildFieldMappingsFromFullEventRegexConfigJson(
  configJson: string,
): { ok: true; fieldMappings: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = parseFullEventRegexConfigText(configJson)
  if (parsed.ok === false) return { ok: false, error: parsed.error }
  return { ok: true, fieldMappings: fullEventRegexConfigToPreviewFieldMappings(parsed.config) }
}

export function fullEventRegexConfigParseError(
  result: ParseFullEventRegexConfigResult | null,
): string | null {
  if (!result || result.ok === true) return null
  return result.error
}

export function hasValidFullEventRegexConfigJson(configJson: string): boolean {
  const parsed = parseFullEventRegexConfigText(configJson)
  return parsed.ok && parsed.config.rules.length > 0
}
