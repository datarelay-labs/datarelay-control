/**
 * Incremental Request Template Generator
 *
 * Pure helpers for the JSON Preview step's "Generate incremental request" feature.
 * Generates query-param or JSON-body templates from a selected checkpoint field
 * so the operator can apply them to the HTTP Request step.
 *
 * No backend / API contract changes: all output is pure string/array data ready
 * to drop into `WizardConfigState.params` or `requestBody`.
 */

import { parseJsonPathSegments } from '../../../utils/mappingPassThrough'
import { normalizeEventRootPath, normalizeEventArrayPath, formatPreviewSamplePath } from '../../../utils/eventExtractionPaths'
import { normalizeCheckpointRelativePath } from '../../../utils/recordSelectionPaths'
import { resolveJsonPath } from '../../streams/stream-api-test-json-utils'
import { toExtractedEventRelativePath } from './wizard-json-extract'

export type IncrementalRequestPattern =
  | 'none'
  | 'custom'
  | 'query_params'
  | 'json_body'
  | 'elasticsearch'
  | 'visualsearch_query'

/** User-facing pattern names (no vendor-specific labels). */
export type IncrementalPatternSelectValue =
  | 'none'
  | 'query_params'
  | 'json_body'
  | 'custom'
  | 'elasticsearch'

export type IncrementalPreviewKind = 'query_params' | 'json_body'

const BODY_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export function isBodyHttpMethod(httpMethod: string): boolean {
  return BODY_HTTP_METHODS.has(httpMethod.trim().toUpperCase())
}

/** Map internal pattern keys to dropdown / summary labels. */
export function incrementalPatternDisplayLabel(pattern: IncrementalRequestPattern): string {
  if (pattern === 'visualsearch_query') return 'Custom Body'
  if (pattern === 'query_params') return 'Query Parameters'
  if (pattern === 'json_body') return 'JSON Body'
  if (pattern === 'custom') return 'Custom Body'
  if (pattern === 'elasticsearch') return 'Elasticsearch / Search Body'
  return 'None'
}

/** Whether the preview editor shows query-param lines vs a JSON body. */
export function incrementalPreviewKind(
  pattern: IncrementalRequestPattern,
  draft: string,
  httpMethod: string,
): IncrementalPreviewKind {
  if (pattern === 'query_params') return 'query_params'
  if (pattern === 'json_body' || pattern === 'elasticsearch' || pattern === 'visualsearch_query') {
    return 'json_body'
  }
  if (pattern === 'custom') {
    if (isBodyHttpMethod(httpMethod)) return 'json_body'
    return looksLikeQueryParams(draft) ? 'query_params' : 'json_body'
  }
  return isBodyHttpMethod(httpMethod) ? 'json_body' : 'query_params'
}

export function incrementalPreviewKindLabel(
  pattern: IncrementalRequestPattern,
  draft: string,
  httpMethod: string,
): string {
  return incrementalPreviewKind(pattern, draft, httpMethod) === 'query_params'
    ? 'Query Parameters'
    : 'JSON Body'
}

/** Pattern options available for the stream HTTP method. */
export function availableIncrementalPatterns(httpMethod: string): IncrementalPatternSelectValue[] {
  if (isBodyHttpMethod(httpMethod)) {
    return ['none', 'json_body', 'custom', 'elasticsearch']
  }
  return ['none', 'query_params', 'custom']
}

/** Select value for the pattern dropdown (visualsearch_query → custom). */
export function incrementalPatternSelectValue(pattern: IncrementalRequestPattern): IncrementalPatternSelectValue {
  if (pattern === 'visualsearch_query') return 'custom'
  return pattern
}

export function incrementalPatternFromSelect(
  value: IncrementalPatternSelectValue,
  currentPattern: IncrementalRequestPattern,
): IncrementalRequestPattern {
  if (value === 'custom' && currentPattern === 'visualsearch_query') return 'visualsearch_query'
  return value
}

export type IncrementalRequestPlan =
  | {
      pattern: 'query_params'
      preview: string
      params: Array<{ key: string; value: string }>
      httpMethod: 'GET'
    }
  | {
      pattern: 'json_body' | 'elasticsearch' | 'visualsearch_query'
      preview: string
      body: string
      httpMethod: 'POST'
    }

