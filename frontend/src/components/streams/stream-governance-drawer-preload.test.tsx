import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StreamRuntimeDetailPage } from './stream-runtime-detail-page'
import { QuarantinePanel } from './quarantine-panel'
import { ReplayPanel } from './replay-panel'
import { SchemaDriftPanel } from './schema-drift-panel'
import * as gdcSchemaDrift from '../../api/gdcSchemaDrift'
import * as gdcSensitiveFindings from '../../api/gdcSensitiveFindings'
import * as gdcProtection from '../../api/gdcProtection'
import * as gdcPolicy from '../../api/gdcPolicy'
import * as gdcDynamicRouting from '../../api/gdcDynamicRouting'
import * as gdcFailoverRouting from '../../api/gdcFailoverRouting'
import * as gdcReplay from '../../api/gdcReplay'
import * as gdcQuarantine from '../../api/gdcQuarantine'
import * as gdcClassification from '../../api/gdcClassification'
import { notifyStreamGovernanceChanged } from '../../lib/stream-governance-events'
import { persistRuntimeRefreshEvery, persistStreamRuntimeMetricsAutoRefresh } from '../../localPreferences'
import { compatibleGovernancePreload } from '../../lib/stream-governance-snapshot'

const { mockFetchStreamById } = vi.hoisted(() => ({
  mockFetchStreamById: vi.fn(async (id: number) => ({
    id,
    name: `Stream ${id}`,
    stream_type: 'HTTP_API_POLLING',
    connector_id: 1,
  })),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: mockFetchStreamById,
}))

vi.mock('../../api/gdcRuntimePipelineDebug', () => ({
  runStreamPipelineDebug: vi.fn(async () => ({
    stream_id: 42,
    raw_event: null,
    mapped_event: null,
    enriched_event: null,
    formatted_payload: null,
    routes: [],
    warnings: [],
    errors: [],
  })),
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  fetchMappingSourceSample: vi.fn(async () => ({
    ok: false,
    sourceType: 'HTTP_API_POLLING',
    rawPayload: null,
    treeDocument: {},
    unionSchema: null,
    extractedEvents: [],
    eventArrayPath: '',
    eventRootPath: '',
    sampleEventIndex: 0,
    message: 'No sample',
    recordsLabel: '—',
    fetchedAt: '',
  })),
}))

vi.mock('../../api/gdcRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntime')>()
  return {
    ...actual,
    fetchStreamRuntimeTimeline: vi.fn(async () => null),
    fetchStreamRuntimeStatsHealth: vi.fn(async () => ({ stats: null, health: null })),
    fetchStreamRuntimeMetrics: vi.fn(async () => ({
      snapshot_id: 't',
      generated_at: 't',
      stream: {
        id: 42,
        name: 'Stream 42',
        status: 'RUNNING',
        last_run_at: null,
        last_success_at: null,
        last_error_at: null,
        last_checkpoint: null,
      },
      kpis: {
        events_last_hour: 0,
        delivered_last_hour: 0,
        failed_last_hour: 0,
        delivery_success_rate: 100,
        avg_latency_ms: 0,
        max_latency_ms: 0,
        error_rate: 0,
      },
      events_over_time: [],
      route_health: [],
      checkpoint_history: [],
      recent_runs: [],
      route_runtime: [],
      recent_route_errors: [],
    })),
    fetchStreamCheckpointHistory: vi.fn(async () => null),
    searchRuntimeDeliveryLogs: vi.fn(async () => ({ total_returned: 0, filters: {}, logs: [] })),
    runStreamOnce: vi.fn(),
    startRuntimeStream: vi.fn(async () => null),
    stopRuntimeStream: vi.fn(async () => null),
  }
})

const SUMMARY_KEYS = [
  'schemaDrift',
  'sensitive',
  'protection',
  'policy',
  'dynamicRouting',
  'failover',
  'replay',
  'quarantine',
] as const

