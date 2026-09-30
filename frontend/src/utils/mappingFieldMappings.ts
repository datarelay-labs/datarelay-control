import type { MappingRowModel } from '../components/streams/stream-mapping-model'

export type FieldMappingValue = string

const FIELD_MAPPING_META_KEYS = new Set([
  'transform_rules',
  'advanced_fields',
  'mapping_mode',
  'jsonata_expression',
  'expression',
  'regex_rules',
  'preserve_source_fields',
  'unmapped_fields_policy',
])

export function fieldMappingsFromRows(rows: MappingRowModel[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.outputField.trim()
    const p = row.sourceJsonPath.trim()
    if (!k || !p) continue
    out[k] = p
  }
  return out
}

export function rowsFromFieldMappings(fieldMappings: Record<string, unknown>): MappingRowModel[] {
  let i = 0
  const rows: MappingRowModel[] = []
  for (const [outputField, raw] of Object.entries(fieldMappings)) {
    if (FIELD_MAPPING_META_KEYS.has(outputField) || outputField.startsWith('_')) continue
    if (typeof raw === 'string') {
      rows.push({
        id: `m-${i++}-${outputField}`,
        outputField,
        sourceJsonPath: raw,
        type: 'string',
        origin: 'auto',
      })
      continue
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      const path = String(obj.source_json_path ?? obj.json_path ?? '').trim()
      if (!path) continue
      rows.push({
        id: `m-${i++}-${outputField}`,
        outputField: String(obj.output_field ?? outputField),
        sourceJsonPath: path,
        type: 'string',
        origin: 'auto',
      })
    }
  }
  return rows
}
