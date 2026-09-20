/**
 * Timestamp → UTC Transform UX helpers (guidance + insertable JSONata templates).
 * UI/guidance only — does not reimplement runtime timestamp engines.
 */

export const TIMESTAMP_UTC_AFFORDANCE_LABEL = 'Timestamp → UTC'

export const TIMESTAMP_UTC_JSONATA_GUIDANCE = [
  'Choose a source timestamp field, then insert or copy the JSONata template.',
  'The template writes a UTC ISO-8601 value (Z). Epoch seconds and milliseconds are both handled; string values must be ISO-8601 parseable.',
] as const

export const TIMESTAMP_UTC_REGEX_LIMITATION_GUIDANCE = [
  'Regex cannot reliably compute or normalize timestamps (timezone offsets, epoch units, and calendar math are out of scope for pattern extract).',
  'Use JSONata Timestamp → UTC instead of Regex for timestamp conversion.',
] as const

/** Convert a JSONPath-like selection (e.g. `$.creationTime`) to a JSONata path. */
export function jsonataPathFromJsonPath(jsonPath: string): string {
  const trimmed = jsonPath.trim()
  if (!trimmed || trimmed === '$') return 'timestamp'
  if (trimmed.startsWith('$.')) return trimmed.slice(2) || 'timestamp'
  if (trimmed.startsWith('$')) return trimmed.slice(1).replace(/^\./, '') || 'timestamp'
  return trimmed
}

function sanitizeOutputField(outputField: string): string {
  const trimmed = outputField.trim()
  if (!trimmed) return 'timestamp'
  // Keep identifier-safe for template object keys; fall back when empty after sanitize.
  const safe = trimmed.replace(/[^\w.-]/g, '_')
  return safe || 'timestamp'
}

/** Per-field Advanced Transform JSONata expression for Timestamp → UTC. */
export function buildTimestampUtcFieldJsonataExpression(sourceJsonPath: string): string {
  const path = jsonataPathFromJsonPath(sourceJsonPath)
  return [
    `$fromMillis(`,
    `  $type(${path}) = "number"`,
    `    ? (${path} < 100000000000 ? ${path} * 1000 : ${path})`,
    `    : $toMillis($string(${path}))`,
    `)`,
  ].join('\n')
}

/** Full-event JSONata template that merges a UTC timestamp field onto the source event. */
export function buildTimestampUtcFullEventJsonataTemplate(
  sourceJsonPath: string,
  outputField = 'timestamp',
): string {
  const path = jsonataPathFromJsonPath(sourceJsonPath)
  const out = sanitizeOutputField(outputField)
  return [
    `$merge([$, {`,
    `  "${out}": $fromMillis(`,
    `    $type(${path}) = "number"`,
    `      ? (${path} < 100000000000 ? ${path} * 1000 : ${path})`,
    `      : $toMillis($string(${path}))`,
    `  )`,
    `}])`,
  ].join('\n')
}

/** Prefer common timestamp-like keys from sample path options when present. */
export function suggestTimestampSourcePath(pathOptions: readonly string[]): string {
  const preferred = [
    '$.timestamp',
    '$.event_time',
    '$.eventTime',
    '$.creationTime',
    '$.created_at',
    '$.createdAt',
    '$.time',
    '$.@timestamp',
  ]
  for (const p of preferred) {
    if (pathOptions.includes(p)) return p
  }
  const fuzzy = pathOptions.find((p) => /time|date|timestamp/i.test(p))
  return fuzzy || pathOptions[0] || '$.timestamp'
}
