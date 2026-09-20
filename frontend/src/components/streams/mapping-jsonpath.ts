/**
 * Minimal JSONPath resolver for Mapping UI ($.a.b[0].c).
 * Replace with shared engine output when backend mapping is wired.
 */

export function resolveJsonPath(root: unknown, path: string): unknown {
  if (path === '$') return root
  let i = 1
  let cur: unknown = root
  const s = path
  while (i < s.length) {
    if (s[i] === '.') {
      i++
      const m = /^([^.[]+)/.exec(s.slice(i))
      if (!m) return undefined
      const key = m[1]
      i += key.length
      if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
        cur = (cur as Record<string, unknown>)[key]
      } else {
        return undefined
      }
    } else if (s[i] === '[') {
      const end = s.indexOf(']', i)
      if (end < 0) return undefined
      const idx = Number(s.slice(i + 1, end))
      i = end + 1
      if (Array.isArray(cur) && Number.isFinite(idx)) {
        cur = cur[idx]
      } else {
        return undefined
      }
    } else {
      return undefined
    }
  }
  return cur
}
