import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateWizardStateFromStream, persistedIntentDeliveryBehavior } from './wizard-stream-hydrate'
import type { StreamGovernanceResponse } from '../../../api/gdcStreamGovernance'

// F-186: a persisted Block/Quarantine must read back as Block/Quarantine after reload, never as
// Continue, because the next Save would silently widen delivery.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(governance: Partial<StreamGovernanceResponse>, protectionRules: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
    const p = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (/\/streams\/11$/.test(p)) {
      return json({ id: 11, name: 's', connector_id: null, polling_interval: 60, config_json: {}, rate_limit_json: {}, updated_at: 'u' })
    }
    if (/\/streams\/11\/mapping-ui\/config$/.test(p)) {
      return json({
        stream_id: 11, stream_name: 's', stream_enabled: false, stream_status: 'STOPPED', source_id: 1,
        source_type: 'HTTP_API_POLLING', source_config: {},
        mapping: { exists: false, field_mappings: {} },
        enrichment: { exists: false, enabled: false, enrichment: {}, override_policy: null },
        routes: [{ route_id: 20, destination_id: 5, destination_type: 'WEBHOOK_POST', enabled: true, failure_policy: 'LOG_AND_CONTINUE' }],
        message: 'ok',
      })
    }
    if (/\/routes\/?$/.test(p)) {
      return json([{ id: 20, stream_id: 11, destination_id: 5, enabled: true, failure_policy: 'LOG_AND_CONTINUE', rate_limit_json: {}, updated_at: 'x' }])
    }
    if (/\/destinations\/?$/.test(p)) return json([{ id: 5, destination_type: 'WEBHOOK_POST', name: 'd' }])
    if (/streams\/11\/governance$/.test(p)) {
      return json({ stream_id: 11, enabled: true, rules: [], route_overrides: [], updated_at: 'u', ...governance })
    }
    if (/streams\/11\/protection-rules/.test(p)) {
      return json({ stream_id: 11, protection_enabled: true, rules: protectionRules, rule_count: protectionRules.length })
    }
    if (/routes\/20\/mapping-ui/.test(p)) return json({ route_id: 20, inherit_stream_mapping: true, mapping: null })
    if (/routes\/20\/enrichment-ui/.test(p)) return json({ route_id: 20, inherit_stream_enrichment: true, enrichment: null })
    if (/routes\/20\/(protection|classification)-rules/.test(p)) return json({ route_id: 20, rules: [] })
    return json({ detail: 'not stubbed' }, 404)
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('persisted delivery behavior read-back (F-186)', () => {
  it('shows a persisted Route policy override of Block as Block with the override on', async () => {
    stubApi({
      route_overrides: [{
        override_key: 'o1', field_path: null, route_id: 20, protection_action: null,
        delivery_behavior: 'block', classification_level: null, enabled: true,
      }],
    })
    const state = await hydrateWizardStateFromStream(11)
    const draft = state?.destinations.routeDrafts[0]
    expect(draft?.inherit.policy).toBe(false)
    expect(draft?.overrides?.policy?.deliveryBehavior).toBe('block')
    expect(draft?.governanceLoad?.policy).toBe('hydrated')
  })

  it('shows a persisted stream-level Quarantine/Block rule as that behavior, not Continue', async () => {
    stubApi(
      {
        rules: [
          { field_path: '$.password', default_protection_action: 'mask_full', default_delivery_behavior: 'block', enabled: true },
          { field_path: '$.email', default_protection_action: 'hash', default_delivery_behavior: 'quarantine', enabled: true },
          { field_path: '$.name', default_protection_action: 'audit', default_delivery_behavior: 'continue', enabled: true },
        ],
      },
      [
        { id: 1, stream_id: 11, field_path: '$.password', sensitivity_class: 'secret', protection_mode: 'full_mask', enabled: true, source_finding_id: null, created_by: 'a', created_at: 't', updated_at: 't' },
        { id: 2, stream_id: 11, field_path: '$.email', sensitivity_class: 'pii', protection_mode: 'hash', enabled: true, source_finding_id: null, created_by: 'a', created_at: 't', updated_at: 't' },
        { id: 3, stream_id: 11, field_path: '$.name', sensitivity_class: 'pii', protection_mode: 'partial_mask', enabled: true, source_finding_id: null, created_by: 'a', created_at: 't', updated_at: 't' },
      ],
    )
    const state = await hydrateWizardStateFromStream(11)
    const byField = Object.fromEntries((state?.dataProtection.intents ?? []).map((i) => [i.detectedField, i.deliveryBehavior]))
    expect(byField).toEqual({ '$.password': 'block', '$.email': 'quarantine', '$.name': 'continue' })
  })

  it('falls back to Continue only when no persisted behavior exists or it is unknown', () => {
    const gov = (rules: StreamGovernanceResponse['rules']): StreamGovernanceResponse =>
      ({ stream_id: 1, enabled: true, rules, route_overrides: [] })
    expect(persistedIntentDeliveryBehavior(null, '$.a')).toBe('continue')
    expect(persistedIntentDeliveryBehavior(gov([]), '$.a')).toBe('continue')
    expect(persistedIntentDeliveryBehavior(
      gov([{ field_path: '$.a', default_protection_action: 'audit', default_delivery_behavior: 'weird', enabled: true }]), '$.a',
    )).toBe('continue')
    expect(persistedIntentDeliveryBehavior(
      gov([{ field_path: '$.a', default_protection_action: 'audit', default_delivery_behavior: 'BLOCK', enabled: false }]), '$.a',
    )).toBe('continue')
    expect(persistedIntentDeliveryBehavior(
      gov([{ field_path: '$.a', default_protection_action: 'audit', default_delivery_behavior: 'Block', enabled: true }]), '$.a',
    )).toBe('block')
  })
})
