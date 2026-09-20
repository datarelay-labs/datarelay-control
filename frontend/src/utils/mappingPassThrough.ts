/**
 * Unknown field pass-through — mirrors backend app.mappers.pass_through for local preview.
 */

import type { WizardMappingRow } from '../components/streams/wizard/wizard-state'

function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

function mapsWholeEvent(sourcePaths: string[]): boolean {
  return sourcePaths.some((p) => p.trim() === '$' || p.trim() === '')
}

export function parseJsonPathSegments(path: string): Array<string | number> {
  const p = path.trim()
  if (p === '$' || p === '') return []
  let remainder = p
  if (remainder.startsWith('$.')) remainder = remainder.slice(2)
  else if (remainder.startsWith('$')) remainder = remainder.slice(1).replace(/^\./, '')

  const segments: Array<string | number> = []
  let i = 0
  while (i < remainder.length) {
    if (remainder[i] === '.') {
      i += 1
      continue
    }
    if (remainder[i] === '[') {
      const end = remainder.indexOf(']', i)
      if (end < 0) break
      const raw = remainder.slice(i + 1, end).trim()
      if (/^\d+$/.test(raw)) segments.push(Number(raw))
      i = end + 1
      continue
    }
    const match = /^[^.[]+/.exec(remainder.slice(i))
    if (!match) break
    segments.push(match[0])
    i += match[0].length
  }
  return segments
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

function pruneEmptyContainers(node: unknown): void {
  if (Array.isArray(node)) {
    for (let idx = node.length - 1; idx >= 0; idx -= 1) {
      pruneEmptyContainers(node[idx])
      if (isEmptyContainer(node[idx])) node.splice(idx, 1)
    }
    return
  }
  if (!node || typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    pruneEmptyContainers(rec[key])
    if (isEmptyContainer(rec[key])) delete rec[key]
  }
}

export function removeAtJsonPath(root: Record<string, unknown>, path: string): void {
  const segments = parseJsonPathSegments(path)
  if (segments.length === 0) {
    for (const key of Object.keys(root)) delete root[key]
    return
  }

  const removeAt = (parent: unknown, remaining: Array<string | number>): void => {
    if (remaining.length === 0) return
    const key = remaining[0]
    const rest = remaining.slice(1)

    if (typeof key === 'number') {
      if (!Array.isArray(parent) || key < 0 || key >= parent.length) return
      if (rest.length === 0) {
        parent.splice(key, 1)
        return
      }
      removeAt(parent[key], rest)
      if (isEmptyContainer(parent[key])) parent.splice(key, 1)
      return
    }

    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return
    const obj = parent as Record<string, unknown>
    if (!(key in obj)) return
    if (rest.length === 0) {
      delete obj[key]
      return
    }
    removeAt(obj[key], rest)
    if (isEmptyContainer(obj[key])) delete obj[key]
  }

  removeAt(root, segments)
  pruneEmptyContainers(root)
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, srcVal] of Object.entries(source)) {
    if (!(key in target)) {
      target[key] = deepCopy(srcVal)
      continue
    }
    const tgtVal = target[key]
    if (tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal) && srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      mergeInto(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>)
    } else if (Array.isArray(tgtVal) && Array.isArray(srcVal)) {
      mergeArrays(tgtVal, srcVal)
    }
  }
}

function mergeArrays(target: unknown[], source: unknown[]): void {
  for (let idx = 0; idx < source.length; idx += 1) {
    const srcItem = source[idx]
    if (idx >= target.length) {
      target.push(deepCopy(srcItem))
      continue
    }
    const tgtItem = target[idx]
    if (tgtItem && typeof tgtItem === 'object' && !Array.isArray(tgtItem) && srcItem && typeof srcItem === 'object' && !Array.isArray(srcItem)) {
      mergeInto(tgtItem as Record<string, unknown>, srcItem as Record<string, unknown>)
    } else if (Array.isArray(tgtItem) && Array.isArray(srcItem)) {
      mergeArrays(tgtItem, srcItem)
    }
  }
}

export function deepMergePassThrough(
  output: Record<string, unknown>,
  residual: Record<string, unknown>,
): Record<string, unknown> {
  const merged = deepCopy(output)
  mergeInto(merged, residual)
  return merged
}

export function buildResidualAfterMapping(
  event: Record<string, unknown>,
  sourceJsonPaths: string[],
): Record<string, unknown> {
  const residual = deepCopy(event)
  for (const path of sourceJsonPaths) removeAtJsonPath(residual, path)
  pruneEmptyContainers(residual)
  return residual
}

export function mergeUnknownFieldPassThrough(
  event: Record<string, unknown>,
  output: Record<string, unknown>,
  sourceJsonPaths: string[],
): Record<string, unknown> {
  if (mapsWholeEvent(sourceJsonPaths)) return output
  const residual = buildResidualAfterMapping(event, sourceJsonPaths)
  if (Object.keys(residual).length === 0) return output
  return deepMergePassThrough(output, residual)
}

export function sourceJsonPathsFromMappingRows(rows: ReadonlyArray<WizardMappingRow>): string[] {
  return rows.map((r) => r.sourceJsonPath.trim()).filter(Boolean)
}

export function applyMappingWithPassThrough(
  event: Record<string, unknown> | null,
  rows: ReadonlyArray<WizardMappingRow>,
  resolvePath: (event: Record<string, unknown>, path: string) => unknown,
  unmappedFieldsPolicy: 'pass_through' | 'drop_unmapped' = 'pass_through',
): Record<string, unknown> {
  if (!event) return {}
  const sourcePaths = sourceJsonPathsFromMappingRows(rows)
  if (sourcePaths.length === 0) return deepCopy(event)

  const mapped: Record<string, unknown> = {}
  for (const row of rows) {
    const path = row.sourceJsonPath.trim()
    const key = row.outputField.trim()
    if (!path || !key) continue
    mapped[key] = resolvePath(event, path)
  }
  if (unmappedFieldsPolicy === 'drop_unmapped') {
    return mapped
  }
  return mergeUnknownFieldPassThrough(event, mapped, sourcePaths)
}
