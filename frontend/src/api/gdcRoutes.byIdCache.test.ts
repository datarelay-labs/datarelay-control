import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as rawApi from '../api'
import { CATALOG_LIST_CACHE_TTL_MS, CATALOG_ROUTES_LIST_KEY } from './catalogListCache'
import { createRoute, deleteRoute, fetchRouteById, updateRoute } from './gdcRoutes'
import * as requestCache from './requestCache'

const requestJson = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    requestJson: (...args: unknown[]) => requestJson(...args),
  }
})

vi.mock('../lib/runtime-operational-fixture-mode', () => ({
  canUseOperationalFixture: async () => false,
  loadOperationalSnapshotFixture: async () => null,
  routeReadsFromOperationalSnapshot: () => [],
}))

describe('route by-id request cache', () => {
  beforeEach(() => {
    requestCache.clearSharedRequestCache()
    vi.restoreAllMocks()
    requestJson.mockReset()
  })

  it('dedupes concurrent/near-concurrent same-id fetches to one HTTP', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue({
      id: 42,
      name: 'Route A',
      stream_id: 10,
      destination_id: 5,
      enabled: true,
    })

    const [a, b] = await Promise.all([fetchRouteById(42), fetchRouteById(42)])
    expect(a?.name).toBe('Route A')
    expect(b).toEqual(a)
    expect(apiSpy).toHaveBeenCalledTimes(1)

    await fetchRouteById(42)
    expect(apiSpy).toHaveBeenCalledTimes(1)
  })

  it('isolates HTTP by route id', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockImplementation(async (url: string) => {
      if (url.includes('/routes/1')) {
        return { id: 1, name: 'R1', stream_id: 10, destination_id: 5, enabled: true }
      }
      return { id: 2, name: 'R2', stream_id: 11, destination_id: 6, enabled: true }
    })

    const r1 = await fetchRouteById(1)
    const r2 = await fetchRouteById(2)
    expect(r1?.name).toBe('R1')
    expect(r2?.name).toBe('R2')
    expect(apiSpy).toHaveBeenCalledTimes(2)
  })

  it('refetches after TTL elapses', async () => {
    vi.useFakeTimers()
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue({
      id: 3,
      name: 'R3',
      enabled: true,
    })
    await fetchRouteById(3)
    vi.advanceTimersByTime(CATALOG_LIST_CACHE_TTL_MS)
    await fetchRouteById(3)
    expect(apiSpy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('updateRoute invalidates list and by-id; unrelated id stays cached', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockImplementation(async (url: string) => {
      if (url.includes('/routes/7')) {
        return { id: 7, name: 'R7', enabled: true }
      }
      return { id: 8, name: 'R8', enabled: true }
    })
    await fetchRouteById(7)
    await fetchRouteById(8)
    expect(apiSpy).toHaveBeenCalledTimes(2)

    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValue({ id: 7, name: 'R7-updated', enabled: false })
    await updateRoute(7, {
      name: 'R7-updated',
      enabled: false,
      expected_updated_at: '2026-01-01T00:00:00Z',
    })
    expect(clearSpy).toHaveBeenCalledWith('catalog-routes', CATALOG_ROUTES_LIST_KEY)
    expect(clearSpy).toHaveBeenCalledWith('catalog-route-by-id', '7')
    expect(clearSpy).not.toHaveBeenCalledWith('catalog-route-by-id', '8')

    apiSpy.mockResolvedValueOnce({ id: 7, name: 'R7-updated', enabled: false })
    const refreshed = await fetchRouteById(7)
    expect(refreshed?.name).toBe('R7-updated')
    expect(apiSpy).toHaveBeenCalledTimes(3)

    await fetchRouteById(8)
    expect(apiSpy).toHaveBeenCalledTimes(3)
  })

  it('createRoute and deleteRoute invalidate by-id', async () => {
    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValueOnce({ id: 15, name: 'New route', enabled: true })
    await createRoute({ name: 'New route', stream_id: 1, destination_id: 2 })
    expect(clearSpy).toHaveBeenCalledWith('catalog-route-by-id', '15')

    requestJson.mockResolvedValueOnce(undefined)
    await deleteRoute(15)
    expect(clearSpy).toHaveBeenCalledWith('catalog-route-by-id', '15')
  })
})
