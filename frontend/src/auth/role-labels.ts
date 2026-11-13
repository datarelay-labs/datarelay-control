import type { SessionRole } from './session'

/** Display the authenticated role accurately; labels never authorize actions. */
const SESSION_ROLE_LABELS: Readonly<Record<SessionRole, string>> = {
  ADMINISTRATOR: 'Administrator',
  OPERATOR: 'Operator',
  CONNECTOR_OPERATOR: 'Connector Operator',
  GOVERNANCE_OPERATOR: 'Governance Operator',
  GOVERNANCE_REVIEWER: 'Governance Reviewer',
  GOVERNANCE_APPROVER: 'Governance Approver',
  GOVERNANCE_AUDITOR: 'Governance Auditor',
  VIEWER: 'Viewer',
}

export function sessionRoleLabel(role: SessionRole | string | null | undefined): string {
  if (role == null) return 'Unknown session'
  return Object.prototype.hasOwnProperty.call(SESSION_ROLE_LABELS, role)
    ? SESSION_ROLE_LABELS[role as SessionRole]
    : 'Unknown role'
}

/**
 * Role choices offered when creating or editing a user. OPERATOR is the legacy role name and shares
 * its access with CONNECTOR_OPERATOR, so the two options must stay distinguishable (F-017).
 */
export const USER_ROLE_OPTIONS: ReadonlyArray<{ value: SessionRole; label: string }> = [
  { value: 'VIEWER', label: SESSION_ROLE_LABELS.VIEWER },
  { value: 'OPERATOR', label: `${SESSION_ROLE_LABELS.OPERATOR} (legacy)` },
  { value: 'CONNECTOR_OPERATOR', label: SESSION_ROLE_LABELS.CONNECTOR_OPERATOR },
  { value: 'GOVERNANCE_OPERATOR', label: SESSION_ROLE_LABELS.GOVERNANCE_OPERATOR },
  { value: 'GOVERNANCE_REVIEWER', label: SESSION_ROLE_LABELS.GOVERNANCE_REVIEWER },
  { value: 'GOVERNANCE_APPROVER', label: SESSION_ROLE_LABELS.GOVERNANCE_APPROVER },
  { value: 'GOVERNANCE_AUDITOR', label: SESSION_ROLE_LABELS.GOVERNANCE_AUDITOR },
  { value: 'ADMINISTRATOR', label: SESSION_ROLE_LABELS.ADMINISTRATOR },
]