/** Extract a usable field name from a record-relative JSONPath (e.g. "$.metadata.timestamp" → "metadata.timestamp"). */
export function fieldNameFromCheckpointPath(checkpointSourcePath: string): string {
  const raw = checkpointSourcePath.trim()
  if (!raw) return ''
  return raw.replace(/^\$\.?/, '').trim()
}

/** Shorten dotted field path to a query-param-friendly prefix (last segment only). */
export function leafFieldName(checkpointSourcePath: string): string {
  const full = fieldNameFromCheckpointPath(checkpointSourcePath)
  if (!full) return ''
  const segments = full.split('.').filter(Boolean)
  return segments.length ? segments[segments.length - 1] : full
}

const TIMESTAMP_SEGMENT_RE = /creationtime|timestamp|eventtime|created|updated|modified|time$/i

/** Facet/filter field name for visualsearch queryPath filters (skips values[0] suffix segments). */
export function facetNameFromCheckpointPath(checkpointSourcePath: string): string {
  const full = fieldNameFromCheckpointPath(checkpointSourcePath)
  const segments = full
    .split(/\.|\[/)
    .map((s) => s.replace(/\]$/, '').trim())
    .filter(Boolean)
  const meaningful = segments.filter(
    (s) => s !== 'values' && s !== 'simpleValues' && s !== 'value' && !/^\d+$/.test(s),
  )
  for (let i = meaningful.length - 1; i >= 0; i -= 1) {
    if (TIMESTAMP_SEGMENT_RE.test(meaningful[i])) return meaningful[i]
  }
  return meaningful[meaningful.length - 1] || 'creationTime'
}

/** Infer wizard incremental pattern from HTTP stream config (visualsearch POST body vs GET query params). */
export function inferIncrementalRequestPattern(input: {
  endpoint: string
  requestBody: string
  httpMethod: string
}): IncrementalRequestPattern | null {
  const ep = input.endpoint.trim().toLowerCase()
  if (ep.includes('visualsearch/query') || ep.includes('/rest/visualsearch/')) {
    return 'visualsearch_query'
  }
  const body = input.requestBody.trim()
  if (body) {
    try {
      const parsed = JSON.parse(body) as { queryPath?: unknown }
      if (Array.isArray(parsed.queryPath)) return 'visualsearch_query'
    } catch {
      // ignore invalid JSON
    }
  }
  if (input.httpMethod.trim().toUpperCase() === 'GET') return 'query_params'
  return null
}

function buildCybereasonVisualSearchIncrementalBody(facetName: string, withCheckpoint: boolean): string {
  const filters: Array<Record<string, unknown>> = [{ facetName: 'hasSuspicions', values: [true] }]
  if (withCheckpoint) {
    filters.push({
      facetName,
      filterType: 'GreaterThan',
      values: ['{{checkpoint.last_timestamp}}'],
    })
  }
  const body = {
    queryPath: [
      {
        requestedType: 'Machine',
        connectionFeature: {
          elementInstanceType: 'Machine',
          featureName: 'processes',
        },
      },
      {
        requestedType: 'Process',
        filters,
        isResult: true,
      },
    ],
    totalResultLimit: 1000,
    perGroupLimit: 100,
    perFeatureLimit: 100,
    templateContext: 'SPECIFIC',
    queryTimeout: 120000,
    customFields: [
      'elementDisplayName',
      'creationTime',
      'endTime',
      'commandLine',
      'ownerMachine',
      'parentProcess',
      'imageFile',
      'calculatedUser',
      'hasSuspicions',
    ],
  }
  return JSON.stringify(body, null, 2)
}

