import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as rawApi from '../api'
import { fetchRoutesList } from './gdcRoutes'
import { clearSharedRequestCache } from './requestCache'

vi.mock('../lib/runtime-operational-fixture-mode', () => ({
  canUseOperationalFixture: async () => false,
  loadOperationalSnapshotFixture: async () => null,
  routeReadsFromOperationalSnapshot: () => [],
}))

describe('fetchRoutesList payload contract', () => {
  beforeEach(() => {
    clearSharedRequestCache()
    vi.restoreAllMocks()
  })

  it('returns an empty array for a genuine empty catalog', async () => {
    vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue([])
    await expect(fetchRoutesList()).resolves.toEqual([])
  })

  it('returns null when the payload is not an array', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson')
    apiSpy.mockResolvedValueOnce(null)
    await expect(fetchRoutesList()).resolves.toBeNull()

    clearSharedRequestCache()
    apiSpy.mockResolvedValueOnce({ message: 'not a list' })
    await expect(fetchRoutesList()).resolves.toBeNull()
  })

  it('returns null when a non-empty payload contains no valid route rows', async () => {
    vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue([{ name: 'missing id' }, null, { id: 'bad' }])
    await expect(fetchRoutesList()).resolves.toBeNull()
  })

  it('keeps valid route rows from a mixed payload', async () => {
    vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue([
      { name: 'missing id' },
      { id: 42, name: 'Route A', stream_id: 10 },
    ])
    await expect(fetchRoutesList()).resolves.toEqual([{ id: 42, name: 'Route A', stream_id: 10 }])
  })
})
