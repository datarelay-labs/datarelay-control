import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchConnectorsList } from './gdcConnectors'
import { fetchSourcesList } from './gdcSources'
import { fetchCatalogSnapshot } from './gdcCatalog'

vi.mock('./gdcConnectors', () => ({ fetchConnectorsList: vi.fn() }))
vi.mock('./gdcSources', () => ({ fetchSourcesList: vi.fn() }))

const connector = {
  id: 7,
  name: 'Microsoft 365',
  status: 'STOPPED',
  description: null,
  stream_count: 0,
}
const source = {
  id: 11,
  connector_id: 7,
  source_type: 'HTTP_API_POLLING',
  enabled: true,
}

describe('catalog discovery distinguishes empty from unavailable', () => {
  beforeEach(() => {
    vi.mocked(fetchConnectorsList).mockReset().mockResolvedValue([])
    vi.mocked(fetchSourcesList).mockReset().mockResolvedValue([])
  })

  it('keeps a genuine empty API catalog available to the first-run Add Connector experience', async () => {
    expect(await fetchCatalogSnapshot()).toEqual({
      connectors: [], sources: [], apiBacked: true,
    })
  })

  it('retains saved connectors even when no sources have been configured yet', async () => {
    vi.mocked(fetchConnectorsList).mockResolvedValue([connector] as Awaited<ReturnType<typeof fetchConnectorsList>> & object[])
    const snapshot = await fetchCatalogSnapshot()
    expect(snapshot.apiBacked).toBe(true)
    expect(snapshot.connectors).toEqual([expect.objectContaining({ id: 7, name: 'Microsoft 365', source_count: 0 })])
    expect(snapshot.sources).toEqual([])
  })

  it('builds source ownership without collapsing Connector and Source', async () => {
    vi.mocked(fetchConnectorsList).mockResolvedValue([connector] as Awaited<ReturnType<typeof fetchConnectorsList>> & object[])
    vi.mocked(fetchSourcesList).mockResolvedValue([source] as Awaited<ReturnType<typeof fetchSourcesList>> & object[])
    const snapshot = await fetchCatalogSnapshot()
    expect(snapshot.apiBacked).toBe(true)
    expect(snapshot.connectors[0]?.source_count).toBe(1)
    expect(snapshot.sources[0]).toMatchObject({ id: 11, connector_id: 7 })
  })

  it('does not conflate API error and empty Connector list', async () => {
    vi.mocked(fetchConnectorsList).mockResolvedValue(null)
    const snapshot = await fetchCatalogSnapshot()
    expect(snapshot.apiBacked).toBe(false)
    expect(snapshot.connectors).toEqual([])
  })

  it('preserves successfully loaded Connectors if only Source catalog fails', async () => {
    vi.mocked(fetchConnectorsList).mockResolvedValue([connector] as Awaited<ReturnType<typeof fetchConnectorsList>> & object[])
    vi.mocked(fetchSourcesList).mockRejectedValue(new Error('temporary upstream failure'))
    const snapshot = await fetchCatalogSnapshot()
    expect(snapshot.apiBacked).toBe(false)
    expect(snapshot.connectors[0]?.id).toBe(7)
    expect(snapshot.sources).toEqual([])
  })
})
