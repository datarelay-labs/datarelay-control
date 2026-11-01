import { clearSharedRequestCache } from './requestCache'

/** Short TTL for catalog list reads — dedupes cross-page navigation without stale config risk. */
export const CATALOG_LIST_CACHE_TTL_MS = 15_000

export const CATALOG_STREAMS_LIST_KEY = 'list-v1'
export const CATALOG_CONNECTORS_LIST_KEY = 'list-v1'
export const CATALOG_DESTINATIONS_LIST_KEY = 'list-v1'
export const CATALOG_ROUTES_LIST_KEY = 'list-v1'

export const STREAMS_LIST_CACHE_NS = 'catalog-streams'
export const STREAM_BY_ID_CACHE_NS = 'catalog-stream-by-id'

/** Clears the cached stream list and (optionally) one stream-by-id read. */
export function invalidateStreamCatalogCache(streamId?: number): void {
  clearSharedRequestCache(STREAMS_LIST_CACHE_NS, CATALOG_STREAMS_LIST_KEY)
  if (streamId != null) {
    clearSharedRequestCache(STREAM_BY_ID_CACHE_NS, String(streamId))
  }
}
