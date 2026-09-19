/** Shared timeouts for browser / runtime / delivery waits. No infinite waits. */
export const TIMEOUTS = {
  shortMs: 5_000,
  navMs: 15_000,
  actionMs: 30_000,
  apiMs: 20_000,
  deliveryMs: 90_000,
  schedulerPollMs: 120_000,
  observeDefaultMinutes: Number(process.env.ULC_OBSERVE_MINUTES || 30),
  pageDefaultMs: 180_000,
} as const

export function createRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const rand = Math.random().toString(16).slice(2, 8)
  return process.env.ULC_RUN_ID || `ulc-${stamp}-${rand}`
}

export type EvidenceLevel =
  | 'BROWSER_E2E'
  | 'API_INTEGRATION'
  | 'RUNTIME_E2E'
  | 'ACTUAL_DELIVERY'
  | 'STATIC_ONLY'
  | 'NOT_PROVEN'

export type ScenarioStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED' | 'SKIP' | 'NOT_APPLICABLE'

export type ScenarioDef = {
  id: string
  group: string
  title: string
  tags: string[]
  /** When true, skipped on resume if already PASS */
  resumable?: boolean
}
