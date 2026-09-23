import { describe, expect, it } from 'vitest'
import {
  buildFieldMappingsFromFullEventRegexConfigJson,
  fullEventRegexConfigDocumentFromFieldMappings,
  fullEventRegexConfigJsonFromFieldMappings,
} from './wizard-full-event-regex-config'

describe('full-event Regex persisted-shape decode', () => {
  const editorJson = JSON.stringify(
    {
      preserve_source: true,
      rules: [
        {
          output_field: 'user',
          source_path: '$.username',
          pattern: '^(.+)$',
          group: 1,
          default: 'unknown',
        },
      ],
    },
    null,
    2,
  )

  it('decodes top-level preserve_source_fields + regex_rules into editor JSON', () => {
    const persisted: Record<string, unknown> = {
      mapping_mode: 'full_event_regex',
      preserve_source_fields: true,
      regex_rules: [
        {
          output_field: 'user',
          source_path: '$.username',
          pattern: '^(.+)$',
          capture_group: 1,
          default_value: 'unknown',
        },
      ],
    }

    const doc = fullEventRegexConfigDocumentFromFieldMappings(persisted)
    expect(doc).toEqual({
      preserve_source: true,
      rules: [
        {
          output_field: 'user',
          source_path: '$.username',
          pattern: '^(.+)$',
          group: 1,
          default: 'unknown',
        },
      ],
    })

    const hydrated = fullEventRegexConfigJsonFromFieldMappings(persisted)
    expect(JSON.parse(hydrated)).toEqual(JSON.parse(editorJson))
  })

  it('round-trips hydrate → save without dropping Regex mapping payload', () => {
    const built = buildFieldMappingsFromFullEventRegexConfigJson(editorJson)
    expect(built.ok).toBe(true)
    if (!built.ok) return

    expect(built.fieldMappings).toEqual({
      mapping_mode: 'full_event_regex',
      preserve_source_fields: true,
      regex_rules: [
        {
          output_field: 'user',
          source_path: '$.username',
          pattern: '^(.+)$',
          capture_group: 1,
          default_value: 'unknown',
        },
      ],
    })

    const rehydrated = fullEventRegexConfigJsonFromFieldMappings(built.fieldMappings)
    const rebuilt = buildFieldMappingsFromFullEventRegexConfigJson(rehydrated)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.fieldMappings).toEqual(built.fieldMappings)
  })

  it('returns empty when mapping_mode is not full_event_regex', () => {
    expect(
      fullEventRegexConfigJsonFromFieldMappings({
        mapping_mode: 'basic_jsonpath',
        host: '$.host',
      }),
    ).toBe('')
  })

  it('still accepts legacy nested regex_config', () => {
    const hydrated = fullEventRegexConfigJsonFromFieldMappings({
      mapping_mode: 'full_event_regex',
      regex_config: {
        preserve_source: false,
        rules: [
          {
            output_field: 'id',
            source_path: '$.raw',
            pattern: 'id=(\\d+)',
            group: 1,
          },
        ],
      },
    })
    expect(JSON.parse(hydrated)).toEqual({
      preserve_source: false,
      rules: [
        {
          output_field: 'id',
          source_path: '$.raw',
          pattern: 'id=(\\d+)',
          group: 1,
        },
      ],
    })
  })
})
