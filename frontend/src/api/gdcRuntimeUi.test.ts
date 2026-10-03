import { describe, expect, it } from 'vitest'
import {
  streamDeduplicationConfigWithKey,
  type StreamDeduplicationConfig,
} from './gdcRuntimeUi'

describe('streamDeduplicationConfigWithKey', () => {
  const existing: StreamDeduplicationConfig = {
    enabled: true,
    key_field: 'event_id',
    custom_jsonpath: null,
    duplicate_handling: 'keep_latest',
    scope: 'last_n_hours',
    window_hours: 24,
  }

  it('changes only the key while preserving the existing policy', () => {
    expect(streamDeduplicationConfigWithKey(existing, 'id')).toEqual({
      enabled: true,
      key_field: 'id',
      custom_jsonpath: null,
      duplicate_handling: 'keep_latest',
      scope: 'last_n_hours',
      window_hours: 24,
    })
  })

  it('preserves policy fields when disabling deduplication', () => {
    expect(streamDeduplicationConfigWithKey(existing, '')).toEqual({
      enabled: false,
      key_field: 'event_id',
      custom_jsonpath: null,
      duplicate_handling: 'keep_latest',
      scope: 'last_n_hours',
      window_hours: 24,
    })
  })
})
