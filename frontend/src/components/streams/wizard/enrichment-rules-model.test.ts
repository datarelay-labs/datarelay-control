import { describe, expect, it } from 'vitest'
import {
  enrichmentDictFromRules,
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
