import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMappingPreview } from './useMappingPreview'

const runMappingValidate = vi.hoisted(() => vi.fn())
const runMappingDraftPreview = vi.hoisted(() => vi.fn())
const runFinalEventDraftPreview = vi.hoisted(() => vi.fn())

vi.mock('../api/gdcRuntimePreview', () => ({
  runMappingValidate: (...args: unknown[]) => runMappingValidate(...args),
  runMappingDraftPreview: (...args: unknown[]) => runMappingDraftPreview(...args),
  runFinalEventDraftPreview: (...args: unknown[]) => runFinalEventDraftPreview(...args),
}))

describe('useMappingPreview', () => {
  beforeEach(() => {
    runMappingValidate.mockReset()
    runMappingDraftPreview.mockReset()
    runFinalEventDraftPreview.mockReset()

    runMappingValidate.mockResolvedValue({ ok: true, warnings: [] })
    runMappingDraftPreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      mapped_events: [{ source_ip: '10.0.0.1' }],
      missing_fields: [],
      transform_results: [],
      message: 'ok',
    })
    runFinalEventDraftPreview.mockResolvedValue({
      input_event_count: 1,
      preview_event_count: 1,
      mapped_events: [{ source_ip: '10.0.0.1' }],
      final_events: [{ source_ip: '10.0.0.1' }],
      missing_fields: [],
      matched_policies: [],
      selected_destinations: [],
      failover_plan: [],
      would_quarantine: false,
      message: 'ok',
    })
  })

  it('runs preview for advanced-only mapping config and forwards transform_rules unchanged', async () => {
    const advancedConfig = {
      transform_rules: [
        {
          mode: 'regex_extract',
          output_field: 'source_ip',
          source_path: '$.message',
          pattern: 'src=(\\S+)',
          group: 1,
        },
      ],
    }

    const rawPayload = { message: 'src=10.0.0.1' }
    const rows: [] = []
    const enrichment = {}

    const { result } = renderHook(() =>
      useMappingPreview({
        rawPayload,
        eventArrayPath: '',
        eventRootPath: '',
        rows,
        fieldMappingsConfig: advancedConfig,
        enrichment,
        debounceMs: 0,
      }),
    )

    await waitFor(() => expect(runMappingDraftPreview).toHaveBeenCalledTimes(1))
    expect(runMappingDraftPreview.mock.calls[0][0].field_mappings).toEqual(advancedConfig)
    expect(runFinalEventDraftPreview.mock.calls[0][0].field_mappings).toEqual(advancedConfig)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
  })
})
