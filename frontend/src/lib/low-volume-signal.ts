/** Canonical Control v1 low-volume signal contract. */
export const LOW_VOLUME_EVENT_THRESHOLD_PER_HOUR = 50

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Operational snapshots expose short-window EPS rather than a literal 1h count.
 * Stream Console already projects snapshot EPS to an hourly event estimate; keep
 * Dashboard and other operator surfaces on the same deterministic contract.
 */
export function estimatedHourlyEventsFromEps(
  eps1m: number | null | undefined,
  eps5m: number | null | undefined,
): number {
  const eps = finiteNonNegative(eps1m) || finiteNonNegative(eps5m)
  return eps > 0 ? Math.round(eps * 3600) : 0
}

export function isLowVolumeHourlyEvents(eventsPerHour: number | null | undefined): boolean {
  if (typeof eventsPerHour !== 'number' || !Number.isFinite(eventsPerHour)) return false
  return eventsPerHour > 0 && eventsPerHour < LOW_VOLUME_EVENT_THRESHOLD_PER_HOUR
}

export function isLowVolumeEps(
  eps1m: number | null | undefined,
  eps5m: number | null | undefined,
): boolean {
  return isLowVolumeHourlyEvents(estimatedHourlyEventsFromEps(eps1m, eps5m))
}
