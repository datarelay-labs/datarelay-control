import { describe, expect, it } from 'vitest'
import {
  defaultsRouteDeliveryFormState,
  isRouteDeliveryDirty,
  isRouteTransformDirty,
  mergeMessagePrefixDrafts,
  normalizeRouteDeliveryFormState,
  routeDeliveryFormFingerprint,
  routeTransformFormFingerprint,
  type RouteDeliveryFormState,
} from './route-delivery-dirty'

describe('route delivery dirty comparator', () => {
  it('treats initial load matching baseline as clean', () => {
    const baseline = defaultsRouteDeliveryFormState()
    expect(isRouteDeliveryDirty(baseline, { ...baseline })).toBe(false)
  })

  it('marks dirty when a field changes and clean when reverted', () => {
    const baseline = defaultsRouteDeliveryFormState()
    const edited: RouteDeliveryFormState = { ...baseline, routeName: 'Prod route' }
    expect(isRouteDeliveryDirty(baseline, edited)).toBe(true)
    expect(isRouteDeliveryDirty(baseline, { ...edited, routeName: baseline.routeName })).toBe(false)
  })

  it('includes destination and rate-limit fields in dirty detection', () => {
    const baseline = { ...defaultsRouteDeliveryFormState(), destinationId: 10, rateLimitEnabled: true, perSecond: 100 }
    expect(isRouteDeliveryDirty(baseline, { ...baseline, destinationId: 11 })).toBe(true)
    expect(isRouteDeliveryDirty(baseline, { ...baseline, perSecond: 50 })).toBe(true)
    expect(isRouteDeliveryDirty(baseline, { ...baseline, rateLimitEnabled: false })).toBe(true)
  })

  it('normalizes trim / null destination so equivalent meaning is clean', () => {
    const a = normalizeRouteDeliveryFormState({
      ...defaultsRouteDeliveryFormState(),
      routeName: '  Route A  ',
      description: '  ',
      destinationId: Number.NaN as unknown as number,
    })
    const b = normalizeRouteDeliveryFormState({
      ...defaultsRouteDeliveryFormState(),
      routeName: 'Route A',
      description: '',
      destinationId: null,
    })
    expect(routeDeliveryFormFingerprint(a)).toBe(routeDeliveryFormFingerprint(b))
  })

  it('does not treat null baseline as dirty (still loading)', () => {
    expect(isRouteDeliveryDirty(null, defaultsRouteDeliveryFormState())).toBe(false)
  })
})

describe('route transform dirty comparator', () => {
  it('detects nested mapping / enrichment edits and reverts to clean', () => {
    const current = {
      inheritStream: false,
      rows: [{ outputField: 'a', sourceJsonPath: '$.a' }],
      transformRules: [],
      enrichment: { env: 'prod' },
      eventArrayPath: '',
      eventRootPath: '',
    }
    const baseline = routeTransformFormFingerprint(current)
    expect(isRouteTransformDirty(baseline, current)).toBe(false)
    expect(
      isRouteTransformDirty(baseline, {
        ...current,
        rows: [{ outputField: 'b', sourceJsonPath: '$.b' }],
      }),
    ).toBe(true)
    expect(
      isRouteTransformDirty(baseline, {
        ...current,
        enrichment: { env: 'dev' },
      }),
    ).toBe(true)
    expect(isRouteTransformDirty(baseline, { ...current })).toBe(false)
  })
})

describe('mergeMessagePrefixDrafts', () => {
  const defaultEnabled = () => false
  const defaultTemplate = '{{stream}}'

  it('preserves dirty local drafts across mappingCfg reload', () => {
    const prevBaseline = {
      1: { enabled: false, template: '{{stream}}' },
    }
    const prevDrafts = {
      1: { enabled: true, template: 'CUSTOM' },
    }
    const { drafts, baseline } = mergeMessagePrefixDrafts({
      routes: [
        {
          route_id: 1,
          destination_type: 'SYSLOG_TCP',
          formatter_config: { message_prefix_enabled: false, message_prefix_template: '{{stream}}' },
        },
      ],
      prevDrafts,
      prevBaseline,
      defaultEnabled,
      defaultTemplate,
    })
    expect(drafts[1]).toEqual({ enabled: true, template: 'CUSTOM' })
    expect(baseline[1]).toEqual({ enabled: false, template: '{{stream}}' })
  })

  it('updates clean drafts from server', () => {
    const prevBaseline = {
      1: { enabled: false, template: '{{stream}}' },
    }
    const prevDrafts = {
      1: { enabled: false, template: '{{stream}}' },
    }
    const { drafts } = mergeMessagePrefixDrafts({
      routes: [
        {
          route_id: 1,
          formatter_config: { message_prefix_enabled: true, message_prefix_template: 'NEW' },
        },
      ],
      prevDrafts,
      prevBaseline,
      defaultEnabled,
      defaultTemplate,
    })
    expect(drafts[1]).toEqual({ enabled: true, template: 'NEW' })
  })
})
