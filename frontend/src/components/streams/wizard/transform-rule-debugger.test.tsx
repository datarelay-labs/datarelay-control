import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runEnrichmentTracePreview } from '../../../api/gdcRuntimePreview'
import type { WizardEnrichmentRule } from './enrichment-rules-model'
import { TransformRuleDebugger } from './transform-rule-debugger'

vi.mock('../../../api/gdcRuntimePreview', async () => {
  const actual = await vi.importActual<typeof import('../../../api/gdcRuntimePreview')>(
    '../../../api/gdcRuntimePreview',
  )
  return {
    ...actual,
    runEnrichmentTracePreview: vi.fn(),
  }
})

const mockedTrace = vi.mocked(runEnrichmentTracePreview)

const rules: WizardEnrichmentRule[] = [
  {
    id: 'static-vendor',
    label: 'Vendor',
    fieldName: 'vendor',
    type: 'static',
    enabled: true,
    staticValue: 'Acme',
    expression: '',
    lookupTable: 'aws-regions',
    lookupKeyField: 'region',
    conditions: [],
    conditionalDefault: '',
    normalizeSourceField: 'timestamp',
    normalizeFormat: 'iso8601',
  },
  {
    id: 'calc-severity',
    label: 'Severity',
    fieldName: 'metadata.severity',
    type: 'calculated',
    enabled: true,
    staticValue: '',
    expression: "eventName.includes('Delete') ? 8 : 5",
    lookupTable: 'aws-regions',
    lookupKeyField: 'region',
    conditions: [],
    conditionalDefault: '',
    normalizeSourceField: 'timestamp',
    normalizeFormat: 'iso8601',
  },
]

function fullResponse() {
  return {
    input_event_count: 2,
    preview_event_count: 2,
    rule_count: 2,
    through_step: null,
    rule_summaries: [
      {
        step_index: 0,
        rule_type: 'static',
        target_field: 'vendor',
        executed_count: 2,
        changed_count: 2,
        warning_count: 0,
        error_count: 0,
        blocked_count: 0,
        failed_sample_indices: [],
      },
      {
        step_index: 1,
        rule_type: 'calculated',
        target_field: 'metadata.severity',
        executed_count: 2,
        changed_count: 2,
        warning_count: 0,
        error_count: 0,
        blocked_count: 0,
        failed_sample_indices: [],
      },
    ],
    samples: [
      {
        sample_index: 0,
        output_event: { eventName: 'CreateBucket', vendor: 'Acme', metadata: { severity: 5 } },
        steps: [],
        failed_step_index: null,
        duration_ms: 1,
      },
      {
        sample_index: 1,
        output_event: { eventName: 'DeleteBucket', vendor: 'Acme', metadata: { severity: 8 } },
        steps: [],
        failed_step_index: null,
        duration_ms: 1,
      },
    ],
    message: 'ok',
  }
}

