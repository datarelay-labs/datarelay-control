import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as requestCache from './requestCache'
import { CATALOG_CONNECTORS_LIST_KEY } from './catalogListCache'

const requestJson = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    requestJson: (...args: unknown[]) => requestJson(...args),
  }
})

describe('connector mutation catalog invalidation', () => {
  beforeEach(() => {
    requestCache.clearSharedRequestCache()
    vi.clearAllMocks()
  })

  it('updateConnector invalidates list and by-id caches', async () => {
    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValue({ id: 9, name: 'Updated' })
    const { updateConnector } = await import('./gdcConnectors')
    await updateConnector(9, {
      name: 'Updated',
      expected_updated_at: '2026-01-01T00:00:00Z',
      expected_source_updated_at: '2026-01-01T00:00:00Z',
    })
    expect(clearSpy).toHaveBeenCalledWith('catalog-connectors', CATALOG_CONNECTORS_LIST_KEY)
    expect(clearSpy).toHaveBeenCalledWith('catalog-connector-by-id', '9')
  })

  it('deleteConnector invalidates list and by-id caches', async () => {
    const clearSpy = vi.spyOn(requestCache, 'clearSharedRequestCache')
    requestJson.mockResolvedValue(undefined)
    const { deleteConnector } = await import('./gdcConnectors')
    await deleteConnector(4)
    expect(clearSpy).toHaveBeenCalledWith('catalog-connectors', CATALOG_CONNECTORS_LIST_KEY)
    expect(clearSpy).toHaveBeenCalledWith('catalog-connector-by-id', '4')
  })
})