function installSpies() {
  const schemaDriftSummary = vi.spyOn(gdcSchemaDrift, 'fetchStreamSchemaFieldDriftsSummary').mockResolvedValue({
    stream_id: 42,
    open_count: 0,
    acknowledged_count: 0,
    resolved_count: 0,
    by_category: { field_added: 0, field_removed: 0, field_type_changed: 0 },
    baseline_version: 1,
    baseline_established_at: null,
    baseline_reset_at: null,
    drift_detection_enabled: true,
  })
  const schemaDriftDetail = vi.spyOn(gdcSchemaDrift, 'fetchStreamSchemaFieldDrifts').mockResolvedValue({
    stream_id: 42,
    findings: [],
    finding_count: 0,
  })
  const sensitiveSummary = vi.spyOn(gdcSensitiveFindings, 'fetchStreamSensitiveFindingsSummary').mockResolvedValue({
    stream_id: 42,
    open_count: 0,
    acknowledged_count: 0,
    resolved_count: 0,
    by_class: { secret: 0, pii: 0, security_metadata: 0 },
    detection_enabled: true,
    confirm_runs_required: 1,
  })
  const sensitiveDetail = vi.spyOn(gdcSensitiveFindings, 'fetchStreamSensitiveFindings').mockResolvedValue({
    stream_id: 42,
    findings: [],
    finding_count: 0,
  })
  const protectionSummary = vi.spyOn(gdcProtection, 'fetchStreamProtectionSummary').mockResolvedValue({
    stream_id: 42,
    protection_enabled: true,
    enabled_rule_count: 0,
    disabled_rule_count: 0,
    full_mask_count: 0,
    partial_mask_count: 0,
    hash_count: 0,
    tokenization_count: 0,
    vault_entry_count: 0,
    by_mode: { full_mask: 0, partial_mask: 0, hash: 0, tokenization: 0 },
    by_class: { secret: 0, pii: 0, security_metadata: 0 },
    total_rules: 0,
    total_protected_events: 0,
    total_protected_fields: 0,
    last_protected_at: null,
    protection_rules: 0,
    protected_events: 0,
    protected_fields: 0,
  })
  const protectionRules = vi.spyOn(gdcProtection, 'fetchStreamProtectionRules').mockResolvedValue({
    stream_id: 42,
    rules: [],
    rule_count: 0,
  })
  const policySummary = vi.spyOn(gdcPolicy, 'fetchStreamPolicySummary').mockResolvedValue({
    stream_id: 42,
    total_policies: 0,
    matched_policies: 0,
    audit_events: 0,
    enabled_policy_count: 0,
    disabled_policy_count: 0,
    last_evaluated_at: null,
  })
  const policyRules = vi.spyOn(gdcPolicy, 'fetchStreamPolicyRules').mockResolvedValue({
    stream_id: 42,
    rules: [],
    rule_count: 0,
  })
  const dynamicSummary = vi.spyOn(gdcDynamicRouting, 'fetchStreamDynamicRoutingSummary').mockResolvedValue({
    stream_id: 42,
    total_dynamic_routes: 0,
    matched_dynamic_routes: 0,
    dynamic_deliveries: 0,
    last_matched_at: null,
  })
  const dynamicRoutes = vi.spyOn(gdcDynamicRouting, 'fetchStreamDynamicRoutes').mockResolvedValue({
    stream_id: 42,
    routes: [],
    route_count: 0,
  })
  const failoverSummary = vi.spyOn(gdcFailoverRouting, 'fetchStreamFailoverRoutingSummary').mockResolvedValue({
    stream_id: 42,
    total_failover_routes: 0,
    failover_attempts: 0,
    failover_successes: 0,
    failover_failures: 0,
    last_failover_at: null,
  })
  const failoverRoutes = vi.spyOn(gdcFailoverRouting, 'fetchStreamFailoverRoutes').mockResolvedValue({
    stream_id: 42,
    routes: [],
    route_count: 0,
  })
  const replaySummary = vi.spyOn(gdcReplay, 'fetchStreamReplaySummary').mockResolvedValue({
    stream_id: 42,
    pending_count: 0,
    replayed_count: 0,
    failed_count: 0,
    discarded_count: 0,
    total_count: 0,
    last_recorded_at: null,
  })
  const replayEvents = vi.spyOn(gdcReplay, 'fetchStreamReplayEvents').mockResolvedValue({
    stream_id: 42,
    events: [],
    event_count: 0,
  })
  const quarantineSummary = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineSummary').mockResolvedValue({
    stream_id: 42,
    quarantined_count: 0,
    released_count: 0,
    discarded_count: 0,
    total_count: 0,
    last_released_at: null,
  })
  const quarantineEvents = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineEvents').mockResolvedValue({
    stream_id: 42,
    events: [],
    event_count: 0,
  })
  const classificationSummary = vi.spyOn(gdcClassification, 'fetchStreamClassificationSummary').mockResolvedValue({
    stream_id: 42,
    public_count: 0,
    internal_count: 0,
    confidential_count: 0,
    restricted_count: 0,
    total_rules: 0,
  })
  const classificationRules = vi.spyOn(gdcClassification, 'fetchStreamClassificationRules').mockResolvedValue({
    stream_id: 42,
    rules: [],
    rule_count: 0,
  })

  return {
    summaries: {
      schemaDrift: schemaDriftSummary,
      sensitive: sensitiveSummary,
      protection: protectionSummary,
      policy: policySummary,
      dynamicRouting: dynamicSummary,
      failover: failoverSummary,
      replay: replaySummary,
      quarantine: quarantineSummary,
    },
    details: {
      schemaDrift: schemaDriftDetail,
      sensitive: sensitiveDetail,
      protectionRules,
      policyRules,
      dynamicRoutes,
      failoverRoutes,
      replayEvents,
      quarantineEvents,
      classificationSummary,
      classificationRules,
    },
  }
}

