import { describe, expect, it } from 'vitest'
import {
  applyExplicitCheckpointClear,
  applyExplicitEventPathClear,
  buildAdvancedStreamConfigJsonPatch,
  checkpointSourcePathFromPersistedCursor,
  mergeStreamConfigJson,
  readAdvancedStreamConfigFromPersisted,
} from './wizard-stream-config-sync'

describe('wizard-stream-config-sync', () => {
  it('hydrates checkpoint and schema paths from persisted config and mapping', () => {
    const hydrated = readAdvancedStreamConfigFromPersisted(
      {
        checkpoint: {
          mode: 'Timestamp',
          cursor_path: '$.data.results[*].creationTime',
          secondary_cursor_path: '$.data.results[*].id',
          cursor_paths: ['$.data.results[*].creationTime', '$.data.results[*].id'],
        },
        schema: { root_path: '$.metadata' },
        runtime_ui: { record_selection_mode: 'advanced' },
        initial_delay_sec: 5,
        pagination: { type: 'none' },
      },
      {
        event_array_path: '$.data.results',
        event_root_path: '$.EventDetailsKey',
      },
    )

    expect(hydrated.eventArrayPath).toBe('data.results')
    expect(hydrated.eventRootPath).toBe('EventDetailsKey')
    expect(hydrated.checkpointMode).toBe('Timestamp')
    expect(hydrated.recordSelectionMode).toBe('advanced')
    expect(hydrated.checkpointSourcePath).toBe('$.creationTime')
    expect(hydrated.checkpointSecondaryPath).toBe('$.id')
    expect(hydrated.schemaRootPath).toBe('$.metadata')
    expect(hydrated.initialDelaySec).toBe(5)
  })

  it('persists wizard checkpoint paths back to config_json.checkpoint', () => {
    const patch = buildAdvancedStreamConfigJsonPatch({
      checkpointMode: 'Cursor',
      checkpointSourcePath: '$.creationTime',
      checkpointSecondaryPath: '',
      checkpointFieldType: 'TIMESTAMP',
      eventArrayPath: 'data.results',
      recordSelectionMode: 'advanced',
      schemaRootPath: '',
      initialDelaySec: 0,
      paginationType: 'None',
      paginationCursorParam: '',
      paginationPageSize: 0,
      paginationMaxPages: 0,
    })

    expect(patch.checkpoint).toMatchObject({
      mode: 'Cursor',
      cursor_path: '$.data.results[*].creationTime',
    })
    expect(patch.runtime_ui).toMatchObject({ record_selection_mode: 'advanced' })
  })

  it('persists explicitly selected Timestamp mode with sort recommendation tie-breaker', () => {
    const patch = buildAdvancedStreamConfigJsonPatch({
      checkpointMode: 'Timestamp',
      checkpointSourcePath: '$.timestamp',
      checkpointSecondaryPath: '$.id',
      checkpointFieldType: 'TIMESTAMP',
      eventArrayPath: '$.events',
      recordSelectionMode: 'basic',
      schemaRootPath: '',
      initialDelaySec: 0,
      paginationType: 'None',
      paginationCursorParam: '',
      paginationPageSize: 0,
      paginationMaxPages: 0,
    })
    expect(patch.checkpoint).toMatchObject({
      mode: 'Timestamp',
      cursor_path: '$.events[*].timestamp',
      secondary_cursor_path: '$.events[*].id',
      comparator: 'lexicographical',
    })
    const reloaded = readAdvancedStreamConfigFromPersisted(patch)
    expect(reloaded.checkpointMode).toBe('Timestamp')
    expect(reloaded.checkpointFieldType).toBe('TIMESTAMP')
  })

  it('removes a cleared secondary cursor and keeps the primary checkpoint', () => {
    const patch = buildAdvancedStreamConfigJsonPatch({
      checkpointMode: 'Cursor',
      checkpointSourcePath: '$.id',
      checkpointSecondaryPath: '',
      checkpointFieldType: 'STRING',
      eventArrayPath: '',
      recordSelectionMode: 'basic',
      schemaRootPath: '',
      initialDelaySec: 0,
      paginationType: 'None',
      paginationCursorParam: '',
      paginationPageSize: 0,
      paginationMaxPages: 0,
    })
    const cleared = applyExplicitCheckpointClear(
      patch,
      { checkpointSourcePath: '$.id', checkpointSecondaryPath: '$.seq' },
      { checkpointSourcePath: '$.id', checkpointSecondaryPath: '' },
    )
    const merged = mergeStreamConfigJson(
      { checkpoint: { cursor_path: '$.id', secondary_cursor_path: '$.seq', vendor_cursor: 'keep' } },
      {},
      cleared,
    )
    expect(merged.checkpoint).toMatchObject({ cursor_path: '$.id', vendor_cursor: 'keep' })
    expect(merged.checkpoint).not.toHaveProperty('secondary_cursor_path')
  })

  it('deep-merges runtime_ui so incremental metadata does not erase existing UI metadata', () => {
    const merged = mergeStreamConfigJson(
      { runtime_ui: { existing_flag: true, record_selection_mode: 'basic' } },
      {
        runtime_ui: {
          incremental_request: {
            pattern: 'query_params',
            draft: 'cursor={{checkpoint.last_timestamp}}',
            base_method: 'GET',
            base_params: { tenant: 'acme' },
            base_body: null,
          },
        },
      },
      { runtime_ui: { record_selection_mode: 'advanced' } },
    )
    expect(merged.runtime_ui).toEqual({
      existing_flag: true,
      record_selection_mode: 'advanced',
      incremental_request: expect.objectContaining({ pattern: 'query_params' }),
    })
  })

  it('removes a cleared event array or root path and leaves an untouched path in place', () => {
    const cleared = applyExplicitEventPathClear(
      { event_array_path: '$.items', event_root_path: '$.meta', vendor: true },
      { eventArrayPath: 'items', eventRootPath: 'meta', useWholeResponseAsEvent: false },
      { eventArrayPath: '', eventRootPath: 'meta', useWholeResponseAsEvent: false },
    )
    expect(cleared.clearArray).toBe(true)
    expect(cleared.clearRoot).toBe(false)
    expect(cleared.config).not.toHaveProperty('event_array_path')
    expect(cleared.config.event_root_path).toBe('$.meta')
    expect(cleared.config.vendor).toBe(true)

    const untouched = applyExplicitEventPathClear(
      { event_array_path: '$.items' },
      { eventArrayPath: 'items', eventRootPath: '', useWholeResponseAsEvent: false },
      { eventArrayPath: 'items', eventRootPath: '', useWholeResponseAsEvent: false },
    )
    expect(untouched.config.event_array_path).toBe('$.items')
  })

  it('converts persisted absolute cursor paths to wizard-relative paths', () => {
    expect(
      checkpointSourcePathFromPersistedCursor('$.data.results[*].EventDetailsKey.id', 'data.results'),
    ).toBe('$.EventDetailsKey.id')
  })
})
