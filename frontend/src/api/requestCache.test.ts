import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAbortError, isRequestAborted } from '../lib/request-abort'
import { cachedRequest, clearSharedRequestCache } from './requestCache'

describe('shared request cache', () => {
  beforeEach(() => {
    clearSharedRequestCache()
    vi.restoreAllMocks()
  })

  it('deduplicates in-flight requests for the same namespace and key', async () => {
    const loader = vi.fn(async () => 'ok')

    const [first, second] = await Promise.all([
      cachedRequest('routes-runtime', 'same-key', loader),
      cachedRequest('routes-runtime', 'same-key', loader),
    ])

    expect(first).toBe('ok')
    expect(second).toBe('ok')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('keeps namespaces isolated', async () => {
    const loader = vi.fn(async () => 'ok')

    await cachedRequest('routes-runtime-a', 'same-key', loader)
    await cachedRequest('routes-runtime-b', 'same-key', loader)

    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('evicts in-flight cache entry when the page signal aborts', async () => {
    const controller = new AbortController()
    let resolveLoader: ((value: string) => void) | undefined
    const loader = vi.fn((signal?: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(createAbortError()), { once: true })
        resolveLoader = resolve
      }),
    )

    const pending = cachedRequest('routes-runtime', 'abort-key', loader, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    resolveLoader?.('late')
    await Promise.resolve()

    const loaderAfterAbort = vi.fn(async () => 'fresh')
    await expect(cachedRequest('routes-runtime', 'abort-key', loaderAfterAbort)).resolves.toBe('fresh')
    expect(loaderAfterAbort).toHaveBeenCalledTimes(1)
  })

  it('throws immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const loader = vi.fn(async () => 'ok')

    await expect(
      cachedRequest('routes-runtime', 'pre-aborted', loader, { signal: controller.signal }),
    ).rejects.toEqual(createAbortError())
    expect(loader).not.toHaveBeenCalled()
  })

  it('does not emit unhandled rejection when intentional abort has no awaiter', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const controller = new AbortController()
      const loader = vi.fn(
        (signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(createAbortError()), { once: true })
          }),
      )

      void cachedRequest('routes-runtime', 'orphan-abort', loader, { signal: controller.signal })
      controller.abort()

      await vi.waitFor(() => {
        expect(loader).toHaveBeenCalled()
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(rejections.filter((reason) => isRequestAborted(reason))).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('still rejects awaiters with non-abort failures', async () => {
    const boom = new Error('loader failed')
    await expect(cachedRequest('routes-runtime', 'fail-key', async () => Promise.reject(boom))).rejects.toBe(boom)
  })

  it('does not swallow non-abort unhandled rejections when there is no awaiter', async () => {
    const boom = new Error('loader failed unhandled')
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      void cachedRequest('routes-runtime', 'fail-orphan', async () => Promise.reject(boom))
      await vi.waitFor(() => {
        expect(rejections).toContain(boom)
      })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
