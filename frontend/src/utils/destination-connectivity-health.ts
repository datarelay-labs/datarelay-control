import type { DestinationRead } from '../api/gdcDestinations'
import type { OperationalDestinationSnapshot } from '../api/operationalSnapshot'
import type { OperationalUiHealthLabel } from '../lib/operational-snapshot-selectors'

export type DestinationConnectivityFields = Pick<
  DestinationRead,
  'last_connectivity_test_success' | 'last_connectivity_test_at'
>

/** True when a persisted destination connectivity probe succeeded. */
export function isDestinationConnectivityVerified(
  dest: DestinationConnectivityFields | undefined | null,
): boolean {
  if (!dest) return false
  return dest.last_connectivity_test_success === true
}

function snapshotHasDeliveryTraffic(snapshot: OperationalDestinationSnapshot | null | undefined): boolean {
  if (!snapshot) return false
  const inbound = typeof snapshot.inbound_eps_1m === 'number' ? Math.max(0, snapshot.inbound_eps_1m) : 0
  const failed = typeof snapshot.failed_eps_1m === 'number' ? Math.max(0, snapshot.failed_eps_1m) : 0
  return inbound + failed > 0 || snapshot.last_success_at != null || snapshot.last_error_at != null
}

const PROBE_ONLY_LABEL: OperationalUiHealthLabel = 'Connectivity verified · No deliveries observed'

/** A runtime verdict that must never be masked by a passing connectivity probe. */
function isProblemLabel(label: OperationalUiHealthLabel | undefined): boolean {
  return label === 'Critical' || label === 'Error' || label === 'Warning'
}

/**
 * List/overview health. A passing probe proves reachability only, never delivery health:
 * - a snapshot Error/Critical/Warning always wins (Unknown never masks a confirmed problem);
 * - a probe with zero observed deliveries reads "Connectivity verified - No deliveries observed", not Healthy;
 * - Healthy requires an actual delivery observation reported by the snapshot.
 */
export function resolveDestinationListUiHealth(
  row: DestinationConnectivityFields & { enabled: boolean },
  snapshot: OperationalDestinationSnapshot | null | undefined,
  snapshotLabel: OperationalUiHealthLabel | undefined,
): OperationalUiHealthLabel {
  if (!row.enabled) return 'Disabled'
  const connectivityOk = isDestinationConnectivityVerified(row)
  const hasTraffic = snapshotHasDeliveryTraffic(snapshot)

  if (isProblemLabel(snapshotLabel)) return snapshotLabel as OperationalUiHealthLabel
  if (snapshot?.health_status === 'ERROR') return 'Critical'
  if (snapshot?.health_status === 'DEGRADED') return 'Warning'

  if (connectivityOk && !hasTraffic) return PROBE_ONLY_LABEL

  if (snapshotLabel) return snapshotLabel
  if (connectivityOk) return PROBE_ONLY_LABEL
  return 'Idle'
}
