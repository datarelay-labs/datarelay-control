import { describe, expect, it } from 'vitest'
import { groupRowsBySourceProduct, resolveSourceProductLabel, worstStreamStatus } from './source-product-group'

describe('source-product-group', () => {
  it('prefers connector.product_group over name heuristic', () => {
    expect(resolveSourceProductLabel('CrowdStrike Falcon API', { product_group: 'Custom Group' })).toBe('Custom Group')
  })

  it('maps connector names to product labels when product_group absent', () => {
    expect(resolveSourceProductLabel('CrowdStrike Falcon API')).toBe('CrowdStrike')
    expect(resolveSourceProductLabel('Okta System Log')).toBe('Okta')
    expect(resolveSourceProductLabel('')).toBe('Other sources')
  })

  it('groups rows by product_group metadata and computes worst status', () => {
    const groups = groupRowsBySourceProduct([
      { connectorName: 'misc', connectorProductGroup: 'Okta', status: 'RUNNING' },
      { connectorName: 'other', connectorProductGroup: 'Okta', status: 'ERROR' },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].productLabel).toBe('Okta')
    expect(groups[0].issueCount).toBe(1)
    expect(worstStreamStatus(['RUNNING', 'ERROR'])).toBe('ERROR')
  })

  it('never lets a RUNNING member hide an UNKNOWN one, and UNKNOWN never masks DEGRADED/ERROR (scenario 12)', () => {
    expect(worstStreamStatus(['RUNNING', 'UNKNOWN'])).toBe('UNKNOWN')
    expect(worstStreamStatus(['UNKNOWN', 'RUNNING'])).toBe('UNKNOWN')
    expect(worstStreamStatus(['UNKNOWN', 'DEGRADED'])).toBe('DEGRADED')
    expect(worstStreamStatus(['UNKNOWN', 'ERROR'])).toBe('ERROR')
  })
})