export function buildIncrementalRequestPlan(
  pattern: IncrementalRequestPattern,
  checkpointSourcePath: string,
): IncrementalRequestPlan | null {
  if (pattern === 'none' || pattern === 'custom') return null

  if (pattern === 'visualsearch_query') {
    const facetName = checkpointSourcePath.trim()
      ? facetNameFromCheckpointPath(checkpointSourcePath)
      : 'creationTime'
    const preview = buildCybereasonVisualSearchIncrementalBody(facetName, Boolean(checkpointSourcePath.trim()))
    return { pattern, preview, body: preview, httpMethod: 'POST' }
  }

  const fullField = fieldNameFromCheckpointPath(checkpointSourcePath)
  if (!fullField) return null
  const prefix = leafFieldName(checkpointSourcePath) || fullField

  if (pattern === 'query_params') {
    const params = [
      { key: `${prefix}_gt`, value: '{{checkpoint.last_timestamp}}' },
      { key: `${prefix}_lte`, value: '{{now}}' },
      { key: 'limit', value: '100' },
      { key: 'sort', value: `${prefix}:asc` },
    ]
    const preview = params.map((p) => `${p.key}=${p.value}`).join('\n')
    return { pattern, preview, params, httpMethod: 'GET' }
  }

  if (pattern === 'json_body') {
    const body = {
      from: '{{checkpoint.last_timestamp}}',
      to: '{{now}}',
      limit: 100,
      sort: [{ [fullField]: 'asc' }],
    }
    const preview = JSON.stringify(body, null, 2)
    return { pattern, preview, body: preview, httpMethod: 'POST' }
  }

  // elasticsearch
  const body = {
    size: 100,
    sort: [{ [fullField]: 'asc' }, { _id: 'asc' }],
    query: {
      range: {
        [fullField]: {
          gt: '{{checkpoint.last_timestamp}}',
          lte: '{{now}}',
        },
      },
    },
  }
  const preview = JSON.stringify(body, null, 2)
  return { pattern, preview, body: preview, httpMethod: 'POST' }
}

