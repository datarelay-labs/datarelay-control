import { describe, expect, it, vi } from 'vitest'
import { buildInitialState } from './wizard-state'
import {
  buildSchemaDriftPolicyPersistPayload,
  persistWizardSchemaDriftPolicy,
} from './wizard-schema-drift-policy-persist'

vi.mock('../../../api/gdcStreams', () => ({
  updateStream: vi.fn(),
  fetchStreamById: vi.fn(),
}))

import { fetchStreamById, updateStream } from '../../../api/gdcStreams'

describe('wizard schema drift policy persist', () => {
  it('buildSchemaDriftPolicyPersistPayload normalizes wizard enums', () => {
    const state = buildInitialState()
    state.dataProtection.unknownNormalFieldPolicy = 'require_review'
    state.dataProtection.unknownSensitiveFieldPolicy = 'quarantine'
    expect(buildSchemaDriftPolicyPersistPayload(state.dataProtection)).toEqual({
      unknown_normal_field_policy: 'require_review',
      unknown_sensitive_field_policy: 'quarantine',
    })
  })

  it('persistWizardSchemaDriftPolicy PATCHes governance.schema_drift_policy', async () => {
    vi.mocked(updateStream).mockResolvedValueOnce({
      id: 42,
      config_json: {},
      updated_at: 'stream-next',
    } as never)

    const state = buildInitialState()
    state.dataProtection.unknownNormalFieldPolicy = 'quarantine'
    state.dataProtection.unknownSensitiveFieldPolicy = 'auto_protect'

    const result = await persistWizardSchemaDriftPolicy(42, state.dataProtection, {
      existingConfigJson: { endpoint: '/events' },
      expectedUpdatedAt: 'stream-reviewed',
    })

    expect(result.saved).toBe(true)
    expect(updateStream).toHaveBeenCalledWith(42, {
      config_json: {
        endpoint: '/events',
        governance: {
          schema_drift_policy: {
            unknown_normal_field_policy: 'quarantine',
            unknown_sensitive_field_policy: 'auto_protect',
          },
        },
      },
      expected_updated_at: 'stream-reviewed',
    })
    expect(result.streamUpdatedAt).toBe('stream-next')
  })

  it('persistWizardSchemaDriftPolicy fetches existing config when not provided', async () => {
    vi.mocked(fetchStreamById).mockResolvedValueOnce({
      id: 7,
      config_json: {
        endpoint: '/rest/visualsearch/query/simple',
        method: 'POST',
        body: { query: 'test' },
        headers: { Accept: 'application/json' },
      },
    } as never)
    vi.mocked(updateStream).mockResolvedValueOnce({ id: 7, config_json: {} } as never)

    const state = buildInitialState()
    const result = await persistWizardSchemaDriftPolicy(7, state.dataProtection)

    expect(fetchStreamById).toHaveBeenCalledWith(7)
    expect(result.saved).toBe(true)
    expect(updateStream).toHaveBeenCalledWith(7, {
      config_json: expect.objectContaining({
        endpoint: '/rest/visualsearch/query/simple',
        method: 'POST',
        body: { query: 'test' },
        headers: { Accept: 'application/json' },
        governance: {
          schema_drift_policy: {
            unknown_normal_field_policy: 'pass_through',
            unknown_sensitive_field_policy: 'auto_protect',
          },
        },
      }),
    })
  })

  it('persistWizardSchemaDriftPolicy returns errors on API failure', async () => {
    vi.mocked(fetchStreamById).mockResolvedValueOnce({
      id: 1,
      config_json: { endpoint: '/events' },
    } as never)
    vi.mocked(updateStream).mockRejectedValueOnce(new Error('network down'))
    const state = buildInitialState()
    const result = await persistWizardSchemaDriftPolicy(1, state.dataProtection)
    expect(result.saved).toBe(false)
    expect(result.errors[0]).toContain('network down')
  })
})
