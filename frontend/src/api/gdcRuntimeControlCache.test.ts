import { afterEach, describe, expect, it, vi } from 'vitest'
import * as rawApi from '../api'
import { startRuntimeStream, stopRuntimeStream } from './gdcRuntime'
import { fetchStreamById, fetchStreamsList } from './gdcStreams'
import { clearSharedRequestCache } from './requestCache'

// C6: Start/Stop did not invalidate the 15 s TTL caches for stream reads, so the scheduler switch
// re-read the old status (e.g. "Stopped" ~12 s after a successful start) until a reload.
// On the old code the post-control read below is served from cache and still returns STOPPED.
describe('runtime stream control invalidates cached stream status reads (C6)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    clearSharedRequestCache()
  })

  function mockApi(statusRef: { current: string }) {
    vi.spyOn(rawApi, 'safeRequestJson').mockImplementation((async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && /\/runtime\/streams\/7\/(start|stop)$/.test(url)) {
        statusRef.current = url.endsWith('/start') ? 'RUNNING' : 'STOPPED'
        return { stream_id: 7, enabled: statusRef.current === 'RUNNING', status: statusRef.current, action: 'start', message: 'ok' }
      }
      if (/\/streams\/7$/.test(url)) return { id: 7, name: 'S', status: statusRef.current }
      return null
    }) as typeof rawApi.safeRequestJson)
    vi.spyOn(rawApi, 'safeRequestJsonResult').mockImplementation((async () => ({
      ok: true,
      status: 200,
      data: [{ id: 7, name: 'S', status: statusRef.current }],
    })) as unknown as typeof rawApi.safeRequestJsonResult)
  }

  it('re-reads stream-by-id after a successful start and stop', async () => {
    const status = { current: 'STOPPED' }
    mockApi(status)

    expect((await fetchStreamById(7))?.status).toBe('STOPPED')
    await startRuntimeStream(7)
    expect((await fetchStreamById(7))?.status).toBe('RUNNING')
    await stopRuntimeStream(7)
    expect((await fetchStreamById(7))?.status).toBe('STOPPED')
  })

  it('re-reads the stream list after a successful start', async () => {
    const status = { current: 'STOPPED' }
    mockApi(status)

    const before = await fetchStreamsList()
    expect(before?.[0]?.status).toBe('STOPPED')
    await startRuntimeStream(7)
    const after = await fetchStreamsList()
    expect(after?.[0]?.status).toBe('RUNNING')
  })
})
