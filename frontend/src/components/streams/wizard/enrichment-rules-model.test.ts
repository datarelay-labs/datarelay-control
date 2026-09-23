import { describe, expect, it } from 'vitest'
import {
  enrichmentDictFromRules,
  formatStaticPersistedValueForEditor,
  wizardEnrichmentRulesFromPersistedDict,
} from './enrichment-rules-model'

describe('wizardEnrichmentRulesFromPersistedDict scalar fidelity', () => {
  it('preserves number and boolean JSON scalars through hydrate→dict', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      count: 5,
      active: false,
      label: 'ok',
    })
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldName: 'count', staticValue: '5', staticPersistedValue: 5 }),
        expect.objectContaining({
          fieldName: 'active',
          staticValue: 'false',
          staticPersistedValue: false,
        }),
        expect.objectContaining({ fieldName: 'label', staticValue: 'ok' }),
      ]),
    )
    expect(enrichmentDictFromRules(rules)).toEqual({
      count: 5,
      active: false,
      label: 'ok',
    })
  })

  it('drops typed scalar once the operator edits staticValue', () => {
    const [rule] = wizardEnrichmentRulesFromPersistedDict({ count: 5 })
    expect(rule).toBeDefined()
    const edited = { ...rule!, staticValue: '6', staticPersistedValue: undefined }
    expect(enrichmentDictFromRules([edited])).toEqual({ count: '6' })
  })
})

describe('wizardEnrichmentRulesFromPersistedDict nested JSON fidelity', () => {
  it('preserves nested object static values through hydrate→save', () => {
    const nested = { region: 'us-east-1', tags: { env: 'prod' } }
    const rules = wizardEnrichmentRulesFromPersistedDict({ meta: nested })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      fieldName: 'meta',
      type: 'static',
      staticPersistedValue: nested,
    })
    expect(rules[0]?.staticValue).toBe(formatStaticPersistedValueForEditor(nested))
    expect(rules[0]?.staticValue).toContain('"region": "us-east-1"')
    expect(enrichmentDictFromRules(rules)).toEqual({ meta: nested })
  })

  it('preserves array static values through hydrate→save', () => {
    const tags = ['alpha', 'beta', 3, false]
    const rules = wizardEnrichmentRulesFromPersistedDict({ tags })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      fieldName: 'tags',
      staticPersistedValue: tags,
    })
    expect(rules[0]?.staticValue).toContain('alpha')
    expect(enrichmentDictFromRules(rules)).toEqual({ tags })
  })

  it('clears nested raw value only when the operator edits the display string', () => {
    const nested = { a: 1 }
    const [rule] = wizardEnrichmentRulesFromPersistedDict({ payload: nested })
    expect(enrichmentDictFromRules([rule!])).toEqual({ payload: nested })
    const edited = { ...rule!, staticValue: '{"a":2}', staticPersistedValue: undefined }
    expect(enrichmentDictFromRules([edited])).toEqual({ payload: '{"a":2}' })
  })
})
