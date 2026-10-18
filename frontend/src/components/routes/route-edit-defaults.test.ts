import { describe, expect, it } from 'vitest'
import { routeFailurePolicyToApi, type RouteFailurePolicy, type RouteApiFailurePolicy } from './route-edit-defaults'

describe('Route delivery failure-policy backend contract', () => {
  it.each<[RouteFailurePolicy, RouteApiFailurePolicy]>([
    ['Retry', 'RETRY_AND_BACKOFF'],
    ['Log and Continue', 'LOG_AND_CONTINUE'],
    ['Pause Stream', 'PAUSE_STREAM_ON_FAILURE'],
    ['Disable Route', 'DISABLE_ROUTE_ON_FAILURE'],
  ])('maps operator choice %s to API enum %s', (choice, expected) => {
    expect(routeFailurePolicyToApi(choice)).toBe(expected)
  })
})
