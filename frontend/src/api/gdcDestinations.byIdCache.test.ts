import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as rawApi from '../api'
import { CATALOG_DESTINATIONS_LIST_KEY, CATALOG_LIST_CACHE_TTL_MS } from './catalogListCache'
import {
  createDestination,
  deleteDestination,
  fetchDestinationById,
  testDestination,
  updateDestination,
} from './gdcDestinations'
import * as requestCache from './requestCache'

const requestJson = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    requestJson: (...args: unknown[]) => requestJson(...args),
  }
})

describe('destination by-id request cache', () => {
  beforeEach(() => {
    requestCache.clearSharedRequestCache()
    vi.restoreAllMocks()
    requestJson.mockReset()
  })

  it('dedupes concurrent/near-concurrent same-id fetches to one HTTP', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue({
      id: 7,
      name: 'Dest-7',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })

    const [a, b] = await Promise.all([fetchDestinationById(7), fetchDestinationById(7)])
    expect(a?.name).toBe('Dest-7')
    expect(b).toEqual(a)
    expect(apiSpy).toHaveBeenCalledTimes(1)

    await fetchDestinationById(7)
    expect(apiSpy).toHaveBeenCalledTimes(1)
  })

  it('isolates HTTP by destination id', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockImplementation(async (url: string) => {
      if (url.includes('/destinations/1')) {
        return { id: 1, name: 'D1', destination_type: 'SYSLOG_UDP', enabled: true, config_json: {}, rate_limit_json: {} }
      }
      return { id: 2, name: 'D2', destination_type: 'SYSLOG_TCP', enabled: true, config_json: {}, rate_limit_json: {} }
    })

    const d1 = await fetchDestinationById(1)
    const d2 = await fetchDestinationById(2)
    expect(d1?.name).toBe('D1')
    expect(d2?.name).toBe('D2')
    expect(apiSpy).toHaveBeenCalledTimes(2)
  })

  it('refetches after TTL elapses', async () => {
    vi.useFakeTimers()
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue({
      id: 3,
      name: 'D3',
      destination_type: 'WEBHOOK_POST',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })
    await fetchDestinationById(3)
    vi.advanceTimersByTime(CATALOG_LIST_CACHE_TTL_MS)
    await fetchDestinationById(3)
    expect(apiSpy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('updateDestination invalidates list and by-id; unrelated id stays cached', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockImplementation(async (url: string) => {
      if (url.includes('/destinations/7')) {
        return { id: 7, name: 'D7', destination_type: 'SYSLOG_UDP', enabled: true, config_json: {}, rate_limit_json: {} }
      }
      return { id: 8, name: 'D8', destination_type: 'SYSLOG_UDP', enabled: true, config_json: {}, rate_limit_json: {} }
    })
    await fetchDestinationById(7)
    await fetchDestinationById(8)
    expect(apiSpy).toHaveBeenCalledTimes(2)

    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValue({
      id: 7,
      name: 'D7-updated',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })
    await updateDestination(7, { name: 'D7-updated', expected_updated_at: '2026-01-01T00:00:00Z' })
    expect(clearSpy).toHaveBeenCalledWith('catalog-destinations', CATALOG_DESTINATIONS_LIST_KEY)
    expect(clearSpy).toHaveBeenCalledWith('catalog-destination-by-id', '7')
    expect(clearSpy).not.toHaveBeenCalledWith('catalog-destination-by-id', '8')

    apiSpy.mockResolvedValueOnce({
      id: 7,
      name: 'D7-updated',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })
    const refreshed = await fetchDestinationById(7)
    expect(refreshed?.name).toBe('D7-updated')
    expect(apiSpy).toHaveBeenCalledTimes(3)

    await fetchDestinationById(8)
    expect(apiSpy).toHaveBeenCalledTimes(3)
  })

  it('createDestination and deleteDestination invalidate by-id', async () => {
    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValueOnce({
      id: 11,
      name: 'New',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })
    await createDestination({
      name: 'New',
      destination_type: 'SYSLOG_UDP',
      config_json: {},
    })
    expect(clearSpy).toHaveBeenCalledWith('catalog-destination-by-id', '11')

    requestJson.mockResolvedValueOnce(undefined)
    await deleteDestination(11)
    expect(clearSpy).toHaveBeenCalledWith('catalog-destination-by-id', '11')
  })

  it('testDestination invalidates by-id so next fetch is fresh HTTP', async () => {
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson').mockResolvedValue({
      id: 9,
      name: 'D9',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
    })
    await fetchDestinationById(9)
    expect(apiSpy).toHaveBeenCalledTimes(1)

    requestJson.mockResolvedValue({
      success: true,
      latency_ms: 12,
      message: 'ok',
      tested_at: '2026-01-01T00:00:00Z',
    })
    await testDestination(9)

    apiSpy.mockResolvedValueOnce({
      id: 9,
      name: 'D9',
      destination_type: 'SYSLOG_UDP',
      enabled: true,
      config_json: {},
      rate_limit_json: {},
      last_connectivity_test_success: true,
    })
    await fetchDestinationById(9)
    expect(apiSpy).toHaveBeenCalledTimes(2)
  })
})
