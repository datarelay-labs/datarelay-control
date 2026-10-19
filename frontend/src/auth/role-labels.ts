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
