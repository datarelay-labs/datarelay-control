import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as requestCache from './requestCache'

const requestJson = vi.fn()
const safeRequestJson = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    requestJson: (...args: unknown[]) => requestJson(...args),
    safeRequestJson: (...args: unknown[]) => safeRequestJson(...args),
  }
})

describe('updating an object another session deleted (F-231)', () => {
  beforeEach(() => {
    requestCache.clearSharedRequestCache()
    vi.clearAllMocks()
    // The fallback GET used to learn the current revision finds nothing.
    safeRequestJson.mockResolvedValue(null)
  })

  it('updateConnector says the connector could not be found, not that a field is missing', async () => {
    const { updateConnector } = await import('./gdcConnectors')
    const failure = updateConnector(21, { name: 'Edited' })
    await expect(failure).rejects.toThrow(/Connector #21 could not be found/)
    await expect(failure).rejects.toThrow(/deleted from another session/)
    await expect(failure).rejects.not.toThrow(/expected_updated_at/)
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('updateStream says the stream could not be found, not that a field is missing', async () => {
    const { updateStream } = await import('./gdcStreams')
    const failure = updateStream(8, { name: 'Edited' } as never)
    await expect(failure).rejects.toThrow(/Stream #8 could not be found/)
    await expect(failure).rejects.not.toThrow(/expected_updated_at/)
    expect(requestJson).not.toHaveBeenCalled()
  })
})
