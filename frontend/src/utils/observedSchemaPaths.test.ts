import { describe, expect, it } from 'vitest'
import {
  appendObservedFieldPath,
  parseObservedSchemaPath,
} from './observedSchemaPaths'
import {
  buildRepresentativeEventFromUnionSchema,
  buildUnionSchema,
} from './unionSchema'

describe('observed schema field identity', () => {
  it('keeps plain legacy ASCII paths unchanged', () => {
    expect(appendObservedFieldPath('$', 'user')).toBe('$.user')
    expect(appendObservedFieldPath('$.user', 'email')).toBe('$.user.email')
  })

  it('distinguishes a dotted literal member from a nested member', () => {
    const schema = buildUnionSchema([
      { 'user.email': 'literal', user: { email: 'nested' } },
      { user: { email: 'second' } },
    ])
    expect(schema.fields.find((field) => field.field_path === "$['user.email']")?.occurrence_count).toBe(1)
    expect(schema.fields.find((field) => field.field_path === '$.user.email')?.occurrence_count).toBe(2)
    const output = buildRepresentativeEventFromUnionSchema(schema)
    expect(output['user.email']).toBe('literal')
    expect(output.user).toEqual({ email: 'nested' })
  })

  it('losslessly encodes and decodes special literal key names', () => {
    const keys = ['a.b', 'a[]', "a'b", 'a"b', 'a\\b', '', '한글', 'x/y', '~', 'a b', 'line\nbreak']
    for (const key of keys) {
      const path = appendObservedFieldPath('$', key)
      const parsed = parseObservedSchemaPath(path)
      expect(parsed).toEqual([{ kind: 'field', key }])
    }
  })

  it('treats array wildcard patterns as schema patterns rather than literal field names', () => {
    const schema = buildUnionSchema([
      { items: [{ 'a.b': 'secret', retained: 1 }, { 'a.b': 'also secret' }] },
    ])
    expect(schema.fields.some((field) => field.field_path === "$.items[]['a.b']")).toBe(true)
    expect(parseObservedSchemaPath("$.items[]['a.b']")).toEqual([
      { kind: 'field', key: 'items' },
      { kind: 'array' },
      { kind: 'field', key: 'a.b' },
    ])
    const sample = buildRepresentativeEventFromUnionSchema(schema)
    expect(sample).toEqual({ items: { 'a.b': 'secret', retained: 1 } })
  })

  it('supports historical positive array indices in read-only representative paths', () => {
    expect(parseObservedSchemaPath("$.items[2]['a.b']")).toEqual([
      { kind: 'field', key: 'items' },
      { kind: 'array' },
      { kind: 'field', key: 'a.b' },
    ])
  })

  it('does not turn a __proto__ member into a changed object prototype', () => {
    const item = JSON.parse('{"__proto__":"literal","nested":{"constructor":"safe"}}') as Record<string, unknown>
    const schema = buildUnionSchema([item])
    const output = buildRepresentativeEventFromUnionSchema(schema)
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(true)
    expect(output['__proto__']).toBe('literal')
    expect((output.nested as Record<string, unknown>).constructor).toBe('safe')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('rejects unexpected path selector syntax rather than guessing', () => {
    for (const invalid of ['no-root', '$.', '$[?(@.x)]', "$['unterminated]", '$[xyz]', '$..x']) {
      expect(parseObservedSchemaPath(invalid)).toBeNull()
    }
  })

  it('maintains the existing rare-field threshold when using bracket selectors', () => {
    const rows = [
      { 'user.email': 'rare' },
      { user: { email: 2 } },
      { user: { email: 3 } },
      { user: { email: 4 } },
      { user: { email: 5 } },
    ]
    const schema = buildUnionSchema(rows)
    const literal = schema.fields.find((field) => field.field_path === "$['user.email']")
    expect(literal?.occurrence_count).toBe(1)
    expect(schema.total_events).toBe(5)
  })
})
