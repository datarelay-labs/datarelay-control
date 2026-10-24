import { describe, expect, it } from 'vitest'
import { sessionRoleLabel } from './role-labels'

describe('canonical platform role labels', () => {
  it.each([
    ['ADMINISTRATOR', 'Administrator'],
    ['OPERATOR', 'Operator'],
    ['CONNECTOR_OPERATOR', 'Connector Operator'],
    ['GOVERNANCE_OPERATOR', 'Governance Operator'],
    ['GOVERNANCE_REVIEWER', 'Governance Reviewer'],
    ['GOVERNANCE_APPROVER', 'Governance Approver'],
    ['GOVERNANCE_AUDITOR', 'Governance Auditor'],
    ['VIEWER', 'Viewer'],
  ] as const)('labels %s accurately', (role, expected) => {
    expect(sessionRoleLabel(role)).toBe(expected)
  })

  it('never presents missing or unrecognized roles as a Viewer', () => {
    expect(sessionRoleLabel(null)).toBe('Unknown session')
    expect(sessionRoleLabel('UNRECOGNIZED')).toBe('Unknown role')
  })
})
