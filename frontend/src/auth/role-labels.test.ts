import { describe, expect, it } from 'vitest'
import { USER_ROLE_OPTIONS, sessionRoleLabel } from './role-labels'

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

  it('offers every role exactly once with a distinguishable user-form label (F-017)', () => {
    const labels = USER_ROLE_OPTIONS.map((option) => option.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(new Set(USER_ROLE_OPTIONS.map((option) => option.value)).size).toBe(USER_ROLE_OPTIONS.length)
    expect(USER_ROLE_OPTIONS.find((option) => option.value === 'OPERATOR')?.label).toBe('Operator (legacy)')
    expect(USER_ROLE_OPTIONS.find((option) => option.value === 'CONNECTOR_OPERATOR')?.label).toBe('Connector Operator')
  })
})
