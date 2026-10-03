import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runEnrichmentTracePreview, runMappingDraftPreview, runTransformPreview } from '../../../api/gdcRuntimePreview'
import { StepMappingCombined } from './step-mapping-combined'
import {
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
    onChangeTransformRules: vi.fn(),
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

  it('renders a task-first launcher and secondary editor tabs', () => {
    render(<StepMappingCombined {...combinedProps(readyTransformState())} />)

    expect(screen.getByTestId('wizard-step-transform')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Fields · Basic/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /JSONata · Advanced/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Regex · Expert/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Generated Fields/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('transform-rule-launcher')).toBeInTheDocument()
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

  it('keeps Advanced and Expert tabs in per-field mode until full-event mode is selected', async () => {
    const user = userEvent.setup()
    render(<TransformHarness initialState={readyTransformState()} />)

    await user.click(screen.getByRole('tab', { name: /JSONata · Advanced/i }))
    expect(screen.queryByTestId('wizard-full-event-transform-workspace')).not.toBeInTheDocument()
    expect(screen.getByText(/Per-field mode is active/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Full-event mode' }))
    expect(screen.getByTestId('wizard-full-event-transform-workspace')).toHaveAttribute(
      'data-filter-ui-mode',
      'advanced',
    )

    await user.click(screen.getByRole('tab', { name: /Regex · Expert/i }))
    expect(screen.queryByTestId('wizard-full-event-transform-workspace')).not.toBeInTheDocument()
    expect(screen.getByText(/Per-field mode is active/i)).toBeInTheDocument()
  })

  it('rebuilds sample event from raw preview when extracted events are empty', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.apiTest.extractedEvents = []
    state.apiTest.parsedJson = {
      events: [{ id: 'e2', message: 'rebuilt' }],
    }
    state.stream.eventArrayPath = '$.events'
    render(<TransformHarness initialState={state} />)

    await user.click(screen.getByRole('tab', { name: /JSONata · Advanced/i }))
    await user.click(screen.getByRole('button', { name: 'Full-event mode' }))
    expect(screen.getByTestId('wizard-full-event-transform-workspace')).toHaveAttribute(
      'data-has-sample-event',
      'yes',
    )
  })

  it('opens a task-first Add transform menu without promoting Lookup', async () => {
    const user = userEvent.setup()
    render(<StepMappingCombined {...combinedProps(readyTransformState())} />)

    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))

    for (const action of ['map_rename', 'static', 'calculated', 'normalize', 'conditional', 'jsonata', 'regex']) {
      expect(screen.getByTestId(`transform-launcher-${action}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('transform-launcher-lookup')).not.toBeInTheDocument()
    expect(screen.getByText('Guided')).toBeInTheDocument()
    expect(screen.getByText('Full-event editors')).toBeInTheDocument()
  })

  it('Map / rename opens the Fields editor and creates an empty mapping row', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.mappingMode = 'full_event_jsonata'
    const props = combinedProps(state)
    render(<StepMappingCombined {...props} />)

    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-map_rename'))

    expect(props.onChangeMappingMode).toHaveBeenCalledWith('basic_jsonpath')
    expect(props.onChangeMapping).toHaveBeenCalledWith([
      expect.objectContaining({ outputField: '', sourceJsonPath: '', origin: 'manual' }),
    ])
  })

  it.each([
    ['static', 'static'],
    ['calculated', 'calculated'],
    ['normalize', 'normalize'],
    ['conditional', 'conditional'],
  ] as const)(
    'task launcher creates a runtime-backed %s Guided Transform rule',
    async (action, type) => {
      const user = userEvent.setup()
      render(<TransformHarness initialState={readyTransformState()} />)

      await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
      await user.click(screen.getByTestId(`transform-launcher-${action}`))

      expect(screen.getByText(RULE_TYPE_LABELS[type])).toBeInTheDocument()
      expect(screen.getByTestId('wizard-transform-enrichment-editor')).toHaveTextContent('1 total')
    },
  )

  it('requests runtime enablement only when a guided Transform rule is added', async () => {
    const user = userEvent.setup()
    const state = readyTransformState()
    state.enrichmentEnabled = false
    state.enrichment = [defaultRuleForType('static', 0)]
    const onEnableEnrichment = vi.fn()
    const props = { ...combinedProps(state), onEnableEnrichment }

    render(<StepMappingCombined {...props} />)

    await user.click(screen.getByRole('button', { name: 'Expand rule' }))
    const displayName = screen.getByLabelText('Display name')
    await user.clear(displayName)
    await user.type(displayName, 'Edited Static')

    expect(props.onChangeEnrichment).toHaveBeenCalled()
    expect(onEnableEnrichment).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-static'))

    expect(onEnableEnrichment).toHaveBeenCalledTimes(1)
  })

  it('JSONata and Regex tasks create persisted per-field transform rules', async () => {
    const user = userEvent.setup()
    const jsonataProps = combinedProps(readyTransformState())
    const { unmount } = render(<StepMappingCombined {...jsonataProps} />)

    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-jsonata'))
    expect(jsonataProps.onChangeMappingMode).toHaveBeenCalledWith('basic_jsonpath')
    expect(jsonataProps.onChangeTransformRules).toHaveBeenCalledWith([
      expect.objectContaining({ mode: 'jsonata', uiMode: 'advanced' }),
    ])

    unmount()
    const regexProps = combinedProps(readyTransformState())
    render(<StepMappingCombined {...regexProps} />)
    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-regex'))
    expect(regexProps.onChangeMappingMode).toHaveBeenCalledWith('basic_jsonpath')
    expect(regexProps.onChangeTransformRules).toHaveBeenCalledWith([
      expect.objectContaining({ mode: 'regex_extract', uiMode: 'expert' }),
    ])
  })

  it('persists launcher-created Guided Transform rules through draft save and restore', async () => {
    const user = userEvent.setup()
    clearWizardDraft()
    let latestState: WizardState | undefined
    render(<TransformHarness initialState={readyTransformState()} onState={(s) => { latestState = s }} />)

    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-static'))
    await user.click(screen.getByTestId('transform-rule-launcher-trigger'))
    await user.click(screen.getByTestId('transform-launcher-calculated'))

    await waitFor(() => {
      expect(latestState?.enrichment).toHaveLength(2)
    })

    saveWizardDraft(latestState!, 'route_processing')
    const restored = loadWizardDraft()
    expect(restored?.state.enrichment).toHaveLength(2)
    expect(restored?.state.enrichment[0]?.type).toBe('static')
    expect(restored?.state.enrichment[1]?.type).toBe('calculated')
    clearWizardDraft()
  })

  it('keeps an existing persisted Lookup rule visible even though Lookup is not a primary add action', () => {
    const state = readyTransformState()
    state.enrichment = [defaultRuleForType('lookup', 0)]

    render(<StepMappingCombined {...combinedProps(state)} />)

    expect(screen.getByText('Region Display Name')).toBeInTheDocument()
    expect(screen.getByText('Lookup')).toBeInTheDocument()
    expect(screen.queryByTestId('transform-launcher-lookup')).not.toBeInTheDocument()
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

  it('invalidates cached runtime mapping preview when mapping input changes', async () => {
    const state = readyTransformState()
    state.mapping = [{ id: 'm1', sourceJsonPath: '$.id', outputField: 'event_id', origin: 'manual' }]
    mockedMappingDraftPreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      mapped_events: [{ event_id: 'e1' }],
      missing_fields: [],
      message: 'ok',
    })

    const { rerender } = render(<StepMappingCombined {...combinedProps(state)} />)
    await waitFor(() => expect(mockedMappingDraftPreview).toHaveBeenCalledTimes(1))

    const changedState = {
      ...state,
      mapping: [{ id: 'm1', sourceJsonPath: '$.message', outputField: 'event_id', origin: 'manual' as const }],
    }
    rerender(<StepMappingCombined {...combinedProps(changedState)} />)

    await waitFor(() => expect(mockedMappingDraftPreview).toHaveBeenCalledTimes(2))
    expect(mockedMappingDraftPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        field_mappings: expect.objectContaining({ event_id: '$.message' }),
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
    expect(screen.getByRole('tab', { name: /Fields · Basic/i })).toBeInTheDocument()
  })
})
