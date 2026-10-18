import { fetchConnectorsList } from './gdcConnectors'
import { fetchSourcesList } from './gdcSources'

/**
 * Stream Wizard Connector/Source catalog from the existing list endpoints.
 * A successful empty list is a legitimate first-run state. Null/rejected
 * reads are unverified, must not be reported as zero configured resources,
 * and must never be replaced with synthetic operator configuration.
 * Connector and Source remain separate persisted entities.
 */

export type CatalogConnector = {
  id: number
  name: string
  description: string | null
  status: string
  source_count: number
  stream_count: number
}

export type CatalogSource = {
  id: number
  connector_id: number
  source_type: string
  enabled: boolean
  display_name: string
  /** Stream rows already attached to this source (preview only). */
  stream_count: number
}

export type CatalogSnapshot = {
  connectors: CatalogConnector[]
  sources: CatalogSource[]
  /** True only when both Connector and Source catalogs responded successfully, including valid empty catalogs. */
  apiBacked: boolean
}

/**
 * Best-effort Connector + Source catalog. Empty successful catalogs are
 * distinguishable from inaccessible/failed catalogs. Never treat an API
 * failure as proof that the operator has zero configured Connectors.
 */
export async function fetchCatalogSnapshot(): Promise<CatalogSnapshot> {
  const [connectorResult, sourceResult] = await Promise.allSettled([fetchConnectorsList(), fetchSourcesList()])
  const connectorsRaw = connectorResult.status === 'fulfilled' ? connectorResult.value : null
  const sourcesRaw = sourceResult.status === 'fulfilled' ? sourceResult.value : null
  const connectorCatalogReady = Array.isArray(connectorsRaw)
  const sourceCatalogReady = Array.isArray(sourcesRaw)
  const connectorsLoaded = connectorCatalogReady ? connectorsRaw : []
  const sourcesLoaded = sourceCatalogReady ? sourcesRaw : []
  const sourceCountByConnector = new Map<number, number>()
  for (const source of sourcesLoaded) {
    const cid = Number(source.connector_id ?? 0)
    sourceCountByConnector.set(cid, (sourceCountByConnector.get(cid) ?? 0) + 1)
  }
  const connectors: CatalogConnector[] = connectorsLoaded.map((c) => ({
    id: c.id,
    name: c.name ?? `Connector #${c.id}`,
    description: c.description ?? null,
    status: c.status ?? 'STOPPED',
    source_count: sourceCountByConnector.get(c.id) ?? 0,
    stream_count: 0,
  }))
  const sources: CatalogSource[] = sourcesLoaded.map((s) => {
    const owner = connectors.find((c) => c.id === s.connector_id)
    return {
      id: s.id,
      connector_id: Number(s.connector_id ?? 0),
      source_type: s.source_type ?? 'HTTP_API_POLLING',
      enabled: Boolean(s.enabled),
      display_name: owner ? `${owner.name} · ${s.source_type ?? 'HTTP_API_POLLING'}` : `Source #${s.id}`,
      stream_count: 0,
    }
  })

  return {
    connectors,
    sources,
    apiBacked: connectorCatalogReady && sourceCatalogReady,
  }
}
