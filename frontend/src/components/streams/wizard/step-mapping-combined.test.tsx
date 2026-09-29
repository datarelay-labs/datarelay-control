import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runEnrichmentTracePreview, runMappingDraftPreview, runTransformPreview } from '../../../api/gdcRuntimePreview'
import { StepMappingCombined } from './step-mapping-combined'
import {
  ENRICHMENT_RULE_TYPES,
  defaultRuleForType,
  enrichmentDictFromRules,
  type EnrichmentRuleType,
  type WizardEnrichmentRule,
} from './enrichment-rules-model'
import { loadWizardDraft, saveWizardDraft, clearWizardDraft } from './wizard-draft-migration'
import { buildInitialState, enrichmentDictFromRows, type WizardState } from './wizard-state'

vi.mock('../../../api/gdcRuntimePreview', async () => {
  const actual = await vi.importActual<typeof import('../../../api/gdcRuntimePreview')>(
    '../../../api/gdcRuntimePreview',
  )
  return {
    ...actual,
    runMappingDraftPreview: vi.fn(),
    runEnrichmentTracePreview: vi.fn(),
    runTransformPreview: vi.fn(),
  }
})

const mockedMappingDraftPreview = vi.mocked(runMappingDraftPreview)
const mockedEnrichmentTracePreview = vi.mocked(runEnrichmentTracePreview)
const mockedTransformPreview = vi.mocked(runTransformPreview)

vi.mock('./wizard-basic-mapping-panel', () => ({
  WizardBasicMappingPanel: () => (
    <div data-testid="wizard-basic-mapping-panel">
      <div data-testid="mapping-source-tree-panel">Sample Event</div>
      <div data-testid="mapping-field-table-panel">Field Mapping</div>
    </div>
  ),
}))

vi.mock('./wizard-full-event-transform-workspace', () => ({
  WizardFullEventTransformWorkspace: ({
    filterUiMode,
    sampleEvent,
  }: {
    filterUiMode?: string
    sampleEvent?: Record<string, unknown> | null
  }) => (
    <div
      data-testid="wizard-full-event-transform-workspace"
      data-filter-ui-mode={filterUiMode ?? ''}
      data-has-sample-event={sampleEvent ? 'yes' : 'no'}
    />
  ),
}))

function readyTransformState() {
  const state = buildInitialState()
  state.apiTest.status = 'success'
  state.apiTest.parsedJson = { events: [{ id: 'e1', message: 'hello' }] }
  state.apiTest.extractedEvents = [{ id: 'e1', message: 'hello' }]
  state.stream.eventArrayPath = '$.events'
  return state
}

function combinedProps(state: ReturnType<typeof buildInitialState>) {
  return {
    state,
    onChangeMapping: vi.fn(),
    onChangeMappingMode: vi.fn(),
    onChangeFullEventJsonata: vi.fn(),
    onChangeFullEventRegexConfigJson: vi.fn(),
    onChangeEnrichment: vi.fn(),
    onChangeDataProtection: vi.fn(),
  }
}

const RULE_TYPE_LABELS: Record<EnrichmentRuleType, string> = {
  static: 'New Static',
  calculated: 'New Calculated',
  lookup: 'Region Display Name',
  conditional: 'Outcome Status',
  normalize: 'Timestamp ISO',
}

function TransformHarness({
  initialState,
  onState,
}: {
  initialState: WizardState
  onState?: (state: WizardState) => void
}) {
  const [state, setState] = useState(initialState)
  const setEnrichment = useCallback((enrichment: WizardEnrichmentRule[]) => {
    setState((s) => {
      const next = { ...s, enrichment }
      onState?.(next)
      return next
    })
  }, [onState])

  return (
    <StepMappingCombined
      state={state}
      onChangeMapping={(mapping) => setState((s) => ({ ...s, mapping }))}
      onChangeMappingMode={(mappingMode) => setState((s) => ({ ...s, mappingMode }))}
      onChangeFullEventJsonata={(fullEventJsonataExpression) =>
        setState((s) => ({ ...s, fullEventJsonataExpression }))
      }
      onChangeFullEventRegexConfigJson={(fullEventRegexConfigJson) =>
        setState((s) => ({ ...s, fullEventRegexConfigJson }))
      }
      onChangeEnrichment={setEnrichment}
      onChangeDataProtection={() => {}}
    />
  )
}

