/**
 * Timestamp → UTC Transform UX helpers (guidance + insertable JSONata templates).
 * UI/guidance only — does not reimplement runtime timestamp engines.
 */

export const TIMESTAMP_UTC_AFFORDANCE_LABEL = 'Timestamp → UTC'

/** Numeric values strictly below this threshold are treated as epoch seconds; otherwise milliseconds. */
export const TIMESTAMP_UTC_EPOCH_SECONDS_MAX = 100_000_000_000

export const TIMESTAMP_UTC_JSONATA_GUIDANCE = [
  'Choose a source timestamp field, then insert or copy the JSONata template.',
  `The template writes a UTC ISO-8601 value (Z). Numeric values below ${TIMESTAMP_UTC_EPOCH_SECONDS_MAX} are treated as epoch seconds (modern-era heuristic); otherwise as milliseconds — this does not universally disambiguate all units. String values must be ISO-8601 parseable.`,
] as const

export const TIMESTAMP_UTC_REGEX_LIMITATION_GUIDANCE = [
  'Regex cannot reliably compute or normalize timestamps (timezone offsets, epoch units, and calendar math are out of scope for pattern extract).',
  'Use JSONata Timestamp → UTC instead of Regex for timestamp conversion.',
] as const

/** Ordinary JSONata identifiers can be unquoted; special/reserved key segments need backticks. */
const JSONATA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Identifier-shaped tokens that are unsafe as bare property-path steps.
 * Sourced from JSONata parser operators (`and`/`or`/`in`) and literals that reject
 * path steps (`true`/`false`/`null`); not from JavaScript reserved words.
 */
const JSONATA_RESERVED_PATH_TOKENS = new Set(['and', 'or', 'in', 'true', 'false', 'null'])

function quoteJsonataPropertySegment(segment: string): string {
  const match = segment.match(/^([^[\]]+)((?:\[\d+\])*)$/)
  if (!match) return segment
  const [, name, indexes] = match
  if (JSONATA_IDENTIFIER.test(name) && !JSONATA_RESERVED_PATH_TOKENS.has(name)) {
    return `${name}${indexes}`
  }
  return `\`${name.replace(/`/g, '\\`')}\`${indexes}`
}

/** Convert a JSONPath-like selection (e.g. `$.creationTime`) to a JSONata path. */
export function jsonataPathFromJsonPath(jsonPath: string): string {
  const trimmed = jsonPath.trim()
  if (!trimmed || trimmed === '$') return 'timestamp'
  let path = trimmed
  if (path.startsWith('$.')) path = path.slice(2)
  else if (path.startsWith('$')) path = path.slice(1).replace(/^\./, '')
  if (!path) return 'timestamp'
  return path.split('.').map(quoteJsonataPropertySegment).join('.')
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
    `    ? (${path} < ${TIMESTAMP_UTC_EPOCH_SECONDS_MAX} ? ${path} * 1000 : ${path})`,
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
    `      ? (${path} < ${TIMESTAMP_UTC_EPOCH_SECONDS_MAX} ? ${path} * 1000 : ${path})`,
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
