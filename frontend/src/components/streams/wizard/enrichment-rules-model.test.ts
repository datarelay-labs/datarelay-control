import { describe, expect, it } from 'vitest'
import {
  enrichmentDictFromRules,
  formatStaticPersistedValueForEditor,
  wizardEnrichmentFromPersistedDict,
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

describe('wizardEnrichmentFromPersistedDict type-array fidelity', () => {
  it('hydrates runtime type-array __rules and re-emits the same form', () => {
    const persisted = {
      __rules: {
        calculated: [
          {
            target_field: 'metadata.label',
            expression: 'upper({{code}})',
            label: 'Label',
            enabled: true,
          },
        ],
        lookup: [
          {
            target_field: 'metadata.region_name',
            lookup_table: 'aws_regions',
            lookup_key_field: 'region',
          },
        ],
      },
    }
    const parsed = wizardEnrichmentFromPersistedDict(persisted)
    expect(parsed.emitAdvancedAsTypeArray).toBe(true)
    expect(parsed.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'metadata.label',
          type: 'calculated',
          expression: 'upper({{code}})',
        }),
        expect.objectContaining({
          fieldName: 'metadata.region_name',
          type: 'lookup',
          lookupTable: 'aws_regions',
          lookupKeyField: 'region',
        }),
      ]),
    )
    expect(
      enrichmentDictFromRules(parsed.rules, {
        advancedPassthrough: parsed.advancedPassthrough,
        emitAdvancedAsTypeArray: parsed.emitAdvancedAsTypeArray,
      }),
    ).toEqual({
      __rules: {
        calculated: [
          expect.objectContaining({
            target_field: 'metadata.label',
            expression: 'upper({{code}})',
          }),
        ],
        lookup: [
          expect.objectContaining({
            target_field: 'metadata.region_name',
            lookup_table: 'aws_regions',
            lookup_key_field: 'region',
          }),
        ],
      },
    })
  })

  it('passthrough-preserves unknown type-array keys', () => {
    const persisted = {
      __rules: {
        calculated: [{ target_field: 'metadata.label', expression: '1+1' }],
        custom_future: [{ target_field: 'x', value: 1 }],
      },
    }
    const parsed = wizardEnrichmentFromPersistedDict(persisted)
    expect(parsed.advancedPassthrough).toEqual({
      custom_future: [{ target_field: 'x', value: 1 }],
    })
    const out = enrichmentDictFromRules(parsed.rules, {
      advancedPassthrough: parsed.advancedPassthrough,
      emitAdvancedAsTypeArray: parsed.emitAdvancedAsTypeArray,
    })
    expect(out.__rules).toMatchObject({
      custom_future: [{ target_field: 'x', value: 1 }],
      calculated: [expect.objectContaining({ target_field: 'metadata.label' })],
    })
  })
})

