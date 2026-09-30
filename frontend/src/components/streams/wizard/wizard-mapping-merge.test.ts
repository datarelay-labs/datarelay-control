import { describe, expect, it } from 'vitest'
import { applySelectedMetadataSuggestions, previewSelectedMetadataSuggestions } from './wizard-mapping-merge'

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

  it('previews exactly the selected suggestions without implicit auto fallback', () => {
    const current = [{ id: 'manual', outputField: 'message', sourceJsonPath: '$.msg', origin: 'manual' as const }]
    const preview = previewSelectedMetadataSuggestions(
      current,
      [{ outputField: 'srcip', sourceJsonPath: '$.source_ip' }],
      { msg: 'hello', source_ip: '1.2.3.4', user: 'alice' },
      () => 'preview',
    )

    expect(preview.stellarAdded).toBe(1)
    expect(preview.autoAdded).toBe(0)
    expect(preview.unmappedSourceFields).toBe(1)
    expect(preview.rows.map((row) => row.sourceJsonPath)).toEqual(['$.msg', '$.source_ip'])
  })
})
