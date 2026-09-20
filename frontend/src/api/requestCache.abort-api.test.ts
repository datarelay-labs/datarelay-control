import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRequestAborted } from '../lib/request-abort'
import { clearSharedRequestCache } from './requestCache'
import * as rawApi from '../api'
import { fetchRoutesList } from './gdcRoutes'

describe('cachedRequest API abort handling', () => {
  beforeEach(() => {
    clearSharedRequestCache()
    vi.restoreAllMocks()
  })

  it('does not emit unhandled rejection when fetchRoutesList aborts without an awaiter', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const controller = new AbortController()
      vi.spyOn(rawApi, 'safeRequestJson').mockImplementation(
        (_url, init) =>
          new Promise((resolve, reject) => {
            const signal = init && typeof init === 'object' && 'signal' in init ? (init as { signal?: AbortSignal }).signal : undefined
            signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
              once: true,
            })
            setTimeout(() => resolve([]), 100)
          }),
      )

      void fetchRoutesList({ signal: controller.signal })
      controller.abort()
      await new Promise((r) => setTimeout(r, 50))
      expect(rejections.filter((reason) => isRequestAborted(reason))).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
