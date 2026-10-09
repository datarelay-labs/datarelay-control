import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'

export type ShellRuntimePresentation = {
  label: 'Checking' | 'Healthy' | 'Attention' | 'Idle' | 'Stale' | 'Fixture' | 'Not verified'
  healthy: boolean | null
  evidence: string
}

/** Global health is a snapshot observation, never an inference from the current page or RUNNING flag. */
export function presentShellRuntimeStatus(
  snapshot: OperationalSnapshotResponse | null,
  options: { loading?: boolean; fixture?: boolean; nowMs?: number } = {},
): ShellRuntimePresentation {
  const { loading = false, fixture = false, nowMs = Date.now() } = options
  if (loading && !snapshot) {
    return { label: 'Checking', healthy: null, evidence: 'Checking the runtime snapshot…' }
  }
  if (!snapshot) {
    return { label: 'Not verified', healthy: null, evidence: 'Runtime snapshot unavailable; connectivity and delivery are not confirmed.' }
  }
  if (fixture) {
    return { label: 'Fixture', healthy: null, evidence: 'Development fixture data — not live runtime or receiver evidence.' }
  }

  const snapshotMs = Date.parse(snapshot.updated_at)
  if (!Number.isFinite(snapshotMs) || snapshotMs > nowMs + 60_000 || nowMs - snapshotMs > 90_000) {
    return { label: 'Stale', healthy: null, evidence: 'Runtime snapshot is stale; current operational health is not confirmed.' }
  }

  const global = snapshot.global
  if (
    !global ||
    !Number.isSafeInteger(global.enabled_streams) ||
    global.enabled_streams < 0 ||
    !Number.isSafeInteger(global.running_streams) ||
    global.running_streams < 0 ||
    !Number.isSafeInteger(global.total_routes) ||
    global.total_routes < 0
  ) {
    return { label: 'Not verified', healthy: null, evidence: 'Runtime snapshot contains invalid counters.' }
  }

  const counts = `${global.running_streams} running / ${global.enabled_streams} enabled Streams · ${global.total_routes} Routes`
  if (global.enabled_streams === 0 || global.running_streams === 0 || global.health_status === 'IDLE') {
    return { label: 'Idle', healthy: null, evidence: `Snapshot: ${counts}. No active delivery is asserted.` }
  }
  if (global.health_status === 'HEALTHY') {
    return { label: 'Healthy', healthy: true, evidence: `Runtime snapshot: ${counts}. Receiver ingestion is not verified.` }
  }
  if (global.health_status === 'DEGRADED' || global.health_status === 'ERROR') {
    return { label: 'Attention', healthy: false, evidence: `Runtime snapshot (${global.health_status.toLowerCase()}): ${counts}. Investigate affected flows.` }
  }
  return { label: 'Not verified', healthy: null, evidence: 'Runtime snapshot health is unknown.' }
}
