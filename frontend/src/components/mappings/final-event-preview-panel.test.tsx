import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MappingPreviewState } from '../../hooks/useMappingPreview'
import type { MappingRowModel } from '../streams/stream-mapping-model'
import { FinalEventPreviewPanel } from './final-event-preview-panel'

const rows: MappingRowModel[] = [
  { id: 'count', sourceJsonPath: '$.count', outputField: 'count', type: 'number', origin: 'manual' },
  { id: 'missing', sourceJsonPath: '$.missing', outputField: 'missing', type: 'string', origin: 'manual' },
]

const preview: MappingPreviewState = {
  loading: false,
  error: null,
  mapped: {
    input_event_count: 2,
    preview_event_count: 2,
    mapped_events: [
      { count: 1, missing: null },
      { count: 2, missing: null },
    ],
    missing_fields: [{ output_field: 'missing', json_path: '$.missing', event_index: 1 }],
    message: 'ok',
  },
  final: {
    input_event_count: 2,
    preview_event_count: 2,
    mapped_events: [
      { count: 1, missing: null },
      { count: 2, missing: null },
    ],
    final_events: [
      { count: '1', missing: null, nested: { active: false } },
      { count: 2, missing: null },
    ],
    missing_fields: [{ output_field: 'missing', json_path: '$.missing', event_index: 1 }],
    matched_policies: [],
    selected_destinations: [],
    failover_plan: [],
    would_quarantine: false,
    message: 'ok',
  },
  validationWarnings: [],
}

describe('FinalEventPreviewPanel', () => {
  it('opens changes-first and shows multi-sample transform evidence', () => {
    render(
      <FinalEventPreviewPanel
        preview={preview}
        rawSampleEvent={{ count: 1, missing: null, nested: { active: true } }}
        rawSampleEvents={[
          { count: 1, missing: null, nested: { active: true } },
          { count: 2 },
        ]}
        rows={rows}
        eventCount={2}
        sampleEventIndex={0}
        onSampleIndexChange={() => {}}
        onRefresh={() => {}}
        warnings={[{ code: 'SAMPLE_WARNING', severity: 'warning', message: 'Review sample' }]}
      />,
    )

    expect(screen.getByRole('tab', { name: /^Changes \(2\)$/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Field matches')).toBeInTheDocument()
    expect(screen.getByText('3/4')).toBeInTheDocument()

    const validationTable = screen.getByText('Validation by field').closest('section')
    expect(validationTable).not.toBeNull()
    const scope = within(validationTable as HTMLElement)
    expect(scope.getByText('count')).toBeInTheDocument()
    expect(scope.getByText('missing')).toBeInTheDocument()
    expect(scope.getByText('1 changed')).toBeInTheDocument()

    expect(screen.getByText('nested.active')).toBeInTheDocument()
    expect(screen.getByText('SAMPLE_WARNING:')).toBeInTheDocument()
  })

  it('caps selectable samples to the locally available extracted events', () => {
    render(
      <FinalEventPreviewPanel
        preview={{
          ...preview,
          mapped: { ...preview.mapped!, preview_event_count: 20 },
          final: { ...preview.final!, preview_event_count: 20 },
        }}
        rawSampleEvent={{ count: 1 }}
        rawSampleEvents={[{ count: 1 }, { count: 2 }]}
        rows={rows}
        eventCount={20}
        sampleEventIndex={0}
        onSampleIndexChange={() => {}}
        onRefresh={() => {}}
        warnings={[]}
      />,
    )

    expect(screen.getByRole('option', { name: 'Event 1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Event 2' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Event 3' })).not.toBeInTheDocument()
  })
})
