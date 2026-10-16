import { describe, expect, it } from 'vitest'
import {
  GOVERNANCE_LOG_DRILLDOWN_STAGES,
  governanceOutcomePresentation,
  rowMatchesStageFilter,
} from './delivery-log-stages'
import type { LogExplorerRow } from './logs-types'

function rowWithStage(stage: string): LogExplorerRow {
  return {
    id: '1',
    eventId: 'evt_1',
    timeIso: '2026-06-05T10:00:00Z',
    level: 'INFO',
    connector: 'c1',
    stream: 's1',
    route: 'r1',
    message: 'ok',
    durationMs: 0,
    contextJson: { stage },
    relatedEventId: null,
  }
}

describe('delivery-log-stages', () => {
  it('exports governance drill-down tokens used in URLs', () => {
    expect(GOVERNANCE_LOG_DRILLDOWN_STAGES.classification).toBe('classification_complete')
    expect(GOVERNANCE_LOG_DRILLDOWN_STAGES.protection).toBe('protection_complete')
    expect(GOVERNANCE_LOG_DRILLDOWN_STAGES.policy).toBe('policy_evaluation_complete')
  })

  it('does not client-filter out rows when API stage filter is active', () => {
    const row = rowWithStage('classification_complete')
    expect(rowMatchesStageFilter(row, 'classification_complete', 'classification_complete')).toBe(true)
  })

  it('matches pipeline category labels when no API stage filter', () => {
    const row = rowWithStage('mapping')
    expect(rowMatchesStageFilter(row, 'MAPPING', undefined)).toBe(true)
    expect(rowMatchesStageFilter(row, 'DELIVERY', undefined)).toBe(false)
  })

  it('classifies policy dispositions as governance outcomes instead of delivery failures', () => {
    expect(governanceOutcomePresentation('policy_blocked')).toMatchObject({
      kind: 'workspace',
      label: 'Review blocked policy decision',
    })
    expect(governanceOutcomePresentation('policy_blocked')?.summary).toMatch(/not a receiver delivery failure/i)
    expect(governanceOutcomePresentation('policy_review_required')).toMatchObject({
      kind: 'workspace',
      label: 'Review required in Governance',
    })
    expect(governanceOutcomePresentation('policy_quarantine')).toMatchObject({
      kind: 'quarantine',
      label: 'Open Quarantine',
    })
    expect(governanceOutcomePresentation('route_send_failed')).toBeNull()
  })
})
