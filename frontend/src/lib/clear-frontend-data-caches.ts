import { clearSharedRequestCache } from '../api/requestCache'
import { resetRefreshCycleSnapshotId } from '../api/runtimeSnapshotSync'
import { clearConnectorsOverviewSnapshot } from '../components/connectors/connectors-overview-cache'
import { clearAdminSettingsSnapshot } from '../components/settings/admin-settings-session-cache'
import { clearDestinationsListSnapshot } from '../components/destinations/destinations-list-cache'
import { clearStreamsConsoleSnapshot } from '../components/streams/streams-console-cache'

/**
 * Drops in-memory request/session data caches that must not survive logout / user switch.
 * Safe to call repeatedly; does not touch JWT storage (handled by clearSession).
 *
 * Intentionally avoids importing `operationalSnapshot` / fixture-mode modules so
 * `auth/session` does not form a circular dependency with runtime fixture policy.
 * `clearSharedRequestCache()` already wipes the operational-snapshot namespace.
 */
export function clearFrontendDataCaches(): void {
  clearSharedRequestCache()
  resetRefreshCycleSnapshotId()
  clearDestinationsListSnapshot()
  clearConnectorsOverviewSnapshot()
  clearStreamsConsoleSnapshot()
  clearAdminSettingsSnapshot()
}
