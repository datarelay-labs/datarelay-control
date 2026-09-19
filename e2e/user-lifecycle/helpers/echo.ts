import { execFileSync } from 'node:child_process'
import { TIMEOUTS } from './types.js'

/** Actual destination evidence via webhook echo container logs (same pattern as prior ULC). */
export function echoLogsTail(tail = 5000): string {
  try {
    return execFileSync('docker', ['logs', '--tail', String(tail), 'gdc-webhook-receiver-test'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (e) {
    return `ECHO_LOG_ERROR:${e}`
  }
}

export function deliveredInEcho(logs: string, marker: string, pathFragment: string): boolean {
  // Require marker and path in the SAME echo request block. Never use a loose
  // cross-block fallback (marker on path A + path B text elsewhere → false PASS).
  const key = `"path": "${pathFragment}"`
  let idx = 0
  while (true) {
    const m = logs.indexOf(key, idx)
    if (m < 0) break
    const next = logs.indexOf('\n{\n    "path": ', m + key.length)
    const block = logs.slice(m, next < 0 ? undefined : next)
    if (block.includes(marker)) return true
    idx = m + key.length
  }
  return false
}

export async function waitForDelivery(
  marker: string,
  pathFragment: string,
  timeoutMs = TIMEOUTS.deliveryMs,
  pollMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = echoLogsTail()
    if (deliveredInEcho(logs, marker, pathFragment)) return true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return false
}

export function extractEchoBlock(logs: string, marker: string, pathFragment: string): string {
  const key = `"path": "${pathFragment}"`
  let idx = 0
  while (true) {
    const m = logs.indexOf(key, idx)
    if (m < 0) break
    const next = logs.indexOf('\n{\n    "path": ', m + key.length)
    const block = logs.slice(m, next < 0 ? undefined : next)
    if (block.includes(marker)) return block
    idx = m + key.length
  }
  return ''
}

export function echoPayloadLooksPartialMasked(block: string): boolean {
  if (!block) return false
  if (block.includes('test@example.invalid') || block.includes('maskme@example.com')) return false
  return /\*{2,}|@\*|\*+@/i.test(block) || /m\*+|te\*+/i.test(block)
}

export function echoPayloadLooksFullMasked(block: string): boolean {
  if (!block) return false
  if (block.includes('test@example.invalid') || block.includes('maskme@example.com')) return false
  return /\*{4,}|\[masked\]|redacted/i.test(block)
}

export function countMarkerInEcho(logs: string, marker: string): number {
  let count = 0
  let idx = 0
  while (true) {
    const m = logs.indexOf(marker, idx)
    if (m < 0) break
    count += 1
    idx = m + marker.length
  }
  return count
}