describe('lookup key_field alias + typed conditional + disabled advanced rules', () => {
  it('hydrates lookup key_field alias and re-emits lookup_key_field', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.region_name': {
          type: 'lookup',
          lookup_table: 'aws_regions',
          key_field: 'region',
          enabled: true,
        },
      },
    })
    expect(rules).toEqual([
      expect.objectContaining({
        fieldName: 'metadata.region_name',
        type: 'lookup',
        lookupKeyField: 'region',
      }),
    ])
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.region_name': expect.objectContaining({
          type: 'lookup',
          lookup_table: 'aws_regions',
          lookup_key_field: 'region',
        }),
      },
    })
    expect(
      (enrichmentDictFromRules(rules).__rules as Record<string, Record<string, unknown>>)[
        'metadata.region_name'
      ],
    ).not.toHaveProperty('key_field')
  })

  it('prefers key_field over lookup_key_field when both aliases differ (runtime precedence)', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.region_name': {
          type: 'lookup',
          lookup_table: 'aws_regions',
          key_field: 'region',
          lookup_key_field: 'other_region',
          enabled: true,
        },
      },
    })
    expect(rules[0]).toMatchObject({ lookupKeyField: 'region' })
    const saved = enrichmentDictFromRules(rules)
    const payload = (saved.__rules as Record<string, Record<string, unknown>>)[
      'metadata.region_name'
    ]
    expect(payload).toMatchObject({ lookup_key_field: 'region' })
    expect(payload).not.toHaveProperty('key_field')
    expect(payload).not.toHaveProperty('lookupKeyField')
  })

  it('prefers key_field in type-array lookup dual-alias hydrate→save', () => {
    const hydrated = wizardEnrichmentFromPersistedDict({
      __rules: {
        lookup: [
          {
            target_field: 'metadata.region_name',
            lookup_table: 'aws_regions',
            key_field: 'region',
            lookup_key_field: 'other_region',
          },
        ],
      },
    })
    expect(hydrated.rules[0]).toMatchObject({ lookupKeyField: 'region' })
    expect(
      enrichmentDictFromRules(hydrated.rules, { emitAdvancedAsTypeArray: true }),
    ).toEqual({
      __rules: {
        lookup: [
          expect.objectContaining({
            target_field: 'metadata.region_name',
            lookup_key_field: 'region',
          }),
        ],
      },
    })
  })

  it('preserves typed conditional then/default through hydrate→save', () => {
    const persisted = {
      __rules: {
        'metadata.outcome': {
          type: 'conditional',
          conditions: [
            { when: "status === 'ok'", then: true },
            { when: "status === 'fail'", then: { code: 500 } },
          ],
          // Runtime treats null default as falsy and falls through to "".
          default: 'unmatched',
          enabled: true,
        },
      },
    }
    const rules = wizardEnrichmentRulesFromPersistedDict(persisted)
    expect(rules[0]?.conditions[0]).toMatchObject({
      then: 'true',
      thenPersistedValue: true,
    })
    expect(rules[0]?.conditions[1]).toMatchObject({
      thenPersistedValue: { code: 500 },
    })
    expect(rules[0]?.conditionalDefault).toBe('unmatched')
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.outcome': expect.objectContaining({
          type: 'conditional',
          conditions: [
            { when: "status === 'ok'", then: true },
            { when: "status === 'fail'", then: { code: 500 } },
          ],
          default: 'unmatched',
        }),
      },
    })
  })

  it('canonicalizes sole falsy conditional default to runtime-resolved empty string', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.outcome': {
          type: 'conditional',
          conditions: [{ when: "status === 'ok'", then: 'ok' }],
          default: null,
          enabled: true,
        },
      },
    })
    expect(rules[0]?.conditionalDefault).toBe('')
    expect(rules[0]?.conditionalDefaultPersistedValue).toBeUndefined()
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.outcome': expect.objectContaining({
          type: 'conditional',
          default: '',
        }),
      },
    })
  })

  it.each([
    { defaultValue: 0, conditionalDefault: 'fallback', expected: 'fallback' },
    { defaultValue: false, conditionalDefault: true, expected: true },
    { defaultValue: '', conditionalDefault: 'unknown', expected: 'unknown' },
    // Python treats [] / {} as falsy; JS does not — must match runtime `a or b`.
    { defaultValue: [], conditionalDefault: ['fallback'], expected: ['fallback'] },
    { defaultValue: {}, conditionalDefault: { reason: 'unmatched' }, expected: { reason: 'unmatched' } },
  ])(
    'uses runtime truthy fallback when default=$defaultValue and conditionalDefault is set',
    ({ defaultValue, conditionalDefault, expected }) => {
      const rules = wizardEnrichmentRulesFromPersistedDict({
        __rules: {
          'metadata.outcome': {
            type: 'conditional',
            conditions: [{ when: "status === 'ok'", then: 'ok' }],
            default: defaultValue,
            conditionalDefault,
            enabled: true,
          },
        },
      })
      if (typeof expected === 'string') {
        expect(rules[0]?.conditionalDefault).toBe(expected)
        expect(rules[0]?.conditionalDefaultPersistedValue).toBeUndefined()
      } else {
        expect(rules[0]?.conditionalDefaultPersistedValue).toEqual(expected)
      }
      expect(enrichmentDictFromRules(rules)).toEqual({
        __rules: {
          'metadata.outcome': expect.objectContaining({
            type: 'conditional',
            default: expected,
          }),
        },
      })
      expect(
        (enrichmentDictFromRules(rules).__rules as Record<string, Record<string, unknown>>)[
          'metadata.outcome'
        ],
      ).not.toHaveProperty('conditionalDefault')
    },
  )

  it('preserves non-empty JSON default over conditionalDefault (Python-truthy object/array)', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.outcome': {
          type: 'conditional',
          conditions: [{ when: "status === 'ok'", then: 'ok' }],
          default: { code: 0 },
          conditionalDefault: { reason: 'fallback' },
          enabled: true,
        },
      },
    })
    expect(rules[0]?.conditionalDefaultPersistedValue).toEqual({ code: 0 })
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.outcome': expect.objectContaining({
          default: { code: 0 },
        }),
      },
    })
  })

  it('preserves enabled:false advanced rules; still omits disabled statics', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      vendor: 'acme',
      __rules: {
        'metadata.severity': {
          type: 'calculated',
          expression: '1+1',
          enabled: false,
        },
      },
    })
    const disabledCalc = rules.find((r) => r.fieldName === 'metadata.severity')
    expect(disabledCalc).toMatchObject({ type: 'calculated', enabled: false, expression: '1+1' })

    const disabledStatic = {
      ...rules.find((r) => r.fieldName === 'vendor')!,
      enabled: false,
    }
    expect(
      enrichmentDictFromRules([
        disabledStatic,
        disabledCalc!,
      ]),
    ).toEqual({
      __rules: {
        'metadata.severity': expect.objectContaining({
          type: 'calculated',
          expression: '1+1',
          enabled: false,
        }),
      },
    })
  })
})

