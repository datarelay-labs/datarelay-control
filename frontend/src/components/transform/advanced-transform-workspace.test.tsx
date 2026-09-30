import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { defaultAdvancedRule } from '../../types/advancedTransform'
import { AdvancedTransformWorkspace } from './advanced-transform-workspace'

const runTransformPreview = vi.fn()

vi.mock('../../api/gdcRuntimePreview', () => ({
  runTransformPreview: (...args: unknown[]) => runTransformPreview(...args),
}))

describe('AdvancedTransformWorkspace', () => {
  beforeEach(() => {
    runTransformPreview.mockReset()
  })

  it('renders guidance without AI wording', () => {
    render(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ vendor: 'A' }}
        rules={[]}
        onRulesChange={() => {}}
        filterUiMode="advanced"
      />,
    )
    expect(screen.getByText(/외부 도구에서 작성한 JSONata/)).toBeInTheDocument()
    expect(screen.getByText(/AI 호출을 수행하지 않습니다/)).toBeInTheDocument()
    expect(screen.queryByText(/AI-assisted/i)).not.toBeInTheDocument()
  })

  it('runs preview and shows save_blocked', async () => {
    runTransformPreview.mockResolvedValue({
      stage: 'mapping',
      input_sample_summary: { is_object: true, top_level_keys: [], top_level_key_count: 0 },
      transformed_result: { score: null },
      field_results: [],
      errors: [{ level: 'event', error_code: 'INVALID_CONFIG', error_message: 'bad' }],
      warnings: [],
      save_blocked: true,
      duration_ms: 1,
      message: 'blocked',
    })

    const rule = defaultAdvancedRule('advanced')
    rule.outputField = 'score'
    rule.expression = '???'

    render(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ a: 1 }}
        rules={[rule]}
        onRulesChange={() => {}}
        filterUiMode="advanced"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Preview/i }))

    await waitFor(() => {
      expect(screen.getByText(/Save blocked/i)).toBeInTheDocument()
    })
    expect(runTransformPreview).toHaveBeenCalled()
  })

  it('shows warnings when preview recovers via default', async () => {
    runTransformPreview.mockResolvedValue({
      stage: 'mapping',
      input_sample_summary: { is_object: true, top_level_keys: ['a'], top_level_key_count: 1 },
      transformed_result: { derived: 'fallback' },
      field_results: [
        {
          success: true,
          value: 'fallback',
          error_code: 'JSONATA_EMPTY',
          error_message: 'empty',
          rule_id: null,
          output_field: 'derived',
          mode: 'jsonata',
          recovered_via_default: true,
        },
      ],
      errors: [],
      warnings: [{ output_field: 'derived', code: 'JSONATA_EMPTY', message: 'empty' }],
      save_blocked: false,
      duration_ms: 2,
      message: 'ok with warnings',
    })

    const rule = defaultAdvancedRule('advanced')
    rule.outputField = 'derived'
    rule.expression = 'missing'
    rule.defaultValue = 'fallback'

    render(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ present: true }}
        rules={[rule]}
        onRulesChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Preview/i }))

    await waitFor(() => {
      expect(screen.getByText(/ok with warnings/i)).toBeInTheDocument()
    })
    const defaultStatus = screen.getByText('default')
    expect(defaultStatus).toBeInTheDocument()
    const resultRow = defaultStatus.closest('tr')
    expect(resultRow).not.toBeNull()
    expect(within(resultRow as HTMLElement).getByText('"fallback"')).toBeInTheDocument()
    expect(screen.queryByText(/Save blocked/i)).not.toBeInTheDocument()
  })

  it('previews only the rules visible in the active Advanced/Expert tab', async () => {
    runTransformPreview.mockResolvedValue({
      stage: 'mapping',
      input_sample_summary: { is_object: true, top_level_keys: ['message'], top_level_key_count: 1 },
      transformed_result: {},
      field_results: [],
      errors: [],
      warnings: [],
      save_blocked: false,
      duration_ms: 1,
      message: 'ok',
    })

    const jsonataRule = defaultAdvancedRule('advanced')
    jsonataRule.outputField = 'principal'
    jsonataRule.expression = 'message'
    const regexRule = defaultAdvancedRule('expert')
    regexRule.outputField = 'source_ip'
    regexRule.sourcePath = '$.message'
    regexRule.pattern = 'src=(\\S+)'

    render(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ message: 'src=10.0.0.1' }}
        rules={[jsonataRule, regexRule]}
        onRulesChange={() => {}}
        filterUiMode="advanced"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Preview/i }))
    await waitFor(() => expect(runTransformPreview).toHaveBeenCalledTimes(1))

    const body = runTransformPreview.mock.calls[0][0]
    expect(body.rules).toHaveLength(1)
    expect(body.rules[0].mode).toBe('jsonata')
    expect(body.field_mappings.transform_rules).toHaveLength(1)
    expect(body.field_mappings.transform_rules[0].mode).toBe('jsonata')
  })

  it('exposes Timestamp → UTC insert for JSONata and limitation guidance for Regex', () => {
    const onRulesChange = vi.fn()

    const { rerender } = render(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ creationTime: 1673933930200 }}
        rules={[]}
        onRulesChange={onRulesChange}
        filterUiMode="advanced"
      />,
    )

    expect(screen.getByTestId('timestamp-utc-transform-guide')).toHaveAttribute('data-mode', 'jsonata')
    fireEvent.click(screen.getByTestId('timestamp-utc-insert-template'))
    expect(onRulesChange).toHaveBeenCalled()
    const nextRules = onRulesChange.mock.calls[0][0]
    expect(nextRules).toHaveLength(1)
    expect(nextRules[0].outputField).toBe('timestamp')
    expect(nextRules[0].expression).toContain('$fromMillis')

    rerender(
      <AdvancedTransformWorkspace
        stage="mapping"
        sampleEvent={{ creationTime: 1673933930200 }}
        rules={[]}
        onRulesChange={onRulesChange}
        filterUiMode="expert"
      />,
    )

    expect(screen.getByTestId('timestamp-utc-transform-guide')).toHaveAttribute('data-mode', 'regex')
    expect(screen.getByText(/Regex cannot reliably compute or normalize timestamps/i)).toBeInTheDocument()
    expect(screen.queryByTestId('timestamp-utc-insert-template')).not.toBeInTheDocument()
  })
})
