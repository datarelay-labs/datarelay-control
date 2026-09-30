import { describe, expect, it } from 'vitest'
import type {
  FinalEventDraftPreviewResponse,
  MappingDraftPreviewResponse,
  MappingValidationWarning,
} from '../../api/gdcRuntimePreview'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { buildEventChangeRows, buildTransformPreviewSummary } from './transform-preview-summary'

function row(id: string, sourceJsonPath: string, outputField: string): MappingRowModel {
  return { id, sourceJsonPath, outputField, type: 'string', origin: 'manual' }
}

function mapped(
  mappedEvents: Array<Record<string, unknown>>,
  missingFields: MappingDraftPreviewResponse['missing_fields'] = [],
  transformResults: MappingDraftPreviewResponse['transform_results'] = [],
): MappingDraftPreviewResponse {
  return {
    input_event_count: mappedEvents.length,
    preview_event_count: mappedEvents.length,
    mapped_events: mappedEvents,
    missing_fields: missingFields,
    transform_results: transformResults,
    message: 'ok',
  }
}

function final(events: Array<Record<string, unknown>>): FinalEventDraftPreviewResponse {
  return {
    input_event_count: events.length,
    preview_event_count: events.length,
    mapped_events: events,
    final_events: events,
    missing_fields: [],
    matched_policies: [],
    selected_destinations: [],
    failover_plan: [],
    would_quarantine: false,
    message: 'ok',
  }
}

describe('buildTransformPreviewSummary', () => {
  it('aggregates matched values, null outputs and source-to-final type changes across samples', () => {
    const rows = [
      row('id', '$.a', 'id'),
      row('value', '$.b', 'value'),
      row('nullable', '$.c', 'nullable'),
    ]
    const rawEvents = [
      { a: '1', b: 1, c: null },
      { a: '2', b: 2, c: 'present' },
    ]
    const mappedEvents = [
      { id: '1', value: 1, nullable: null },
      { id: '2', value: 2, nullable: 'present' },
    ]
    const finalEvents = [
      { id: 1, value: 1, nullable: null },
      { id: '2', value: 2, nullable: 'present' },
    ]

    const summary = buildTransformPreviewSummary({
      rawEvents,
      rows,
      mapped: mapped(mappedEvents),
      final: final(finalEvents),
      warnings: [],
    })

    expect(summary.previewEventCount).toBe(2)
    expect(summary.totalApplications).toBe(6)
    expect(summary.matchedApplications).toBe(6)
    expect(summary.missingApplications).toBe(0)
    expect(summary.nullOutputCount).toBe(1)
    expect(summary.typeChangeCount).toBe(1)
    expect(summary.duplicateTargetCount).toBe(0)
    expect(summary.defaultRecoveryCount).toBe(0)
    expect(summary.advancedTransformErrorCount).toBe(0)
    expect(summary.fieldSummaries.find((field) => field.outputField === 'id')?.typeChangeCount).toBe(1)
  })

  it('counts runtime-backed advanced-transform default recovery evidence', () => {
    const summary = buildTransformPreviewSummary({
      rawEvents: [{ message: 'no match' }, { message: 'src=10.0.0.1' }],
      rows: [],
      mapped: mapped(
        [{ source_ip: 'unknown' }, { source_ip: '10.0.0.1' }],
        [],
        [
          {
            event_index: 0,
            success: true,
            value: 'unknown',
            error_code: null,
            error_message: null,
            rule_id: 'extract-src',
            output_field: 'source_ip',
            mode: 'regex_extract',
            recovered_via_default: true,
          },
          {
            event_index: 1,
            success: true,
            value: '10.0.0.1',
            error_code: null,
            error_message: null,
            rule_id: 'extract-src',
            output_field: 'source_ip',
            mode: 'regex_extract',
            recovered_via_default: false,
          },
        ],
      ),
      final: null,
      warnings: [],
    })

    expect(summary.defaultRecoveryCount).toBe(1)
    expect(summary.advancedTransformErrorCount).toBe(0)
  })

  it('reports missing sample applications, duplicate targets and validation severity without inventing defaults', () => {
    const rows = [
      row('missing', '$.missing', 'missing_out'),
      row('same-a', '$.a', 'same'),
      row('same-b', '$.b', 'same'),
    ]
    const rawEvents = [
      { a: 'x', b: 'y' },
      { a: 'm', b: 'n' },
    ]
    const missingFields = [
      { output_field: 'missing_out', json_path: '$.missing', event_index: 0 },
      { output_field: 'missing_out', json_path: '$.missing', event_index: 1 },
    ]
    const warnings: MappingValidationWarning[] = [
      { code: 'DUPLICATE_OUTPUT_FIELD', severity: 'warning', message: 'duplicate' },
      { code: 'BAD_PATH', severity: 'error', message: 'bad path' },
    ]

    const summary = buildTransformPreviewSummary({
      rawEvents,
      rows,
      mapped: mapped(
        [
          { missing_out: null, same: 'y' },
          { missing_out: null, same: 'n' },
        ],
        missingFields,
      ),
      final: final([
        { missing_out: null, same: 'y' },
        { missing_out: null, same: 'n' },
      ]),
      warnings,
    })

    expect(summary.totalApplications).toBe(6)
    expect(summary.matchedApplications).toBe(4)
    expect(summary.missingApplications).toBe(2)
    expect(summary.missingEventCount).toBe(2)
    expect(summary.duplicateTargetCount).toBe(1)
    expect(summary.warningCount).toBe(1)
    expect(summary.errorCount).toBe(1)
    expect(summary.fieldSummaries.find((field) => field.outputField === 'missing_out')).toMatchObject({
      matchedCount: 0,
      missingCount: 2,
      duplicateTarget: false,
    })
    expect(summary.fieldSummaries.filter((field) => field.outputField === 'same')).toHaveLength(2)
    expect(summary.fieldSummaries.filter((field) => field.duplicateTarget)).toHaveLength(2)
  })
})


describe('buildEventChangeRows', () => {
  it('reports nested object leaf changes while keeping arrays as bounded values', () => {
    const rows = buildEventChangeRows(
      {
        user: { name: 'Rick', profile: { active: true, level: 1 } },
        tags: ['a', 'b'],
        removed: 'old',
      },
      {
        user: { name: 'Rick', profile: { active: false, level: 1 }, region: 'kr' },
        tags: ['a', 'c'],
        added: 42,
      },
    )

    expect(rows).toEqual([
      { path: 'added', kind: 'added', before: undefined, after: 42 },
      { path: 'removed', kind: 'removed', before: 'old', after: undefined },
      { path: 'tags', kind: 'changed', before: ['a', 'b'], after: ['a', 'c'] },
      { path: 'user.profile.active', kind: 'changed', before: true, after: false },
      { path: 'user.region', kind: 'added', before: undefined, after: 'kr' },
    ])
  })

  it('returns no rows when nested values are unchanged', () => {
    expect(
      buildEventChangeRows(
        { event: { id: '1', nested: { value: 10 } } },
        { event: { id: '1', nested: { value: 10 } } },
      ),
    ).toEqual([])
  })
})
