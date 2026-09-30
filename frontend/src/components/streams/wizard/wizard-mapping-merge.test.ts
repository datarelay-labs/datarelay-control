import { describe, expect, it } from 'vitest'
import { applySelectedMetadataSuggestions } from './wizard-mapping-merge'

describe('applySelectedMetadataSuggestions', () => {
  it('applies only explicitly selected suggestions and preserves manual rows', () => {
    const current = [{ id: 'manual', outputField: 'message', sourceJsonPath: '$.msg', origin: 'manual' as const }]
    const rows = applySelectedMetadataSuggestions(
      current,
      [{ outputField: 'srcip', sourceJsonPath: '$.source_ip' }],
      () => 'selected',
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(current[0])
    expect(rows[1]).toMatchObject({ id: 'selected', outputField: 'srcip', sourceJsonPath: '$.source_ip', origin: 'stellar' })
  })

  it('does not overwrite an existing output or source mapping', () => {
    const current = [{ id: 'manual', outputField: 'srcip', sourceJsonPath: '$.custom_ip', origin: 'manual' as const }]
    const rows = applySelectedMetadataSuggestions(
      current,
      [{ outputField: 'srcip', sourceJsonPath: '$.source_ip' }],
      () => 'selected',
    )
    expect(rows).toEqual(current)
  })
})