describe('StepMappingCombined v3 Transform (206f0f7 mapping UI)', () => {
  beforeEach(() => {
    mockedMappingDraftPreview.mockReset()
    mockedEnrichmentTracePreview.mockReset()
    mockedTransformPreview.mockReset()
  })

  it('renders three tabs and + Add field action (no Generated Fields tab)', () => {
    render(<StepMappingCombined {...combinedProps(readyTransformState())} />)

    expect(screen.getByTestId('wizard-step-transform')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Basic · JSONPath/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Advanced · JSONata/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Expert · Regex/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Generated Fields/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-transform-add-field-menu')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-transform-enrichment-editor')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-transform-data-protection-card')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-generated-fields-panel')).not.toBeInTheDocument()
    expect(screen.queryByText(/Generated Fields/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-transform-sections')).not.toBeInTheDocument()
  })

  it('shows basic mapping panel on Basic tab', () => {
    render(<StepMappingCombined {...combinedProps(readyTransformState())} />)

    expect(screen.getByTestId('wizard-basic-mapping-panel')).toBeInTheDocument()
    expect(screen.getByTestId('mapping-source-tree-panel')).toHaveTextContent('Sample Event')
    expect(screen.getByTestId('mapping-field-table-panel')).toHaveTextContent('Field Mapping')
  })

  it('switches to full-event workspace on Advanced and Expert tabs', async () => {
    const user = userEvent.setup()
    render(<StepMappingCombined {...combinedProps(readyTransformState())} />)

    await user.click(screen.getByRole('tab', { name: /Advanced · JSONata/i }))
    expect(screen.getByTestId('wizard-full-event-transform-workspace')).toHaveAttribute(
      'data-filter-ui-mode',
      'advanced',
    )
    expect(screen.queryByTestId('wizard-basic-mapping-panel')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Expert · Regex/i }))
    expect(screen.getByTestId('wizard-full-event-transform-workspace')).toHaveAttribute(
      'data-filter-ui-mode',
      'expert',
    )
  })

  it('rebuilds sample event from raw preview when extracted events are empty', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.apiTest.extractedEvents = []
    state.apiTest.parsedJson = {
      events: [{ id: 'e2', message: 'rebuilt' }],
    }
    state.stream.eventArrayPath = '$.events'
    render(<StepMappingCombined {...combinedProps(state)} />)

    await user.click(screen.getByRole('tab', { name: /Advanced · JSONata/i }))
    expect(screen.getByTestId('wizard-full-event-transform-workspace')).toHaveAttribute(
      'data-has-sample-event',
      'yes',
    )
  })

  it('opens 206f0f7 enrichment add-field menu from + Add field while staying on current tab', async () => {
    const user = userEvent.setup()
    const props = combinedProps(readyTransformState())
    render(<StepMappingCombined {...props} />)

    expect(screen.getByTestId('wizard-basic-mapping-panel')).toBeInTheDocument()

    await user.click(screen.getByTestId('wizard-transform-add-field-trigger'))
    for (const meta of ENRICHMENT_RULE_TYPES) {
      expect(screen.getByTestId(`wizard-enrichment-add-${meta.type}`)).toBeInTheDocument()
    }

    await user.click(screen.getByTestId('wizard-enrichment-add-calculated'))
    expect(props.onChangeEnrichment).toHaveBeenCalled()
    expect(screen.getByTestId('wizard-basic-mapping-panel')).toBeInTheDocument()
  })

  it.each(ENRICHMENT_RULE_TYPES.map((meta) => [meta.type] as const))(
    'add-field menu creates a visible %s enrichment rule in wizard state',
    async (type) => {
      const user = userEvent.setup()
      render(<TransformHarness initialState={readyTransformState()} />)

      await user.click(screen.getByTestId('wizard-transform-add-field-trigger'))
      await user.click(screen.getByTestId(`wizard-enrichment-add-${type}`))

      expect(screen.getByText(RULE_TYPE_LABELS[type])).toBeInTheDocument()
      expect(screen.getByTestId('wizard-transform-enrichment-editor')).toHaveTextContent('1 total')
    },
  )

  it('persists added enrichment rules through draft save and restore', async () => {
    const user = userEvent.setup()
    clearWizardDraft()
    let latestState: WizardState | undefined
    render(<TransformHarness initialState={readyTransformState()} onState={(s) => { latestState = s }} />)

    await user.click(screen.getByTestId('wizard-transform-add-field-trigger'))
    await user.click(screen.getByTestId('wizard-enrichment-add-static'))
    await user.click(screen.getByTestId('wizard-transform-add-field-trigger'))
    await user.click(screen.getByTestId('wizard-enrichment-add-lookup'))

    await waitFor(() => {
      expect(latestState?.enrichment).toHaveLength(2)
    })

    saveWizardDraft(latestState!, 'route_processing')
    const restored = loadWizardDraft()
    expect(restored?.state.enrichment).toHaveLength(2)
    expect(restored?.state.enrichment[0]?.type).toBe('static')
    expect(restored?.state.enrichment[1]?.type).toBe('lookup')
    clearWizardDraft()
  })

  it('includes created enrichment rules in mapping-ui save payload adapter', () => {
    const rules = [
      defaultRuleForType('static', 0),
      defaultRuleForType('calculated', 1),
      defaultRuleForType('conditional', 2),
    ]

    const payload = enrichmentDictFromRows(rules)
    expect(payload['metadata.field_1']).toBe('')
    expect(payload.__rules).toBeDefined()
    expect((payload.__rules as Record<string, unknown>)['metadata.field_2']).toMatchObject({
      type: 'calculated',
    })
    expect((payload.__rules as Record<string, unknown>)['metadata.outcome']).toMatchObject({
      type: 'conditional',
    })
    expect(enrichmentDictFromRules(rules)).toEqual(payload)
  })

  it('uses runtime mapping preview before guided rule debugging', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.mapping = [
      { id: 'm1', sourceJsonPath: '$.id', outputField: 'event_id', origin: 'manual' },
    ]
    state.unmappedFieldsPolicy = 'drop_unmapped'
    const staticRule = defaultRuleForType('static', 0)
    staticRule.fieldName = 'vendor'
    staticRule.staticValue = 'Acme'
    state.enrichment = [staticRule]

    mockedMappingDraftPreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      mapped_events: [{ event_id: 'e1' }],
      missing_fields: [],
      message: 'ok',
    })
    mockedEnrichmentTracePreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      rule_count: 1,
      through_step: null,
      rule_summaries: [
        {
          step_index: 0,
          rule_type: 'static',
          target_field: 'vendor',
          executed_count: 1,
          changed_count: 1,
          warning_count: 0,
          error_count: 0,
          blocked_count: 0,
          failed_sample_indices: [],
        },
      ],
      samples: [
        {
          sample_index: 0,
          output_event: { event_id: 'e1', vendor: 'Acme' },
          steps: [],
          failed_step_index: null,
          duration_ms: 0,
        },
      ],
      message: 'ok',
    })

    render(<StepMappingCombined {...combinedProps(state)} />)
    await user.click(screen.getByRole('button', { name: 'Preview rules' }))

    await waitFor(() => expect(mockedMappingDraftPreview).toHaveBeenCalledTimes(1))
    expect(mockedMappingDraftPreview).toHaveBeenCalledWith({
      payload: { events: [{ id: 'e1', message: 'hello' }] },
      event_array_path: '$.events',
      event_root_path: null,
      field_mappings: {
        event_id: '$.id',
        unmapped_fields_policy: 'drop_unmapped',
      },
      max_events: 20,
    })
    expect(mockedEnrichmentTracePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        mapped_events: [{ event_id: 'e1' }],
        enrichment: { vendor: 'Acme' },
      }),
    )
  })

  it('uses runtime full-event JSONata preview before guided rule debugging', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.mappingMode = 'full_event_jsonata'
    state.fullEventJsonataExpression = '{"event_id": id}'
    const staticRule = defaultRuleForType('static', 0)
    staticRule.fieldName = 'vendor'
    staticRule.staticValue = 'Acme'
    state.enrichment = [staticRule]

    mockedTransformPreview.mockResolvedValue({
      stage: 'mapping',
      input_sample_summary: {
        is_object: true,
        top_level_keys: ['id', 'message'],
        top_level_key_count: 2,
      },
      transformed_result: { event_id: 'e1' },
      field_results: [],
      errors: [],
      warnings: [],
      save_blocked: false,
      duration_ms: 1,
      message: 'ok',
    })
    mockedEnrichmentTracePreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      rule_count: 1,
      through_step: null,
      rule_summaries: [
        {
          step_index: 0,
          rule_type: 'static',
          target_field: 'vendor',
          executed_count: 1,
          changed_count: 1,
          warning_count: 0,
          error_count: 0,
          blocked_count: 0,
          failed_sample_indices: [],
        },
      ],
      samples: [
        {
          sample_index: 0,
          output_event: { event_id: 'e1', vendor: 'Acme' },
          steps: [],
          failed_step_index: null,
          duration_ms: 0,
        },
      ],
      message: 'ok',
    })

    render(<StepMappingCombined {...combinedProps(state)} />)
    await user.click(screen.getByRole('button', { name: 'Preview rules' }))

    await waitFor(() => expect(mockedTransformPreview).toHaveBeenCalledTimes(1))
    expect(mockedTransformPreview).toHaveBeenCalledWith({
      stage: 'mapping',
      sample_event: { id: 'e1', message: 'hello' },
      field_mappings: {
        mapping_mode: 'full_event_jsonata',
        jsonata_expression: '{"event_id": id}',
      },
    })
    expect(mockedMappingDraftPreview).not.toHaveBeenCalled()
    expect(mockedEnrichmentTracePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        mapped_events: [{ event_id: 'e1' }],
        enrichment: { vendor: 'Acme' },
      }),
    )
  })

  it('uses runtime full-event Regex preview before guided rule debugging', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.mappingMode = 'full_event_regex'
    state.fullEventRegexConfigJson = JSON.stringify({
      preserve_source: false,
      rules: [
        {
          output_field: 'event_id',
          source_path: '$.id',
          pattern: '^(.+)$',
          group: 1,
        },
      ],
    })
    const staticRule = defaultRuleForType('static', 0)
    staticRule.fieldName = 'vendor'
    staticRule.staticValue = 'Acme'
    state.enrichment = [staticRule]

    mockedTransformPreview.mockResolvedValue({
      stage: 'mapping',
      input_sample_summary: {
        is_object: true,
        top_level_keys: ['id', 'message'],
        top_level_key_count: 2,
      },
      transformed_result: { event_id: 'e1' },
      field_results: [],
      errors: [],
      warnings: [],
      save_blocked: false,
      duration_ms: 1,
      message: 'ok',
    })
    mockedEnrichmentTracePreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      rule_count: 1,
      through_step: null,
      rule_summaries: [],
      samples: [
        {
          sample_index: 0,
          output_event: { event_id: 'e1', vendor: 'Acme' },
          steps: [],
          failed_step_index: null,
          duration_ms: 0,
        },
      ],
      message: 'ok',
    })

    render(<StepMappingCombined {...combinedProps(state)} />)
    await user.click(screen.getByRole('button', { name: 'Preview rules' }))

    await waitFor(() => expect(mockedTransformPreview).toHaveBeenCalledTimes(1))
    expect(mockedTransformPreview).toHaveBeenCalledWith({
      stage: 'mapping',
      sample_event: { id: 'e1', message: 'hello' },
      field_mappings: {
        mapping_mode: 'full_event_regex',
        preserve_source_fields: false,
        regex_rules: [
          {
            output_field: 'event_id',
            source_path: '$.id',
            pattern: '^(.+)$',
            capture_group: 1,
          },
        ],
      },
    })
    expect(mockedMappingDraftPreview).not.toHaveBeenCalled()
    expect(mockedEnrichmentTracePreview).toHaveBeenCalledWith(
      expect.objectContaining({ mapped_events: [{ event_id: 'e1' }] }),
    )
  })

  it('shows warning but keeps Transform editable when latest sample is missing', () => {
    render(<StepMappingCombined {...combinedProps(buildInitialState())} />)

    expect(screen.getByTestId('wizard-transform-sample-warning')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Basic · JSONPath/i })).toBeInTheDocument()
  })
})
