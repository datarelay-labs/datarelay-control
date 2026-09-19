/** Secret redaction for evidence / logs / network captures. */

const SENSITIVE =
  /password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|bearer|credential|access_key|secret_key/i

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE.test(k)) {
        out[k] = typeof v === 'string' && v.length === 0 ? '' : '********'
      } else {
        out[k] = redactValue(v)
      }
    }
    return out
  }
  if (typeof value === 'string') {
    return value
      .replace(/(Bearer\s+)\S+/gi, '$1********')
      .replace(/(Basic\s+)\S+/gi, '$1********')
      .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, '$1********')
  }
  return value
}

export function redactText(text: string): string {
  return String(redactValue(text))
}
