import { describe, expect, it } from 'vitest'

import { MAPPING_STOP_FIRST_MESSAGE, mappingSaveBlockedReason } from './mappingSaveGate'

describe('mappingSaveBlockedReason (F-173)', () => {
  it('allows a save only when the stream is stopped or idle', () => {
    expect(mappingSaveBlockedReason('STOPPED')).toBeNull()
    expect(mappingSaveBlockedReason('stopped')).toBeNull()
    expect(mappingSaveBlockedReason(' IDLE ')).toBeNull()
  })

  it.each(['RUNNING', 'STOPPING', 'DEGRADED', 'ERROR', 'PAUSED', 'UNKNOWN', '', null, undefined])(
    'asks to stop first when the status is %s',
    (status) => {
      expect(mappingSaveBlockedReason(status)).toBe(MAPPING_STOP_FIRST_MESSAGE)
    },
  )
})