function summaryTotal(spies: ReturnType<typeof installSpies>['summaries']) {
  return SUMMARY_KEYS.reduce((n, key) => n + spies[key].mock.calls.length, 0)
}

describe('compatibleGovernancePreload', () => {
  it('accepts matching stream_id and rejects mismatches', () => {
    expect(compatibleGovernancePreload(42, { stream_id: 42, quarantined_count: 1 } as never)).toEqual({
      stream_id: 42,
      quarantined_count: 1,
    })
    expect(compatibleGovernancePreload(42, { stream_id: 99, quarantined_count: 1 } as never)).toBeUndefined()
    expect(compatibleGovernancePreload(42, null)).toBeUndefined()
    expect(compatibleGovernancePreload(42, undefined)).toBeUndefined()
  })
})

describe('governance drawer page snapshot preload (request-count regression)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.setItem('gdc-platform-persona', 'governance')
    persistStreamRuntimeMetricsAutoRefresh(false)
    persistRuntimeRefreshEvery('off')
    mockFetchStreamById.mockImplementation(async (id: number) => ({
      id,
      name: `Stream ${id}`,
      stream_type: 'HTTP_API_POLLING',
      connector_id: 1,
    }))
  })

  it('skips duplicate summary GETs on drawer first open and reopen; preserves detail GETs', async () => {
    const spies = installSpies()
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/streams/42/runtime']}>
        <Routes>
          <Route path="/streams/:streamId/runtime" element={<StreamRuntimeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(summaryTotal(spies.summaries)).toBe(8)
    })
    const pageInitial = summaryTotal(spies.summaries)

    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    await user.click(screen.getByTitle('Open Governance drawer'))
    await waitFor(() => {
      expect(screen.getByTestId('schema-drift-panel')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(spies.details.schemaDrift).toHaveBeenCalled()
      expect(spies.details.quarantineEvents).toHaveBeenCalled()
      expect(spies.details.classificationSummary).toHaveBeenCalled()
    })

    expect(summaryTotal(spies.summaries)).toBe(pageInitial)
    for (const key of SUMMARY_KEYS) {
      expect(spies.summaries[key].mock.calls.length, key).toBe(1)
    }

    // Classification is not in page snapshot — must still load.
    expect(spies.details.classificationSummary.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(spies.details.classificationRules.mock.calls.length).toBeGreaterThanOrEqual(1)

    const detailAfterOpen =
      spies.details.schemaDrift.mock.calls.length +
      spies.details.sensitive.mock.calls.length +
      spies.details.protectionRules.mock.calls.length +
      spies.details.policyRules.mock.calls.length +
      spies.details.dynamicRoutes.mock.calls.length +
      spies.details.failoverRoutes.mock.calls.length +
      spies.details.replayEvents.mock.calls.length +
      spies.details.quarantineEvents.mock.calls.length
    expect(detailAfterOpen).toBeGreaterThanOrEqual(9)

    await user.click(screen.getByLabelText('Collapse Governance drawer'))
    expect(screen.queryByTestId('schema-drift-panel')).not.toBeInTheDocument()

    const summaryBeforeReopen = summaryTotal(spies.summaries)
    await user.click(screen.getByTitle('Open Governance drawer'))
    await waitFor(() => {
      expect(screen.getByTestId('schema-drift-panel')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(spies.details.schemaDrift.mock.calls.length).toBeGreaterThan(1)
    })
    expect(summaryTotal(spies.summaries)).toBe(summaryBeforeReopen)
  })

  it('refetches governance summaries after panel mutation invalidation', async () => {
    const spies = installSpies()
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/streams/42/runtime']}>
        <Routes>
          <Route path="/streams/:streamId/runtime" element={<StreamRuntimeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(summaryTotal(spies.summaries)).toBe(8)
    })
    await user.click(await screen.findByTestId('stream-detail-tab-audit'))
    await user.click(screen.getByTitle('Open Governance drawer'))
    await waitFor(() => {
      expect(screen.getByTestId('quarantine-panel')).toBeInTheDocument()
    })

    const beforeMutation = summaryTotal(spies.summaries)
    notifyStreamGovernanceChanged(42)
    await waitFor(() => {
      expect(summaryTotal(spies.summaries)).toBe(beforeMutation + 8)
    })
  })
})

