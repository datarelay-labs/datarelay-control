import type { CatalogSnapshot } from '../../../api/gdcCatalog'
import type { DestinationListItem } from '../../../api/gdcDestinations'

export type Availability = 'checking' | 'available' | 'needs-setup' | 'not-verified'
export type ResourceSummary = { state: Availability; description: string }
export type ReadinessResult = {
  source: ResourceSummary
  destination: ResourceSummary
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function selectableId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

const notVerified: ResourceSummary = {
  state: 'not-verified',
  description: 'Could not verify saved resources. Check your session or API connectivity.',
}

export function summarizeResourceReadiness(
  catalog: CatalogSnapshot | null,
  destinations: DestinationListItem[] | null,
): ReadinessResult {
  let source: ResourceSummary = notVerified
  if (catalog?.apiBacked === true) {
    const usableConnectors = catalog.connectors.filter((row) => selectableId(row.id))
    const connectorIds = new Set(usableConnectors.map((row) => row.id))
    const usableSources = catalog.sources.filter((row) => selectableId(row.id))
    const enabledSources = usableSources.filter((row) => row.enabled && connectorIds.has(row.connector_id))
    if (catalog.connectors.length > 0 && usableConnectors.length === 0) {
      source = { state: 'not-verified', description: 'Saved Connector IDs could not be verified. Recheck resources before selecting a Source.' }
    } else if (catalog.connectors.length === 0) {
      source = { state: 'needs-setup', description: 'No saved Connectors. Add one during Connect.' }
    } else if (catalog.sources.length === 0) {
      source = {
        state: 'needs-setup',
        description: `${countLabel(usableConnectors.length, 'saved Connector')}, but no saved Sources. Complete Source access during Connect.`,
      }
    } else if (usableSources.length === 0) {
      source = { state: 'not-verified', description: 'Saved Source IDs could not be verified. Recheck resources before selecting a Source.' }
    } else if (enabledSources.length === 0) {
      source = {
        state: 'needs-setup',
        description: `${countLabel(usableSources.length, 'saved Source')}, but none enabled and linked to a saved Connector. Review Source configuration.`,
      }
    } else {
      source = {
        state: 'available',
        description: `${countLabel(usableConnectors.length, 'saved Connector')} · ${countLabel(enabledSources.length, 'enabled Source')}. Select and test the correct Source.`,
      }
    }
  }

  let destination: ResourceSummary = notVerified
  if (destinations != null) {
    const usableDestinations = destinations.filter((row) => selectableId(row.id))
    const enabledCount = usableDestinations.filter((row) => row.enabled).length
    if (enabledCount > 0) {
      destination = {
        state: 'available',
        description: `${countLabel(enabledCount, 'enabled Destination')} available for selection. Delivery is not yet verified.`,
      }
    } else if (usableDestinations.length > 0) {
      destination = {
        state: 'needs-setup',
        description: `${countLabel(usableDestinations.length, 'saved Destination')}, none enabled. Review existing settings before configuring Routes.`,
      }
    } else if (destinations.length > 0) {
      destination = { state: 'not-verified', description: 'Saved Destination IDs could not be verified. Recheck resources before configuring Routes.' }
    } else {
      destination = { state: 'needs-setup', description: 'No saved Destinations. You will need one before Route Processing.' }
    }
  }
  return { source, destination }
}
