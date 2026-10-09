import { describe, expect, it } from 'vitest'
import type { OperationalSnapshotResponse } from '../../api/operationalSnapshot'
import { presentShellRuntimeStatus } from './shell-runtime-status'

const NOW = Date.parse('2026-10-09T15:00:00Z')
const sample = {
  updated_at: new Date(NOW).toISOString(),
  global: {
    health_status: 'HEALTHY',
    enabled_streams: 2,
    running_streams: 2,
    total_routes: 3,
  },
} as OperationalSnapshotResponse

describe('presentShellRuntimeStatus — Runtime Is Truth', () => {
  it('keeps a missing or pending API snapshot neutral, never Offline or Healthy', () => {
    expect(presentShellRuntimeStatus(null, { loading: true, nowMs: NOW })).toMatchObject({
      label: 'Checking', healthy: null,
    })
    expect(presentShellRuntimeStatus(null, { loading: false, nowMs: NOW })).toMatchObject({
      label: 'Not verified', healthy: null,
    })
  })

  it('uses healthy only for a fresh, runtime-reported HEALTHY snapshot', () => {
    const presentation = presentShellRuntimeStatus(sample, { nowMs: NOW })
    expect(presentation).toMatchObject({ label: 'Healthy', healthy: true })
    expect(presentation.evidence).toContain('2 running / 2 enabled Streams · 3 Routes')
    expect(presentation.evidence).toContain('Receiver ingestion is not verified')
  })

  it.each(['DEGRADED', 'ERROR'] as const)('flags %s as Attention, not offline', (health) => {
    expect(presentShellRuntimeStatus({
      ...sample,
      global: { ...sample.global, health_status: health },
    }, { nowMs: NOW })).toMatchObject({ label: 'Attention', healthy: false })
  })

  it('handles idle or no running streams without fabricated active delivery', () => {
    for (const global of [
      { ...sample.global, health_status: 'IDLE' as const },
      { ...sample.global, enabled_streams: 0, running_streams: 0 },
      { ...sample.global, enabled_streams: 2, running_streams: 0 },
    ]) {
      expect(presentShellRuntimeStatus({ ...sample, global }, { nowMs: NOW })).toMatchObject({
        label: 'Idle', healthy: null,
      })
    }
  })

  it('refuses green health for old, invalid, or far-future snapshots', () => {
    for (const updated_at of [
      'invalid',
      new Date(NOW - 91_000).toISOString(),
      new Date(NOW + 61_000).toISOString(),
    ]) {
      expect(presentShellRuntimeStatus({ ...sample, updated_at }, { nowMs: NOW })).toMatchObject({
        label: 'Stale', healthy: null,
      })
    }
  })

  it('keeps an explicit development fixture separate from live health', () => {
    const presentation = presentShellRuntimeStatus(sample, { fixture: true, nowMs: NOW })
    expect(presentation).toMatchObject({ label: 'Fixture', healthy: null })
    expect(presentation.evidence).toContain('not live runtime')
  })

  it('treats invalid runtime counters as unknown, not success', () => {
    expect(presentShellRuntimeStatus({
      ...sample,
      global: { ...sample.global, running_streams: Number.NaN },
    }, { nowMs: NOW })).toMatchObject({ label: 'Not verified', healthy: null })
  })
})