describe('lookup table + normalize source alias parity + mixed __rules fidelity', () => {
  it('falls through falsy lookup_table to lookupTable (runtime truthy or)', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.region_name': {
          type: 'lookup',
          lookup_table: '',
          lookupTable: 'aws_regions',
          key_field: 'region',
          enabled: true,
        },
      },
    })
    expect(rules[0]).toMatchObject({ lookupTable: 'aws_regions' })
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.region_name': expect.objectContaining({
          lookup_table: 'aws_regions',
          lookup_key_field: 'region',
        }),
      },
    })
  })

  it('hydrates normalize sourceField alias after falsy source_field (runtime truthy or)', () => {
    const rules = wizardEnrichmentRulesFromPersistedDict({
      __rules: {
        'metadata.timestamp': {
          type: 'normalize',
          source_field: '',
          sourceField: 'event_time',
          format: 'iso8601',
          enabled: true,
        },
      },
    })
    expect(rules[0]).toMatchObject({
      type: 'normalize',
      normalizeSourceField: 'event_time',
    })
    expect(enrichmentDictFromRules(rules)).toEqual({
      __rules: {
        'metadata.timestamp': expect.objectContaining({
          type: 'normalize',
          source_field: 'event_time',
          format: 'iso8601',
        }),
      },
    })
  })

  it('preserves mixed field-keyed + type-array __rules including duplicate type-array targets', () => {
    const persisted = {
      __rules: {
        'metadata.label': {
          type: 'calculated',
          expression: 'upper({{code}})',
          enabled: true,
        },
        calculated: [
          {
            target_field: 'metadata.score',
            expression: '1',
            enabled: true,
          },
          {
            target_field: 'metadata.score',
            expression: '2',
            enabled: true,
          },
        ],
      },
    }
    const parsed = wizardEnrichmentFromPersistedDict(persisted)
    expect(parsed.emitAdvancedAsTypeArray).toBe(false)
    expect(parsed.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'metadata.label',
          type: 'calculated',
          expression: 'upper({{code}})',
          advancedPersistForm: 'field-keyed',
        }),
        expect.objectContaining({
          fieldName: 'metadata.score',
          expression: '1',
          advancedPersistForm: 'type-array',
        }),
        expect.objectContaining({
          fieldName: 'metadata.score',
          expression: '2',
          advancedPersistForm: 'type-array',
        }),
      ]),
    )

    const saved = enrichmentDictFromRules(parsed.rules, {
      advancedPassthrough: parsed.advancedPassthrough,
      emitAdvancedAsTypeArray: parsed.emitAdvancedAsTypeArray,
    })
    expect(saved.__rules).toEqual({
      'metadata.label': expect.objectContaining({
        type: 'calculated',
        expression: 'upper({{code}})',
      }),
      calculated: [
        expect.objectContaining({ target_field: 'metadata.score', expression: '1' }),
        expect.objectContaining({ target_field: 'metadata.score', expression: '2' }),
      ],
    })
  })
})
