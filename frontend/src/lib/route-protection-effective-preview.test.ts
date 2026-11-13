import { describe, expect, it } from 'vitest'
import {
  computeAllRouteProtectionEffectivePreviews,
  computeRouteProtectionEffectivePreview,
} from './route-protection-effective-preview'

describe('route-protection-effective-preview', () => {
  const routes = [
    { routeDraftKey: 'splunk', label: 'Splunk' },
    { routeDraftKey: 'elastic', label: 'Elastic' },
  ]

  it('applies default action when no override exists', () => {
    const result = computeRouteProtectionEffectivePreview({
      fieldPath: '$.email',
      defaultAction: 'mask_partial',
      routeOverrides: [],
      routes,
    })

    expect(result.perRoute).toHaveLength(2)
    expect(result.perRoute[0]).toMatchObject({
      routeLabel: 'Splunk',
      protectionAction: 'mask_partial',
      source: 'default',
    })
    expect(result.perRoute[1]).toMatchObject({
      routeLabel: 'Elastic',
      protectionAction: 'mask_partial',
      source: 'default',
    })
  })

  it('applies override for one route and default for others', () => {
    const result = computeRouteProtectionEffectivePreview({
      fieldPath: '$.email',
      defaultAction: 'mask_partial',
      routeOverrides: [
        {
          key: 'o1',
          fieldPath: '$.email',
          routeDraftKey: 'splunk',
          protectionAction: 'tokenize',
          deliveryBehavior: 'continue',
          enabled: true,
        },
      ],
      routes,
    })

    expect(result.perRoute[0]).toMatchObject({
      routeLabel: 'Splunk',
      protectionAction: 'tokenize',
      source: 'override',
    })
    expect(result.perRoute[1]).toMatchObject({
      routeLabel: 'Elastic',
      protectionAction: 'mask_partial',
      source: 'default',
    })
  })

  it('ignores disabled overrides', () => {
    const result = computeRouteProtectionEffectivePreview({
      fieldPath: '$.email',
      defaultAction: 'mask_partial',
      routeOverrides: [
        {
          key: 'o1',
          fieldPath: '$.email',
          routeDraftKey: 'splunk',
          protectionAction: 'tokenize',
          deliveryBehavior: 'continue',
          enabled: false,
        },
      ],
      routes,
    })

    expect(result.perRoute[0].source).toBe('default')
    expect(result.perRoute[0].protectionAction).toBe('mask_partial')
  })

  // C4: the old preview ignored each Route's own configuration and returned the default for all.
  it('uses each Route own effective action, with field overrides still winning', () => {
    const result = computeRouteProtectionEffectivePreview({
      fieldPath: '$.email',
      defaultAction: 'mask_partial',
      routeOverrides: [
        {
          key: 'o1',
          fieldPath: '$.email',
          routeDraftKey: 'splunk',
          protectionAction: 'tokenize',
          deliveryBehavior: 'continue',
          enabled: true,
        },
      ],
      routes: [
        { routeDraftKey: 'splunk', label: 'Splunk', effectiveAction: 'hash' },
        { routeDraftKey: 'elastic', label: 'Elastic', effectiveAction: 'mask_full' },
        { routeDraftKey: 'lake', label: 'Lake', effectiveAction: null },
        { routeDraftKey: 'syslog', label: 'Syslog' },
      ],
    })

    expect(result.perRoute.map((r) => [r.routeDraftKey, r.protectionAction, r.source])).toEqual([
      ['splunk', 'tokenize', 'override'],
      ['elastic', 'mask_full', 'route'],
      ['lake', null, 'route'],
      ['syslog', 'mask_partial', 'default'],
    ])
  })

  it('computes previews for multiple fields', () => {
    const results = computeAllRouteProtectionEffectivePreviews({
      fields: [
        { fieldPath: '$.email', defaultAction: 'mask_partial' },
        { fieldPath: '$.password', defaultAction: 'mask_full' },
      ],
      routeOverrides: [
        {
          key: 'o1',
          fieldPath: '$.password',
          routeDraftKey: 'elastic',
          protectionAction: 'hash',
          deliveryBehavior: 'continue',
          enabled: true,
        },
      ],
      routes,
    })

    expect(results).toHaveLength(2)
    expect(results[1].perRoute.find((r) => r.routeDraftKey === 'elastic')?.protectionAction).toBe('hash')
    expect(results[1].perRoute.find((r) => r.routeDraftKey === 'splunk')?.protectionAction).toBe('mask_full')
  })
})
