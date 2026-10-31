import type { MappingDraftPreviewTransformResult } from '../../../api/gdcRuntimePreview'

export type TransformFailureLine = {
  key: string
  field: string
  code: string
  message: string
}

export type TransformFailureSummary = {
  count: number
  engineUnavailable: boolean
  lines: TransformFailureLine[]
}

const ENGINE_UNAVAILABLE = 'TRANSFORM_ENGINE_UNAVAILABLE'

/**
 * Distinct failed transform rules from a runtime preview. A failed rule produced no output field,
 * so the preview must not read as "verified" while any exist (F-152, F-172, F-235).
 */
export function summarizeTransformFailures(
  results: ReadonlyArray<Pick<MappingDraftPreviewTransformResult, 'success' | 'error_code' | 'error_message' | 'output_field'>>,
): TransformFailureSummary {
  const lines: TransformFailureLine[] = []
  const seen = new Set<string>()
  let engineUnavailable = false
  for (const item of results) {
    if (item.success !== false) continue
    const code = (item.error_code ?? 'TRANSFORM_FAILED').trim() || 'TRANSFORM_FAILED'
    if (code === ENGINE_UNAVAILABLE) engineUnavailable = true
    const field = (item.output_field ?? '').trim()
    const message = (item.error_message ?? '').trim() || 'The rule produced no output.'
    const key = `${field}|${code}|${message}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push({ key, field, code, message })
  }
  return { count: lines.length, engineUnavailable, lines }
}

export function runtimePreviewBadgeLabel(input: {
  loading: boolean
  error: string | null
  hasPreview: boolean
  failureCount: number
}): string {
  if (input.loading) return 'Runtime preview'
  if (input.error) return 'Preview failed'
  if (!input.hasPreview) return 'Preview pending'
  if (input.failureCount > 0) {
    return `${input.failureCount} rule${input.failureCount === 1 ? '' : 's'} failed`
  }
  return 'Runtime verified'
}

export const TRANSFORM_ENGINE_UNAVAILABLE_HINT =
  'The JSONata engine is not installed on the server, so JSONata rules produce no output. Ask an administrator to install the server dependency (jsonata-python).'