describe('panel initialSummary preload behavior', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('QuarantinePanel uses preload summary and only fetches events', async () => {
    const summarySpy = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineSummary')
    const eventsSpy = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineEvents').mockResolvedValue({
      stream_id: 10,
      events: [],
      event_count: 0,
    })
    render(
      <QuarantinePanel
        streamId={10}
        canOperate={false}
        initialSummary={{
          stream_id: 10,
          quarantined_count: 2,
          released_count: 1,
          discarded_count: 0,
          total_count: 3,
          last_released_at: null,
        }}
      />,
    )
    expect(await screen.findByText('2')).toBeInTheDocument()
    await waitFor(() => {
      expect(eventsSpy).toHaveBeenCalled()
    })
    expect(summarySpy).not.toHaveBeenCalled()
  })

  it('QuarantinePanel without preload keeps standalone summary fetch', async () => {
    const summarySpy = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineSummary').mockResolvedValue({
      stream_id: 10,
      quarantined_count: 1,
      released_count: 0,
      discarded_count: 0,
      total_count: 1,
      last_released_at: null,
    })
    vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineEvents').mockResolvedValue({
      stream_id: 10,
      events: [],
      event_count: 0,
    })
    render(<QuarantinePanel streamId={10} canOperate={false} />)
    await waitFor(() => {
      expect(summarySpy).toHaveBeenCalledTimes(1)
    })
  })

  it('rejects preload from a different stream_id', async () => {
    const summarySpy = vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineSummary').mockResolvedValue({
      stream_id: 10,
      quarantined_count: 0,
      released_count: 0,
      discarded_count: 0,
      total_count: 0,
      last_released_at: null,
    })
    vi.spyOn(gdcQuarantine, 'fetchStreamQuarantineEvents').mockResolvedValue({
      stream_id: 10,
      events: [],
      event_count: 0,
    })
    render(
      <QuarantinePanel
        streamId={10}
        canOperate={false}
        initialSummary={{
          stream_id: 99,
          quarantined_count: 9,
          released_count: 0,
          discarded_count: 0,
          total_count: 9,
          last_released_at: null,
        }}
      />,
    )
    await waitFor(() => {
      expect(summarySpy).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByText('9')).not.toBeInTheDocument()
  })

  it('ReplayPanel and SchemaDriftPanel skip summary when preloaded', async () => {
    const replaySummary = vi.spyOn(gdcReplay, 'fetchStreamReplaySummary')
    vi.spyOn(gdcReplay, 'fetchStreamReplayEvents').mockResolvedValue({
      stream_id: 42,
      events: [],
      event_count: 0,
    })
    render(
      <ReplayPanel
        streamId={42}
        canOperate={false}
        initialSummary={{
          stream_id: 42,
          pending_count: 3,
          replayed_count: 0,
          failed_count: 0,
          discarded_count: 0,
          total_count: 3,
          last_recorded_at: null,
        }}
      />,
    )
    expect(await screen.findByText('3')).toBeInTheDocument()
    expect(replaySummary).not.toHaveBeenCalled()

    const driftSummary = vi.spyOn(gdcSchemaDrift, 'fetchStreamSchemaFieldDriftsSummary')
    vi.spyOn(gdcSchemaDrift, 'fetchStreamSchemaFieldDrifts').mockResolvedValue({
      stream_id: 42,
      findings: [],
      finding_count: 0,
    })
    render(
      <SchemaDriftPanel
        streamId={42}
        canOperate={false}
        initialSummary={{
          stream_id: 42,
          open_count: 4,
          acknowledged_count: 0,
          resolved_count: 0,
          by_category: { field_added: 4, field_removed: 0, field_type_changed: 0 },
          baseline_version: 2,
          baseline_established_at: null,
          baseline_reset_at: null,
          drift_detection_enabled: true,
        }}
      />,
    )
    expect(await screen.findByText('4')).toBeInTheDocument()
    expect(driftSummary).not.toHaveBeenCalled()
  })
})