describe('TransformRuleDebugger', () => {
  beforeEach(() => {
    mockedTrace.mockReset()
  })

  it('runs runtime-backed aggregate evidence and previews through a selected rule', async () => {
    const user = userEvent.setup()
    mockedTrace
      .mockResolvedValueOnce(fullResponse())
      .mockResolvedValueOnce({
        ...fullResponse(),
        through_step: 1,
        samples: [
          {
            sample_index: 0,
            output_event: { eventName: 'CreateBucket', vendor: 'Acme', metadata: { severity: 5 } },
            steps: [
              {
                step_index: 0,
                rule_type: 'static',
                target_field: 'vendor',
                executed: true,
                blocked: false,
                before_present: false,
                before_value: null,
                after_present: true,
                after_value: 'Acme',
                changed: true,
                warning_codes: [],
                warning_messages: [],
                error_message: null,
              },
              {
                step_index: 1,
                rule_type: 'calculated',
                target_field: 'metadata.severity',
                executed: true,
                blocked: false,
                before_present: false,
                before_value: null,
                after_present: true,
                after_value: 5,
                changed: true,
                warning_codes: [],
                warning_messages: [],
                error_message: null,
              },
            ],
            failed_step_index: null,
            duration_ms: 1,
          },
          fullResponse().samples[1],
        ],
      })

    render(
      <TransformRuleDebugger
        loadMappedEvents={async () => [{ eventName: 'CreateBucket' }, { eventName: 'DeleteBucket' }]}
        sampleAvailable
        rules={rules}
        overridePolicy="KEEP_EXISTING"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Preview rules' }))

    expect(mockedTrace).toHaveBeenCalledTimes(1)
    expect(mockedTrace.mock.calls[0]?.[0]).toMatchObject({
      mapped_events: [{ eventName: 'CreateBucket' }, { eventName: 'DeleteBucket' }],
      override_policy: 'KEEP_EXISTING',
      enrichment: {
        vendor: 'Acme',
        __rules: {
          'metadata.severity': expect.objectContaining({ type: 'calculated' }),
        },
      },
    })
    expect(screen.getByText('2 runtime steps · 2 samples')).toBeInTheDocument()
    expect(screen.getByText('vendor')).toBeInTheDocument()
    expect(screen.getByText('metadata.severity')).toBeInTheDocument()

    const severityRow = screen.getByText('metadata.severity').closest('tr')
    expect(severityRow).not.toBeNull()
    await user.click(within(severityRow as HTMLElement).getByRole('button', { name: /Preview through/i }))

    expect(mockedTrace).toHaveBeenCalledTimes(2)
    expect(mockedTrace.mock.calls[1]?.[0]).toMatchObject({ through_step: 1 })
    expect(await screen.findByText('After rule #2 · metadata.severity')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/"severity": 5/)).toBeInTheDocument()
  })

  it('surfaces failed samples as direct evidence actions', async () => {
    const user = userEvent.setup()
    const response = fullResponse()
    response.rule_summaries[1] = {
      ...response.rule_summaries[1],
      executed_count: 1,
      error_count: 1,
      failed_sample_indices: [1],
    }
    mockedTrace.mockResolvedValue(response)

    render(
      <TransformRuleDebugger
        loadMappedEvents={async () => [{ eventName: 'CreateBucket' }, { eventName: 'DeleteBucket' }]}
        sampleAvailable
        rules={rules}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Preview rules' }))

    expect(screen.getByRole('button', { name: 'Sample 2' })).toBeInTheDocument()
  })
})


describe('TransformRuleDebugger stale request protection', () => {
  beforeEach(() => {
    mockedTrace.mockReset()
  })

  it('discards a preview response when the rules change before it returns', async () => {
    const user = userEvent.setup()
    let resolvePreview!: (value: ReturnType<typeof fullResponse>) => void
    const pendingPreview = new Promise<ReturnType<typeof fullResponse>>((resolve) => {
      resolvePreview = resolve
    })
    mockedTrace.mockReturnValueOnce(pendingPreview)

    const loadMappedEvents = async () => [{ eventName: 'CreateBucket' }, { eventName: 'DeleteBucket' }]
    const { rerender } = render(
      <TransformRuleDebugger
        loadMappedEvents={loadMappedEvents}
        sampleAvailable
        rules={[rules[0]!]}
        overridePolicy="KEEP_EXISTING"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Preview rules' }))
    expect(mockedTrace).toHaveBeenCalledTimes(1)

    rerender(
      <TransformRuleDebugger
        loadMappedEvents={loadMappedEvents}
        sampleAvailable
        rules={[{ ...rules[0]!, staticValue: 'Updated' }]}
        overridePolicy="KEEP_EXISTING"
      />,
    )

    resolvePreview({
      ...fullResponse(),
      rule_count: 1,
      rule_summaries: [fullResponse().rule_summaries[0]!],
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Preview rules' })).toBeEnabled()
    })
    expect(screen.queryByText('1 runtime step · 2 samples')).not.toBeInTheDocument()
  })
})
