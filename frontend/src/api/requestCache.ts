import { createAbortError, isRequestAborted, throwIfAborted } from '../lib/request-abort'

type RequestCacheEntry<T> = {
  promise?: Promise<T>
  value?: T
  updatedAt?: number
  abortController?: AbortController
  consumerSignals?: Set<AbortSignal>
}

const requestCaches = new Map<string, Map<string, RequestCacheEntry<unknown>>>()

function nowMs(): number {
  return Date.now()
}

function namespaceCache(namespace: string): Map<string, RequestCacheEntry<unknown>> {
  let cache = requestCaches.get(namespace)
  if (cache == null) {
    cache = new Map()
    requestCaches.set(namespace, cache)
  }
  return cache
}

export function clearSharedRequestCache(namespace?: string, key?: string): void {
  if (namespace == null) {
    requestCaches.clear()
    return
  }
  const cache = requestCaches.get(namespace)
  if (cache == null) return
  if (key == null) {
    cache.clear()
    return
  }
  cache.delete(key)
}

/** Clears only keys that start with `keyPrefix` within a namespace (scoped invalidation). */
export function clearSharedRequestCacheByKeyPrefix(namespace: string, keyPrefix: string): void {
  const cache = requestCaches.get(namespace)
  if (cache == null) return
  for (const key of [...cache.keys()]) {
    if (key.startsWith(keyPrefix)) cache.delete(key)
  }
}

function unlinkConsumer(
  cache: Map<string, RequestCacheEntry<unknown>>,
  key: string,
  entry: RequestCacheEntry<unknown>,
  signal: AbortSignal,
): void {
  entry.consumerSignals?.delete(signal)
  if (entry.consumerSignals == null || entry.consumerSignals.size === 0) {
    entry.abortController?.abort()
    cache.delete(key)
  }
}

function linkConsumer<T>(
  cache: Map<string, RequestCacheEntry<T>>,
  key: string,
  entry: RequestCacheEntry<T>,
  signal?: AbortSignal,
): void {
  if (!signal) return
  if (signal.aborted) {
    entry.abortController?.abort()
    cache.delete(key)
    return
  }
  if (entry.consumerSignals == null) entry.consumerSignals = new Set()
  entry.consumerSignals.add(signal)
  signal.addEventListener(
    'abort',
    () => unlinkConsumer(cache as Map<string, RequestCacheEntry<unknown>>, key, entry as RequestCacheEntry<unknown>, signal),
    { once: true },
  )
}

export type CachedRequestOptions = {
  ttlMs?: number
  signal?: AbortSignal
}

/**
 * Marks AbortError as handled without swallowing non-abort failures for unhandled tracking.
 * Use on any promise chain that re-wraps `cachedRequest` (e.g. `.then` / `.finally`) so
 * intentional abort/unmount does not surface as Vitest/Node unhandledRejection.
 */
export function observeCachedRequestRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch((err) => {
    if (isRequestAborted(err)) return
    return Promise.reject(err)
  })
  return promise
}

function rejectAborted(): Promise<never> {
  return observeCachedRequestRejection(Promise.reject(createAbortError()))
}

export function cachedRequest<T>(
  namespace: string,
  key: string,
  loader: (signal?: AbortSignal) => Promise<T>,
  options: CachedRequestOptions = {},
): Promise<T> {
  const { signal, ttlMs = 15_000 } = options
  if (signal?.aborted) return rejectAborted()

  const cache = namespaceCache(namespace)
  const cached = cache.get(key) as RequestCacheEntry<T> | undefined

  if (cached?.promise != null) {
    linkConsumer(cache, key, cached, signal)
    if (signal?.aborted) return rejectAborted()
    if (cache.has(key) && cached.promise != null) return cached.promise
  }

  const cachedAge = cached?.updatedAt == null ? Number.POSITIVE_INFINITY : nowMs() - cached.updatedAt
  if (cached != null && cached.promise == null && cachedAge < ttlMs && cached.value !== undefined) {
    return Promise.resolve(cached.value as T)
  }

  const entry: RequestCacheEntry<T> = {}
  const abortController = new AbortController()
  entry.abortController = abortController
  linkConsumer(cache, key, entry, signal)
  if (signal?.aborted) return rejectAborted()

  const promise = observeCachedRequestRejection(
    loader(abortController.signal)
      .then((value) => {
        throwIfAborted(abortController.signal)
        cache.set(key, { value, updatedAt: nowMs() })
        return value
      })
      .catch((err) => {
        cache.delete(key)
        if (isRequestAborted(err)) throw createAbortError()
        throw err
      })
      .finally(() => {
        const current = cache.get(key) as RequestCacheEntry<T> | undefined
        if (current?.promise === promise) {
          if (current.value !== undefined) {
            cache.set(key, { value: current.value, updatedAt: current.updatedAt ?? nowMs() })
          }
        }
      }),
  )

  entry.promise = promise
  cache.set(key, entry)
  return promise
}
