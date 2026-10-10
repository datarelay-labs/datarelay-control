export type RouteFailurePolicy = 'Retry' | 'Log and Continue' | 'Pause Stream' | 'Disable Route'
export type RouteDeliveryMode = 'Reliable' | 'Best Effort'
export type RouteRetryBackoff = 'Exponential' | 'Linear'

export type RouteApiFailurePolicy =
  | 'RETRY_AND_BACKOFF'
  | 'LOG_AND_CONTINUE'
  | 'PAUSE_STREAM_ON_FAILURE'
  | 'DISABLE_ROUTE_ON_FAILURE'

/** Serialize the user-facing route choice to the strict backend failure_policy enum. */
export function routeFailurePolicyToApi(policy: RouteFailurePolicy): RouteApiFailurePolicy {
  switch (policy) {
    case 'Retry': return 'RETRY_AND_BACKOFF'
    case 'Log and Continue': return 'LOG_AND_CONTINUE'
    case 'Pause Stream': return 'PAUSE_STREAM_ON_FAILURE'
    case 'Disable Route': return 'DISABLE_ROUTE_ON_FAILURE'
  }
}

export const ROUTE_EDIT_DEFAULTS = {
  routeName: 'New Route',
  description: '',
  status: 'ENABLED' as const,
  deliveryMode: 'Reliable' as RouteDeliveryMode,
  failurePolicy: 'Retry' as RouteFailurePolicy,
  maxRetry: 5,
  retryBackoff: 'Exponential' as RouteRetryBackoff,
  initialBackoffSec: 1,
  maxBackoffSec: 60,
  maxDeliveryTimeSec: 0,
  batchSize: 100,
  rateLimitEnabled: true,
  perSecond: 100,
  burstSize: 200,
  enrichmentProfile: '',
  filterJsonPath: '',
}
