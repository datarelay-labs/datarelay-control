import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache, observeCachedRequestRejection } from './requestCache'
import type { MetricsWindow } from './gdcRuntime'
import type { ObservabilitySummaryResponse } from './types/gdcApi'

const RT = `${GDC_API_PREFIX}/runtime`
const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const SUMMARY_CACHE_TTL_MS = 15_000

const SUMMARY_CACHE_NAMESPACE = 'observability-summary'

function normalizeSnapshotId(snapshotId: string | undefined): string {
  const trimmed = snapshotId?.trim()
  return trimmed && trimmed !== '' ? trimmed : 'latest'
}

export function observabilitySummaryRequestKey(window: MetricsWindow = '24h', snapshotId?: string): string {
  return `${window}:${normalizeSnapshotId(snapshotId)}`
}

function logDevTiming(key: string, startedAt: number): void {
  if (!import.meta.env.DEV) return
  const elapsedMs =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() - startedAt
      : Date.now() - startedAt
  console.info('[observability] summary fetch ms', { key, elapsed_ms: Math.round(elapsedMs) })
}

async function fetchObservabilitySummaryUncached(
  window: MetricsWindow = '24h',
  params: { snapshot_id?: string } = {},
  signal?: AbortSignal,
): Promise<ObservabilitySummaryResponse | null> {
  const q = new URLSearchParams({ window })
  if (params.snapshot_id != null && params.snapshot_id.trim() !== '') q.set('snapshot_id', params.snapshot_id.trim())
  return safeRequestJson<ObservabilitySummaryResponse>(
    `${RT}/observability/summary?${q.toString()}`,
    readJsonWithSignal(readJsonOpts, signal),
  )
}

export function clearObservabilitySummaryCache(key?: string): void {
  clearSharedRequestCache(SUMMARY_CACHE_NAMESPACE, key)
}

export function fetchObservabilitySummary(
  window: MetricsWindow = '24h',
  params: { snapshot_id?: string } = {},
  options?: GdcSignalOptions,
): Promise<ObservabilitySummaryResponse | null> {
  const snapshotId = normalizeSnapshotId(params.snapshot_id)
  const key = observabilitySummaryRequestKey(window, snapshotId)
  const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  return observeCachedRequestRejection(
    cachedRequest(
      SUMMARY_CACHE_NAMESPACE,
      key,
      (signal) => fetchObservabilitySummaryUncached(window, snapshotId === 'latest' ? {} : { snapshot_id: snapshotId }, signal),
      { ttlMs: SUMMARY_CACHE_TTL_MS, signal: options?.signal },
    ).finally(() => logDevTiming(key, startedAt)),
  )
}

