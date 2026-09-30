import type {
  FinalEventDraftPreviewResponse,
  MappingDraftPreviewResponse,
  MappingValidationWarning,
} from '../../api/gdcRuntimePreview'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { resolveJsonPath } from '../streams/mapping-jsonpath'

export type TransformPreviewFieldSummary = {
  rowId: string
  outputField: string
  sourceJsonPath: string
  matchedCount: number
  missingCount: number
  nullCount: number
  typeChangeCount: number
  duplicateTarget: boolean
}

export type TransformPreviewSummary = {
  previewEventCount: number
  totalApplications: number
  matchedApplications: number
  missingApplications: number
  missingEventCount: number
  nullOutputCount: number
  typeChangeCount: number
  duplicateTargetCount: number
  defaultRecoveryCount: number
  advancedTransformBlockedCount: number
  advancedTransformErrorCount: number
  warningCount: number
  errorCount: number
  fieldSummaries: TransformPreviewFieldSummary[]
}

export type TransformPreviewChangeRow = {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before: unknown
  after: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function jsonStable(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function buildEventChangeRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): TransformPreviewChangeRow[] {
  const rows: TransformPreviewChangeRow[] = []

  const visit = (left: unknown, right: unknown, path: string) => {
    const leftRecord = isRecord(left)
    const rightRecord = isRecord(right)

    if (leftRecord && rightRecord) {
      const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort()
      for (const key of keys) {
        const nextPath = path ? `${path}.${key}` : key
        const hasLeft = Object.prototype.hasOwnProperty.call(left, key)
        const hasRight = Object.prototype.hasOwnProperty.call(right, key)
        if (!hasLeft) {
          visit(undefined, right[key], nextPath)
        } else if (!hasRight) {
          visit(left[key], undefined, nextPath)
        } else {
          visit(left[key], right[key], nextPath)
        }
      }
      return
    }

    if (left === undefined && right !== undefined) {
      rows.push({ path, kind: 'added', before: undefined, after: right })
      return
    }
    if (left !== undefined && right === undefined) {
      rows.push({ path, kind: 'removed', before: left, after: undefined })
      return
    }
    if (jsonStable(left) !== jsonStable(right)) {
      rows.push({ path, kind: 'changed', before: left, after: right })
    }
  }

  visit(before ?? {}, after ?? {}, '')
  return rows
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function readOutputValue(event: Record<string, unknown> | undefined, outputField: string): unknown {
  if (!event) return undefined
  if (Object.prototype.hasOwnProperty.call(event, outputField)) return event[outputField]
  const normalized = outputField.startsWith('$') ? outputField : `$.${outputField}`
  return resolveJsonPath(event, normalized)
}

function missingKey(outputField: string, eventIndex: number): string {
  return `${outputField.toLowerCase()}|${eventIndex}`
}

export function buildTransformPreviewSummary({
  rawEvents,
  rows,
  mapped,
  final,
  warnings,
}: {
  rawEvents: Array<Record<string, unknown>>
  rows: MappingRowModel[]
  mapped: MappingDraftPreviewResponse | null
  final: FinalEventDraftPreviewResponse | null
  warnings: MappingValidationWarning[]
}): TransformPreviewSummary {
  const validRows = rows.filter((row) => row.sourceJsonPath.trim() && row.outputField.trim())
  const previewEventCount = Math.max(
    0,
    mapped?.preview_event_count ?? final?.preview_event_count ?? Math.min(rawEvents.length, 5),
  )
  const missing = mapped?.missing_fields ?? final?.missing_fields ?? []
  const missingKeys = new Set(missing.map((item) => missingKey(item.output_field, item.event_index)))
  const missingEvents = new Set(missing.map((item) => item.event_index))

  const outputCounts = new Map<string, number>()
  for (const row of validRows) {
    const key = row.outputField.trim().toLowerCase()
    outputCounts.set(key, (outputCounts.get(key) ?? 0) + 1)
  }
  const duplicateTargets = new Set(
    [...outputCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key),
  )

  let matchedApplications = 0
  let missingApplications = 0
  let nullOutputCount = 0
  let typeChangeCount = 0
  const mappingTransformResults =
    mapped?.transform_results ?? final?.mapping_transform_results ?? []
  const enrichmentTransformResults = final?.enrichment_transform_results ?? []
  const transformResults = [...mappingTransformResults, ...enrichmentTransformResults]
  const defaultRecoveryCount = transformResults.filter((item) => item.recovered_via_default).length
  const advancedTransformBlockedCount = transformResults.filter((item) => item.blocked === true).length
  const advancedTransformErrorCount = transformResults.filter((item) => !item.success).length

  const fieldSummaries = validRows.map<TransformPreviewFieldSummary>((row) => {
    const outputField = row.outputField.trim()
    const sourceJsonPath = row.sourceJsonPath.trim()
    let matchedCount = 0
    let missingCount = 0
    let nullCount = 0
    let rowTypeChangeCount = 0

    for (let eventIndex = 0; eventIndex < previewEventCount; eventIndex += 1) {
      if (missingKeys.has(missingKey(outputField, eventIndex))) {
        missingCount += 1
        missingApplications += 1
        continue
      }

      matchedCount += 1
      matchedApplications += 1

      const outputValue = readOutputValue(final?.final_events?.[eventIndex] ?? mapped?.mapped_events?.[eventIndex], outputField)
      if (outputValue === null) {
        nullCount += 1
        nullOutputCount += 1
      }

      const sourceValue = resolveJsonPath(rawEvents[eventIndex], sourceJsonPath)
      if (
        sourceValue !== undefined &&
        sourceValue !== null &&
        outputValue !== undefined &&
        outputValue !== null &&
        jsonType(sourceValue) !== jsonType(outputValue)
      ) {
        rowTypeChangeCount += 1
        typeChangeCount += 1
      }
    }

    return {
      rowId: row.id,
      outputField,
      sourceJsonPath,
      matchedCount,
      missingCount,
      nullCount,
      typeChangeCount: rowTypeChangeCount,
      duplicateTarget: duplicateTargets.has(outputField.toLowerCase()),
    }
  })

  return {
    previewEventCount,
    totalApplications: validRows.length * previewEventCount,
    matchedApplications,
    missingApplications,
    missingEventCount: [...missingEvents].filter((idx) => idx < previewEventCount).length,
    nullOutputCount,
    typeChangeCount,
    duplicateTargetCount: duplicateTargets.size,
    defaultRecoveryCount,
    advancedTransformBlockedCount,
    advancedTransformErrorCount,
    warningCount: warnings.filter((warning) => warning.severity === 'warning').length,
    errorCount:
      warnings.filter((warning) => warning.severity === 'error').length + advancedTransformErrorCount,
    fieldSummaries,
  }
}
