export type LogsDiagnosisSnapshot = {
  loadedFailedDeliveries: number
  loadedSuccessfulDeliveries: number
  errorRows: number
  warningRows: number
  loadedRows: number
  globalFailed: number | null
  globalSuccess: number | null
  lifecycleRows: number | null
  windowLabel: string
  /** True when a Stream/Route/Destination/Run filter is active (global totals do not apply). */
  scoped?: boolean
}

/**
 * Observability summary totals are platform-wide. When the Logs view is scoped to a Stream,
 * Route, Destination or Run, they describe other resources, so they must not feed the posture
 * of the scoped view (F-161). Only the scoped loaded sample is evidence there.
 */
export function buildLogsDiagnosisSnapshot(input: {
  loadedFailedDeliveries: number
  loadedSuccessfulDeliveries: number
  errorRows: number
  warningRows: number
  loadedRows: number
  globalFailed: number | null
  globalSuccess: number | null
  lifecycleRows: number | null
  windowLabel: string
  scoped: boolean
}): LogsDiagnosisSnapshot {
  if (!input.scoped) return { ...input }
  return { ...input, globalFailed: null, globalSuccess: null }
}
