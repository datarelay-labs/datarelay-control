import { describe, expect, it } from 'vitest'
import { rowsFromFieldMappings } from './mappingFieldMappings'

describe('rowsFromFieldMappings', () => {
  it('loads only basic mapping rows and ignores persisted transform metadata', () => {
    const rows = rowsFromFieldMappings({
      message: '$.message',
      vendor: { source_json_path: '$.vendor', output_field: 'vendor_name' },
      transform_rules: [
        {
          mode: 'regex_extract',
          output_field: 'source_ip',
          source_path: '$.message',
          pattern: 'src=(\\S+)',
        },
      ],
      mapping_mode: 'basic_jsonpath',
      regex_config: { pattern: 'ignored-meta-object' },
    })

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => [row.outputField, row.sourceJsonPath])).toEqual([
      ['message', '$.message'],
      ['vendor_name', '$.vendor'],
    ])
  })
})
