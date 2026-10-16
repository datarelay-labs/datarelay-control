/** Compare supplied preview evidence only; never evaluate processing rules here. */
export type FieldChange = 'Added' | 'Changed' | 'Removed' | 'Unchanged'
export type PreviewFieldRow = {
  path: string
  change: FieldChange
  beforePresent: boolean
  afterPresent: boolean
  before: unknown
  after: unknown
}

const MISSING = Symbol('missing preview field')
const MAX_ROWS = 200
const MAX_DEPTH = 12
const MAX_VISITS = 4000

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object'
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function fieldPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

export function comparePreviewFields(before: unknown, after: unknown): {
  rows: PreviewFieldRow[]
  counts: Record<FieldChange, number>
  truncated: boolean
} {
  const rows: PreviewFieldRow[] = []
  let truncated = false
  let visits = 0
  const beforeParents = new WeakSet<object>()
  const afterParents = new WeakSet<object>()

  function add(a: unknown, b: unknown, path: string, equal = a === b) {
    const beforePresent = a !== MISSING
    const afterPresent = b !== MISSING
    rows.push({
      path,
      change: !beforePresent ? 'Added' : !afterPresent ? 'Removed' : equal ? 'Unchanged' : 'Changed',
      beforePresent, afterPresent,
      before: beforePresent ? a : undefined,
      after: afterPresent ? b : undefined,
    })
  }

  function walk(a: unknown, b: unknown, path: string, depth: number) {
    if (rows.length >= MAX_ROWS || depth > MAX_DEPTH || ++visits > MAX_VISITS) {
      truncated = true
      return
    }
    if (isContainer(a) && isContainer(b) && Array.isArray(a) === Array.isArray(b)) {
      if (beforeParents.has(a) || afterParents.has(b)) {
        truncated = true
        return
      }
      beforeParents.add(a)
      afterParents.add(b)
      if (Array.isArray(a) && Array.isArray(b)) {
        const length = Math.max(a.length, b.length)
        if (length === 0) add(a, b, path, true)
        for (let index = 0; index < length; index++) {
          if (rows.length >= MAX_ROWS || visits >= MAX_VISITS) { truncated = true; break }
          walk(Object.hasOwn(a, index) ? a[index] : MISSING, Object.hasOwn(b, index) ? b[index] : MISSING, `${path}[${index}]`, depth + 1)
        }
      } else {
        const left = a as Record<string, unknown>
        const right = b as Record<string, unknown>
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
        if (keys.length === 0) add(a, b, path, true)
        for (const key of keys) {
          if (rows.length >= MAX_ROWS || visits >= MAX_VISITS) { truncated = true; break }
          walk(Object.hasOwn(left, key) ? left[key] : MISSING, Object.hasOwn(right, key) ? right[key] : MISSING, fieldPath(path, key), depth + 1)
        }
      }
      beforeParents.delete(a)
      afterParents.delete(b)
    } else {
      add(a, b, path)
    }
  }

  walk(before, after, '$', 0)
  const counts: Record<FieldChange, number> = { Added: 0, Changed: 0, Removed: 0, Unchanged: 0 }
  for (const row of rows) counts[row.change]++
  return { rows, counts, truncated }
}

/** Bound the displayed projection as well as its text; leave the original event intact. */
export function formatPreviewValue(value: unknown, maxLength = 240): { text: string; truncated: boolean } {
  let truncated = false
  let visits = 0
  const parents = new WeakSet<object>()
  const limit = Math.max(40, Math.min(16000, maxLength))

  function project(input: unknown, depth: number): unknown {
    if (++visits > 200 || depth > 8) { truncated = true; return '[omitted: preview limit]' }
    if (typeof input === 'string' && input.length > limit) { truncated = true; return `${input.slice(0, limit)}…` }
    if (isContainer(input)) {
      if (parents.has(input)) { truncated = true; return '[omitted: cyclic value]' }
      parents.add(input)
      let result: unknown
      if (Array.isArray(input)) {
        const items = input.slice(0, 100).map((item) => project(item, depth + 1))
        if (input.length > items.length) { truncated = true; items.push('[omitted: preview limit]') }
        result = items
      } else {
        const object: Record<string, unknown> = Object.create(null)
        const keys = Object.keys(input)
        for (const key of keys.slice(0, 100)) object[key] = project(input[key], depth + 1)
        if (keys.length > 100) { truncated = true; object['…'] = '[omitted: preview limit]' }
        result = object
      }
      parents.delete(input)
      return result
    }
    if (typeof input === 'bigint') return `${input}n`
    return input
  }

  let text: string
  try {
    text = JSON.stringify(project(value, 0), null, 2) ?? String(value)
  } catch {
    return { text: 'Preview cannot be displayed', truncated: true }
  }
  if (text.length > limit) { text = `${text.slice(0, limit)}…`; truncated = true }
  return { text, truncated }
}
