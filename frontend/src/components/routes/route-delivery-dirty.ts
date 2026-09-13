/**
 * Authoritative route-delivery dirty comparison.
 * Dirty = editable form state differs semantically from last persisted baseline.
 */

import {
  ROUTE_EDIT_DEFAULTS,
  type RouteDeliveryMode,
  type RouteFailurePolicy,
  type RouteRetryBackoff,
} from './route-edit-defaults'

export type RouteDeliveryFormState = {
  routeName: string
  description: string
  enabled: boolean
  destinationId: number | null
  deliveryMode: RouteDeliveryMode
  failurePolicy: RouteFailurePolicy
  maxRetry: number
  retryBackoff: RouteRetryBackoff
  initialBackoffSec: number
  maxBackoffSec: number
  maxDeliveryTimeSec: number
  batchSize: number
  rateLimitEnabled: boolean
  perSecond: number
  burstSize: number
}

export function defaultsRouteDeliveryFormState(): RouteDeliveryFormState {
  const d = ROUTE_EDIT_DEFAULTS
  return {
    routeName: d.routeName,
    description: d.description,
    enabled: d.status === 'ENABLED',
    destinationId: null,
    deliveryMode: d.deliveryMode,
    failurePolicy: d.failurePolicy,
    maxRetry: d.maxRetry,
    retryBackoff: d.retryBackoff,
    initialBackoffSec: d.initialBackoffSec,
    maxBackoffSec: d.maxBackoffSec,
    maxDeliveryTimeSec: d.maxDeliveryTimeSec,
    batchSize: d.batchSize,
    rateLimitEnabled: d.rateLimitEnabled,
    perSecond: d.perSecond,
    burstSize: d.burstSize,
  }
}

/** Canonicalize for semantic equality (null vs undefined, trim strings, stable keys). */
export function normalizeRouteDeliveryFormState(state: RouteDeliveryFormState): RouteDeliveryFormState {
  return {
    routeName: state.routeName.trim(),
    description: state.description.trim(),
    enabled: Boolean(state.enabled),
    destinationId: state.destinationId == null || !Number.isFinite(state.destinationId) ? null : Number(state.destinationId),
    deliveryMode: state.deliveryMode === 'Best Effort' ? 'Best Effort' : 'Reliable',
    failurePolicy: state.failurePolicy,
    maxRetry: Number(state.maxRetry) || 0,
    retryBackoff: state.retryBackoff === 'Linear' ? 'Linear' : 'Exponential',
    initialBackoffSec: Number(state.initialBackoffSec) || 0,
    maxBackoffSec: Number(state.maxBackoffSec) || 0,
    maxDeliveryTimeSec: Number(state.maxDeliveryTimeSec) || 0,
    batchSize: Number(state.batchSize) || 0,
    rateLimitEnabled: Boolean(state.rateLimitEnabled),
    perSecond: Number(state.perSecond) || 0,
    burstSize: Number(state.burstSize) || 0,
  }
}

export function routeDeliveryFormFingerprint(state: RouteDeliveryFormState): string {
  return JSON.stringify(normalizeRouteDeliveryFormState(state))
}

export function isRouteDeliveryDirty(baseline: RouteDeliveryFormState | null, current: RouteDeliveryFormState): boolean {
  if (baseline == null) return false
  return routeDeliveryFormFingerprint(baseline) !== routeDeliveryFormFingerprint(current)
}

export type RouteTransformFormState = {
  inheritStream: boolean
  rows: unknown
  transformRules: unknown
  enrichment: unknown
  eventArrayPath: string
  eventRootPath: string
}

export function routeTransformFormFingerprint(state: RouteTransformFormState): string {
  return JSON.stringify({
    inheritStream: Boolean(state.inheritStream),
    rows: state.rows,
    transformRules: state.transformRules,
    enrichment: state.enrichment ?? {},
    eventArrayPath: String(state.eventArrayPath ?? '').trim(),
    eventRootPath: String(state.eventRootPath ?? '').trim(),
  })
}

export function isRouteTransformDirty(baseline: string | null, current: RouteTransformFormState): boolean {
  if (baseline == null) return false
  return baseline !== routeTransformFormFingerprint(current)
}

export type MessagePrefixDraft = { enabled: boolean; template: string }

/**
 * Merge server prefix config into local drafts without overwriting dirty local edits.
 * A draft is dirty when it differs from the previous server baseline for that route.
 */
export function mergeMessagePrefixDrafts(args: {
  routes: Array<{
    route_id: number
    destination_type?: string | null
    formatter_config?: Record<string, unknown> | null
  }>
  prevDrafts: Record<number, MessagePrefixDraft>
  prevBaseline: Record<number, MessagePrefixDraft>
  defaultEnabled: (destinationType: string) => boolean
  defaultTemplate: string
}): { drafts: Record<number, MessagePrefixDraft>; baseline: Record<number, MessagePrefixDraft> } {
  const { routes, prevDrafts, prevBaseline, defaultEnabled, defaultTemplate } = args
  const drafts: Record<number, MessagePrefixDraft> = {}
  const baseline: Record<number, MessagePrefixDraft> = {}

  for (const r of routes) {
    const fc = r.formatter_config ?? {}
    const kind = r.destination_type ?? ''
    const server: MessagePrefixDraft = {
      enabled: typeof fc.message_prefix_enabled === 'boolean' ? fc.message_prefix_enabled : defaultEnabled(kind),
      template:
        typeof fc.message_prefix_template === 'string' && fc.message_prefix_template.trim()
          ? String(fc.message_prefix_template)
          : defaultTemplate,
    }
    baseline[r.route_id] = server

    const prev = prevDrafts[r.route_id]
    const prevBase = prevBaseline[r.route_id]
    const wasDirty =
      prev != null &&
      prevBase != null &&
      (prev.enabled !== prevBase.enabled || prev.template !== prevBase.template)

    drafts[r.route_id] = wasDirty && prev != null ? prev : server
  }

  return { drafts, baseline }
}