function segmentsToPath(segments: Array<string | number>): string {
  if (segments.length === 0) return '$'
  return segments.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`
    return acc === '$' ? `$.${seg}` : `${acc}.${seg}`
  }, '$')
}

function checkpointPathFallbackCandidates(path: string): string[] {
  const normalized = normalizeCheckpointRelativePath(path)
  if (!normalized) return []
  const out: string[] = []
  const push = (candidate: string) => {
    if (!candidate || candidate === normalized) return
    if (!out.includes(candidate)) out.push(candidate)
  }

  if (normalized.endsWith('.values[0]')) {
    push(normalized.slice(0, -'.values[0]'.length))
  }
  if (normalized.endsWith('.value')) {
    push(normalized.slice(0, -'.value'.length))
  }
  if (!normalized.endsWith('.values[0]') && !normalized.endsWith('.value')) {
    push(`${normalized}.values[0]`)
    push(`${normalized}.value`)
  }

  return out
}

/** Resolve a value inside an extracted event record by record-relative JSONPath (`$.a.b[0].c`). */
export function readCheckpointSampleValue(record: Record<string, unknown> | null, recordRelativePath: string): unknown {
  if (!record) return undefined
  const raw = recordRelativePath.trim()
  if (!raw) return record
  const path = raw.startsWith('$') ? raw : `$.${raw.replace(/^\./, '')}`
  if (path === '$') return record
  return resolveJsonPath(record, path)
}

/**
 * Resolve a checkpoint field on an Event Source record, including fallbacks when the stored
 * checkpoint path still contains stale array prefixes (e.g. `data.results[0]`) but Event Root
 * already narrows each record to the malop object.
 */
export function readCheckpointFromEventSourceRecord(
  record: Record<string, unknown>,
  checkpointSourcePath: string,
  eventRootPath = '',
): unknown {
  const checkpointPath = normalizeCheckpointRelativePath(checkpointSourcePath)
  const direct = readCheckpointSampleValue(record, checkpointPath)
  if (!isBlankValue(direct)) return direct
  for (const fallbackPath of checkpointPathFallbackCandidates(checkpointPath)) {
    const fallbackDirect = readCheckpointSampleValue(record, fallbackPath)
    if (!isBlankValue(fallbackDirect)) return fallbackDirect
  }

  const root = normalizeEventRootPath(eventRootPath)
  if (!root) return undefined

  const rooted = readCheckpointSampleValue(record, root)
  if (!rooted || typeof rooted !== 'object' || Array.isArray(rooted)) return undefined
  const rootedRecord = rooted as Record<string, unknown>

  if (checkpointPath.startsWith(`${root}.`) || checkpointPath.startsWith(`${root}[`)) {
    const suffix = checkpointPath.slice(root.length)
    const relative = suffix.startsWith('.') || suffix.startsWith('[') ? `$${suffix}` : `$.${suffix}`
    const fromRootPrefix = readCheckpointSampleValue(rootedRecord, relative)
    if (!isBlankValue(fromRootPrefix)) return fromRootPrefix
  }

  const segments = parseJsonPathSegments(checkpointPath)
  for (let start = 1; start < segments.length; start += 1) {
    const tailValue = readCheckpointSampleValue(rootedRecord, segmentsToPath(segments.slice(start)))
    if (!isBlankValue(tailValue)) return tailValue
  }

  return undefined
}

/** Parse a query-params draft (one `key=value` per line) into wizard `params` rows. */
export function parseQueryParamsDraft(draft: string): Array<{ key: string; value: string }> {
  return draft
    .split(/\r?\n/)
    .map((line) => line.replace(/^[?&]/, '').trim())
    .filter(Boolean)
    .flatMap((line) =>
      line.split('&').map((pair) => {
        const eq = pair.indexOf('=')
        if (eq < 0) return { key: pair.trim(), value: '' }
        return { key: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() }
      }),
    )
    .filter((p) => p.key.length > 0)
}

/** Heuristic: a draft is treated as Query Params if it does not appear to be JSON ({…} or […]). */
export function looksLikeQueryParams(draft: string): boolean {
  const trimmed = draft.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false
  return true
}

/**
 * Apply an incremental-request template to an in-progress HTTP request payload.
 * Pure helper used at create-stream payload time so the user does not have to bounce
 * back to the HTTP Request step. `none`/empty drafts are no-ops.
 */
export function applyIncrementalRequestTemplate(
  base: { method: string; params: Record<string, string>; body?: string },
  pattern: IncrementalRequestPattern,
  draft: string,
): { method: string; params: Record<string, string>; body?: string } {
  const trimmed = (draft ?? '').trim()
  if (pattern === 'none' || !trimmed) return base
  const treatAsQuery = pattern === 'query_params' || (pattern === 'custom' && looksLikeQueryParams(trimmed))
  if (treatAsQuery) {
    const merged: Record<string, string> = { ...base.params }
    for (const p of parseQueryParamsDraft(trimmed)) {
      if (p.key) merged[p.key] = p.value
    }
    return { method: 'GET', params: merged, body: base.body }
  }
  return {
    method: base.method === 'GET' ? 'POST' : base.method,
    params: { ...base.params },
    body: trimmed,
  }
}

export type IncrementalRequestTestCheckpointResult =
  | {
      kind: 'ok'
      value: string | number
      displayValue: string
      /** Value substituted for `{{checkpoint.last_timestamp}}` — same representation the runtime stores. */
      requestValue?: string
      usedFallback: boolean
      latestExcluded?: string
      valueKind: 'timestamp' | 'numeric' | 'string'
    }
  | { kind: 'disabled'; reason: string }

const HOUR_MS = 3_600_000

function isBlankValue(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * Unwrap API-wrapped checkpoint scalars (Cybereason/CrowdStrike/Stellar shapes) so
 * incremental Test can classify timestamps and numerics.
 */
export function coerceCheckpointScalarValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return value
  if (isBlankValue(value)) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    if (value.length === 1) return coerceCheckpointScalarValue(value[0], depth + 1)
    return value
  }
  if (!value || typeof value !== 'object') return value

  const obj = value as Record<string, unknown>

  for (const key of ['value', 'dateValue', 'dataValue', 'timestamp', 'creationTime'] as const) {
    const inner = obj[key]
    if (inner === undefined || inner === null) continue
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      return inner
    }
    const nested = coerceCheckpointScalarValue(inner, depth + 1)
    if (nested !== inner && typeof nested !== 'object') return nested
  }

  const dataValues = obj.dataValues
  if (dataValues && typeof dataValues === 'object' && !Array.isArray(dataValues)) {
    const nested = coerceCheckpointScalarValue(dataValues, depth + 1)
    if (nested !== dataValues && typeof nested !== 'object') return nested
  }

  const values = obj.values
  if (Array.isArray(values) && values.length > 0) {
    const nested = coerceCheckpointScalarValue(values[0], depth + 1)
    if (typeof nested !== 'object') return nested
  }

  return value
}

/** When the operator clicks a wrapped checkpoint object, prefer the scalar leaf (e.g. `.values[0]`). */
export function preferPrimitiveCheckpointPath(recordRelativePath: string, valueAtPath: unknown): string {
  const base = normalizeCheckpointRelativePath(recordRelativePath)
  if (!base || valueAtPath === null || valueAtPath === undefined) return base
  if (typeof valueAtPath !== 'object' || Array.isArray(valueAtPath)) {
    return base
  }

  const obj = valueAtPath as Record<string, unknown>
  if (Array.isArray(obj.values) && obj.values.length > 0) {
    const inner = coerceCheckpointScalarValue(obj.values[0])
    if (typeof inner !== 'object') return `${base}.values[0]`
  }
  if (
    'value' in obj &&
    (typeof obj.value === 'string' || typeof obj.value === 'number' || typeof obj.value === 'boolean')
  ) {
    return `${base}.value`
  }

  const coerced = coerceCheckpointScalarValue(valueAtPath)
  if (typeof coerced !== 'object') return base

  return base
}

function normalizeCollectedCheckpointValue(value: unknown): unknown {
  return coerceCheckpointScalarValue(value)
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return Math.round(value)
    if (value >= 1e9) return Math.round(value * 1000)
    return null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return null
      if (n >= 1e12) return Math.round(n)
      if (n >= 1e9) return Math.round(n * 1000)
      return null
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

/** Format epoch ms in the same representation as a sample checkpoint value (epoch s/ms or ISO-8601). */
function formatTimestampLikeSample(ms: number, sample: unknown): string {
  const numeric = parseNumericValue(sample)
  if (numeric != null) return numeric >= 1e12 ? String(ms) : String(Math.floor(ms / 1000))
  const iso = new Date(ms).toISOString()
  return /\.\d+/.test(String(sample)) ? iso : iso.replace(/\.\d{3}Z$/, 'Z')
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function classifyCheckpointValue(value: unknown): 'timestamp' | 'numeric' | 'string' | null {
  if (isBlankValue(value)) return null
  if (parseTimestampMs(value) != null) return 'timestamp'
  if (parseNumericValue(value) != null) return 'numeric'
  if (typeof value === 'string') return 'string'
  return null
}

/** True when a value (after coercion) can drive incremental request Test. */
export function isUsableCheckpointTestValue(value: unknown): boolean {
  const coerced = normalizeCollectedCheckpointValue(value)
  if (isBlankValue(coerced)) return false
  if (typeof coerced === 'object') return false
  return classifyCheckpointValue(coerced) != null
}

export type ResolveCheckpointValuesForTestInput = {
  records: Array<Record<string, unknown>>
  checkpointSourcePath: string
  eventArrayPath: string
  eventRootPath?: string
  previewRecord?: Record<string, unknown> | null
  /** Same value shown in Selected checkpoint → Example (operator source of truth). */
  resolvedSampleValue?: unknown
}

/**
 * Resolve checkpoint values for incremental Test.
 * Example cell value wins when usable — avoids split-brain with record JSONPath reads.
 */
export function resolveCheckpointValuesForTest(input: ResolveCheckpointValuesForTestInput): unknown[] {
  const hasCheckpointPath = Boolean(input.checkpointSourcePath.trim())
  const exampleScalar = normalizeCollectedCheckpointValue(input.resolvedSampleValue)
  const recordsUsable = collectCheckpointValuesForIncrementalTest({
    ...input,
    resolvedSampleValue: undefined,
  })
    .map(normalizeCollectedCheckpointValue)
    .filter(isUsableCheckpointTestValue)

  if (recordsUsable.length >= 2) return recordsUsable
  if (recordsUsable.length === 1 && !isUsableCheckpointTestValue(exampleScalar)) return recordsUsable
  if (isUsableCheckpointTestValue(exampleScalar)) return [exampleScalar]
  if (recordsUsable.length === 1) return recordsUsable

  // Checkpoint selected but both Example and extracted records are non-scalar/unusable.
  if (hasCheckpointPath && !isBlankValue(input.resolvedSampleValue) && !isUsableCheckpointTestValue(exampleScalar)) {
    return []
  }

  return []
}

/** Strip stale array/sample prefixes so checkpoint paths work on extracted records. */
export function resolveCheckpointPathForRecord(
  checkpointSourcePath: string,
  eventArrayPath: string,
): string {
  const cp = normalizeCheckpointRelativePath(checkpointSourcePath)
  if (!cp) return ''
  const arrayNorm = normalizeEventArrayPath(eventArrayPath) || '$'
  const stripPrefixes = [
    formatPreviewSamplePath(eventArrayPath, 0),
    `${arrayNorm}[0]`,
    arrayNorm,
    '$[0]',
    '$',
  ]
  for (const prefix of stripPrefixes) {
    if (!prefix) continue
    if (cp === prefix) return '$'
    if (prefix !== '$' && cp.startsWith(`${prefix}.`)) {
      const rel = cp.slice(prefix.length + 1)
      return rel.startsWith('$') ? rel : `$.${rel}`
    }
  }

  const rawArrayPath = eventArrayPath.trim()
  if (rawArrayPath.endsWith('.*')) {
    const mapPrefix = rawArrayPath.slice(0, -2)
    if (cp === mapPrefix) return '$'
    if (cp.startsWith(`${mapPrefix}.`)) {
      const tail = cp.slice(mapPrefix.length + 1)
      const nextDot = tail.indexOf('.')
      if (nextDot < 0) return '$'
      const rel = tail.slice(nextDot + 1)
      return rel ? `$.${rel}` : '$'
    }
  }

  // Object-map wildcard case:
  // event_array_path="$.data.resultIdToElementDataMap.*"
  // checkpoint="$.data.resultIdToElementDataMap.<dynamicKey>.simpleValues.creationTime.values[0]"
  // -> "$.simpleValues.creationTime.values[0]"
  const cpSegments = parseJsonPathSegments(cp)
  const arraySegments = parseJsonPathSegments(eventArrayPath)
  if (cpSegments.length > 0 && arraySegments.length > 0) {
    let cpIdx = 0
    let matches = true
    for (const segment of arraySegments) {
      if (cpIdx >= cpSegments.length) {
        matches = false
        break
      }
      if (segment === '*') {
        cpIdx += 1
        continue
      }
      if (cpSegments[cpIdx] !== segment) {
        matches = false
        break
      }
      cpIdx += 1
    }
    if (matches) {
      if (cpIdx >= cpSegments.length) return '$'
      return segmentsToPath(cpSegments.slice(cpIdx))
    }
  }

  return cp
}

/** Resolve checkpoint path against extracted event records (event root already applied). */
export function resolveCheckpointPathForExtractedEvent(
  checkpointSourcePath: string,
  eventArrayPath: string,
  eventRootPath: string,
): string {
  const onItem = resolveCheckpointPathForRecord(checkpointSourcePath, eventArrayPath)
  const base = onItem || normalizeCheckpointRelativePath(checkpointSourcePath)
  const root = normalizeEventRootPath(eventRootPath)
  if (!root) return base
  return toExtractedEventRelativePath(base, eventArrayPath || '$', root)
}

/** Read a checkpoint value from an extracted event record (post event-root). */
export function readCheckpointFromExtractedEvent(
  record: Record<string, unknown>,
  checkpointSourcePath: string,
  eventArrayPath: string,
  eventRootPath: string,
): unknown {
  const pathOnExtracted = resolveCheckpointPathForExtractedEvent(
    checkpointSourcePath,
    eventArrayPath,
    eventRootPath,
  )
  const direct = readCheckpointSampleValue(record, pathOnExtracted)
  if (!isBlankValue(direct)) return direct
  for (const fallbackPath of checkpointPathFallbackCandidates(pathOnExtracted)) {
    const fallbackDirect = readCheckpointSampleValue(record, fallbackPath)
    if (!isBlankValue(fallbackDirect)) return fallbackDirect
  }

  const leaf = leafFieldName(checkpointSourcePath)
  if (leaf) {
    const leafVal = readCheckpointSampleValue(record, `$.${leaf}`)
    if (!isBlankValue(leafVal)) return leafVal
  }

  return readCheckpointFromEventSourceRecord(
    record,
    resolveCheckpointPathForRecord(checkpointSourcePath, eventArrayPath) || checkpointSourcePath,
    eventRootPath,
  )
}

/** Read the checkpoint value from an extracted record the same way incremental Test collects it. */
export function readCheckpointFromTestRecord(
  record: Record<string, unknown>,
  checkpointSourcePath: string,
  eventArrayPath: string,
  eventRootPath = '',
): unknown {
  return eventRootPath.trim()
    ? readCheckpointFromExtractedEvent(record, checkpointSourcePath, eventArrayPath, eventRootPath)
    : readCheckpointFromEventSourceRecord(
        record,
        resolveCheckpointPathForRecord(checkpointSourcePath, eventArrayPath) || checkpointSourcePath,
        eventRootPath,
      )
}

/**
 * Count returned record checkpoint values strictly newer than the tested checkpoint.
 * Returns null when no value can be compared (blank / non-scalar / different kind), so callers do not warn
 * on an unknown result.
 */
export function countRecordsNewerThanTestCheckpoint(
  recordValues: unknown[],
  test: Extract<IncrementalRequestTestCheckpointResult, { kind: 'ok' }>,
): number | null {
  let compared = 0
  let newer = 0
  for (const raw of recordValues) {
    const value = coerceCheckpointScalarValue(raw)
    if (isBlankValue(value) || typeof value === 'object') continue
    let diff: number | null = null
    if (test.valueKind === 'timestamp') {
      const ms = parseTimestampMs(value)
      const base = typeof test.value === 'number' ? test.value : parseTimestampMs(test.value)
      if (ms != null && base != null) diff = ms - base
    } else if (test.valueKind === 'numeric') {
      const n = parseNumericValue(value)
      const base = parseNumericValue(test.value)
      if (n != null && base != null) diff = n - base
    } else if (typeof value === 'string') {
      diff = value.localeCompare(String(test.value))
    }
    if (diff == null) continue
    compared += 1
    if (diff > 0) newer += 1
  }
  return compared > 0 ? newer : null
}

/** Collect checkpoint values for incremental Test — uses extracted records + preview/fallback. */
export function collectCheckpointValuesForIncrementalTest(input: {
  records: Array<Record<string, unknown>>
  checkpointSourcePath: string
  eventArrayPath: string
  eventRootPath?: string
  previewRecord?: Record<string, unknown> | null
  /** Pre-resolved value from the same logic as the Selected checkpoint "Example" cell. */
  resolvedSampleValue?: unknown
}): unknown[] {
  const { records, checkpointSourcePath, eventArrayPath, eventRootPath = '', previewRecord, resolvedSampleValue } =
    input
  if (!checkpointSourcePath.trim()) return []

  const readOn = (record: Record<string, unknown>) =>
    readCheckpointFromTestRecord(record, checkpointSourcePath, eventArrayPath, eventRootPath)

  const fromRecords = records
    .map(readOn)
    .map(normalizeCollectedCheckpointValue)
    .filter((value) => !isBlankValue(value) && isUsableCheckpointTestValue(value))
  if (fromRecords.length) return fromRecords

  if (previewRecord) {
    const previewVal = normalizeCollectedCheckpointValue(readOn(previewRecord))
    if (isUsableCheckpointTestValue(previewVal)) return [previewVal]
  }

  const fallback = normalizeCollectedCheckpointValue(resolvedSampleValue)
  if (isUsableCheckpointTestValue(fallback)) return [fallback]

  return []
}

/** Collect checkpoint field values from Event Source records (ignores Event Root). */
export function collectCheckpointValuesFromEventSource(
  eventSourceRecords: Array<Record<string, unknown>>,
  checkpointSourcePath: string,
  eventRootPath = '',
): unknown[] {
  if (!checkpointSourcePath.trim()) return []
  return eventSourceRecords
    .map((record) => readCheckpointFromEventSourceRecord(record, checkpointSourcePath, eventRootPath))
    .filter((value) => !isBlankValue(value))
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/** Pick a safe checkpoint substitute for incremental request API tests. */
export function calculateIncrementalRequestTestCheckpoint(
  rawValues: unknown[],
  _checkpointFieldType: string,
): IncrementalRequestTestCheckpointResult {
  if (!rawValues.length) {
    return { kind: 'disabled', reason: 'Select a checkpoint field with values first.' }
  }

  const coerced = rawValues.map(coerceCheckpointScalarValue).filter((value) => !isBlankValue(value))
  if (!coerced.length) {
    return { kind: 'disabled', reason: 'Select a checkpoint field with values first.' }
  }

  const classified = coerced.map((value) => ({ value, kind: classifyCheckpointValue(value) }))

  // Order by parsed time, but keep the raw sample so the request uses the runtime checkpoint representation.
  const rawByMs = new Map<number, unknown>()
  for (const row of classified) {
    const ms = parseTimestampMs(row.value)
    if (ms != null && !rawByMs.has(ms)) rawByMs.set(ms, row.value)
  }
  if (rawByMs.size) {
    const sorted = uniqueSortedNumbers([...rawByMs.keys()])
    if (sorted.length >= 2) {
      const testMs = sorted[sorted.length - 2]
      const latestMs = sorted[sorted.length - 1]
      const requestValue = String(rawByMs.get(testMs))
      return {
        kind: 'ok',
        value: testMs,
        displayValue: requestValue,
        requestValue,
        usedFallback: false,
        latestExcluded: String(latestMs),
        valueKind: 'timestamp',
      }
    }
    const only = sorted[0]
    const fallbackMs = only - HOUR_MS
    const requestValue = formatTimestampLikeSample(fallbackMs, rawByMs.get(only))
    return {
      kind: 'ok',
      value: fallbackMs,
      displayValue: requestValue,
      requestValue,
      usedFallback: true,
      valueKind: 'timestamp',
    }
  }

  const numericValues = classified
    .map((row) => parseNumericValue(row.value))
    .filter((n): n is number => n != null)
  if (numericValues.length) {
    const sorted = uniqueSortedNumbers(numericValues)
    if (sorted.length >= 2) {
      const testVal = sorted[sorted.length - 2]
      const latestVal = sorted[sorted.length - 1]
      return {
        kind: 'ok',
        value: testVal,
        displayValue: String(testVal),
        usedFallback: false,
        latestExcluded: String(latestVal),
        valueKind: 'numeric',
      }
    }
    const only = sorted[0]
    return {
      kind: 'ok',
      value: only - 1,
      displayValue: String(only - 1),
      usedFallback: true,
      valueKind: 'numeric',
    }
  }

  const stringValues = classified
    .filter((row) => row.kind === 'string')
    .map((row) => String(row.value))
  if (stringValues.length) {
    const sorted = [...new Set(stringValues)].sort((a, b) => a.localeCompare(b))
    if (sorted.length >= 2) {
      const testVal = sorted[sorted.length - 2]
      const latestVal = sorted[sorted.length - 1]
      return {
        kind: 'ok',
        value: testVal,
        displayValue: testVal,
        usedFallback: false,
        latestExcluded: latestVal,
        valueKind: 'string',
      }
    }
    const only = sorted[0]
    return {
      kind: 'ok',
      value: only,
      displayValue: only,
      usedFallback: true,
      valueKind: 'string',
    }
  }

  return { kind: 'disabled', reason: 'Select a checkpoint field with values first.' }
}

/** Build API-test checkpoint dict for shared request builder substitution. */
export function buildApiTestCheckpointPayload(
  test: Extract<IncrementalRequestTestCheckpointResult, { kind: 'ok' }>,
): Record<string, unknown> {
  if (test.valueKind === 'timestamp') {
    const ms = typeof test.value === 'number' ? test.value : Number(test.value)
    return {
      last_timestamp: test.requestValue ?? String(test.value),
      last_timestamp_ms: String(ms),
    }
  }
  return {
    last_event_id: String(test.value),
    last_timestamp: String(test.value),
    last_timestamp_ms: String(test.value),
  }
}

export function buildIncrementalRequestTestSignature(input: {
  pattern: IncrementalRequestPattern
  draft: string
  checkpointSourcePath: string
  eventArrayPath: string
}): string {
  return [
    input.pattern,
    input.draft.trim(),
    input.checkpointSourcePath.trim(),
    input.eventArrayPath.trim(),
  ].join('\u001f')
}

export type IncrementalRequestTestWarning =
  | { level: 'none' }
  | { level: 'warning'; message: string }

/** Review/create warnings when incremental template requires verification. */
export function incrementalRequestTestWarning(input: {
  pattern: IncrementalRequestPattern
  draft: string
  checkpointSourcePath: string
  eventArrayPath: string
  lastSuccessSignature: string | null
  lastSuccessAt: number | null
}): IncrementalRequestTestWarning {
  if (input.pattern === 'none' || !input.draft.trim()) {
    return { level: 'none' }
  }
  const signature = buildIncrementalRequestTestSignature({
    pattern: input.pattern,
    draft: input.draft,
    checkpointSourcePath: input.checkpointSourcePath,
    eventArrayPath: input.eventArrayPath,
  })
  if (!input.lastSuccessSignature || !input.lastSuccessAt) {
    return {
      level: 'warning',
      message: 'Incremental request has not been tested. Verify the request body works before creating the stream.',
    }
  }
  if (input.lastSuccessSignature !== signature) {
    return {
      level: 'warning',
      message: 'Incremental request changed after the last successful test. Re-run Test on JSON Preview before creating the stream.',
    }
  }
  return { level: 'none' }
}

/** Best-effort runtime JS type label for the sample value (used in the Selected checkpoint field card). */
export function sampleValueTypeLabel(value: unknown): string {
  if (value === null) return 'NULL'
  if (Array.isArray(value)) return 'ARRAY'
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'INTEGER' : 'NUMBER'
    case 'string':
      return 'STRING'
    case 'boolean':
      return 'BOOLEAN'
    case 'object':
      return 'OBJECT'
    case 'undefined':
      return '—'
    default:
      return String(typeof value).toUpperCase()
  }
}
