import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeRequestJsonResult } from './api'

describe('safeRequestJsonResult auth semantics', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sets authRequired only for 401, not 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const forbidden = await safeRequestJsonResult('/api/v1/streams/')
    expect(forbidden.ok).toBe(false)
    if (!forbidden.ok) {
      expect(forbidden.status).toBe(403)
      expect(forbidden.authRequired).toBe(false)
    }

    const unauthorized = await safeRequestJsonResult('/api/v1/streams/')
    expect(unauthorized.ok).toBe(false)
    if (!unauthorized.ok) {
      expect(unauthorized.status).toBe(401)
      expect(unauthorized.authRequired).toBe(true)
    }
  })
})
