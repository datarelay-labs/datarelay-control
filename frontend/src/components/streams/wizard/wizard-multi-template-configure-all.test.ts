import { describe, expect, it } from 'vitest'
import {
  buildStreamsToConfigureFromMaterialization,
  wizardPersistErrorLabel,
} from './wizard-multi-template-configure'

describe('multi-template materialization configure-all (behavior A)', () => {
  it('builds configure targets for every created stream, not only the first', () => {
    const targets = buildStreamsToConfigureFromMaterialization([
      { stream_id: 11, config_json: { a: 1 } },
      { stream_id: 22, config_json: { b: 2 } },
      { stream_id: 33 },
    ])
    expect(targets.map((t) => t.streamId)).toEqual([11, 22, 33])
    expect(targets[0]?.configJson).toEqual({ a: 1 })
    expect(targets[1]?.configJson).toEqual({ b: 2 })
    expect(targets[2]?.configJson).toBeUndefined()
  })

  it('labels persist errors per stream when configuring multiple streams', () => {
    expect(wizardPersistErrorLabel(22, 'POST /routes/ failed', { multiStream: true })).toBe(
      'stream 22: POST /routes/ failed',
    )
    expect(wizardPersistErrorLabel(22, 'POST /routes/ failed', { multiStream: false })).toBe(
      'POST /routes/ failed',
    )
  })
})
