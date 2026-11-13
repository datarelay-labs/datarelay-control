/**
 * Governance RBAC helpers (M20) — mirrors server rules in `app/auth/governance_rbac.py`.
 * Prefer `user.capabilities` from login / whoami when present.
 */

import { useEffect, useState } from 'react'

import { getSessionRole, onSessionChange, readSession, type SessionRole } from '../auth/session'

export type GovernanceRole =
  | 'ADMINISTRATOR'
  | 'OPERATOR'
  | 'CONNECTOR_OPERATOR'
  | 'GOVERNANCE_OPERATOR'
  | 'GOVERNANCE_REVIEWER'
  | 'GOVERNANCE_APPROVER'
  | 'GOVERNANCE_AUDITOR'
  | 'VIEWER'

function normalizeRole(role: SessionRole | GovernanceRole | null | undefined): GovernanceRole | null {
  if (role == null) return null
  if (role === 'OPERATOR') return 'CONNECTOR_OPERATOR'
  return role as GovernanceRole
}

function isAdministrator(role: GovernanceRole | null): boolean {
  return role === 'ADMINISTRATOR'
}

export function deriveGovernanceCapsFromRole(role: SessionRole | GovernanceRole | null): Record<string, boolean> {
  const normalized = normalizeRole(role)
  if (normalized == null) {
    return deriveGovernanceCapsFromRole('ADMINISTRATOR')
  }
  const isAdmin = isAdministrator(normalized)
  const isConnector = normalized === 'CONNECTOR_OPERATOR'
  const isGovOp = normalized === 'GOVERNANCE_OPERATOR'
  const isReviewer = normalized === 'GOVERNANCE_REVIEWER'
  const isApprover = normalized === 'GOVERNANCE_APPROVER'
  const isAuditor = normalized === 'GOVERNANCE_AUDITOR'
  const govRead = isAdmin || isConnector || isGovOp || isReviewer || isApprover || isAuditor
  const govDashboard = isAdmin || isConnector || isGovOp || isReviewer || isApprover || isAuditor || normalized === 'VIEWER'
  const govOperations = isAdmin || isGovOp || isReviewer || isApprover
  return {
    governance_read: govRead,
    governance_dashboard_read: govDashboard,
    governance_operations_access: govOperations,
    governance_mutations: isAdmin || isGovOp,
    governance_policy_submit: isAdmin || isGovOp,
    governance_policy_review: isAdmin || isReviewer || isApprover,
    governance_policy_approve: isAdmin || isReviewer || isApprover,
    governance_policy_activate: isAdmin || isApprover,
    governance_quarantine_action: isAdmin || isGovOp,
    governance_replay_action: isAdmin || isGovOp,
    governance_audit_read: isAdmin || isGovOp || isReviewer || isApprover || isAuditor,
  }
}

function pickGovernanceCaps(caps: Record<string, boolean>): Record<string, boolean> {
  const keys = [
    'governance_read',
    'governance_dashboard_read',
    'governance_operations_access',
    'governance_mutations',
    'governance_policy_submit',
    'governance_policy_review',
    'governance_policy_approve',
    'governance_policy_activate',
    'governance_quarantine_action',
    'governance_replay_action',
    'governance_audit_read',
  ] as const
  const out: Record<string, boolean> = {}
  for (const k of keys) {
    if (typeof caps[k] === 'boolean') out[k] = caps[k]
  }
  return out
}

export function getGovernanceCapabilities(): Record<string, boolean> {
  const session = readSession()
  const role = normalizeRole(session?.user.role ?? null)
  const derived = deriveGovernanceCapsFromRole(role)
  const fromServer = session?.user.capabilities
  if (fromServer && typeof fromServer === 'object') {
    return { ...derived, ...pickGovernanceCaps(fromServer) }
  }
  return derived
}

export function useGovernanceCapabilities(): Record<string, boolean> {
  const [caps, setCaps] = useState(() => getGovernanceCapabilities())
  useEffect(() => {
    return onSessionChange(() => setCaps(getGovernanceCapabilities()))
  }, [])
  return caps
}

export function canViewGovernance(): boolean {
  return getGovernanceCapabilities().governance_dashboard_read === true
}

export function canViewGovernanceWorkspace(): boolean {
  return getGovernanceCapabilities().governance_read === true
}

export function canViewGovernanceOperations(): boolean {
  return getGovernanceCapabilities().governance_operations_access === true
}

export function canEditPolicy(): boolean {
  return getGovernanceCapabilities().governance_mutations === true
}

export function canSubmitApproval(): boolean {
  return getGovernanceCapabilities().governance_policy_submit === true
}

export function canReviewApproval(): boolean {
  return getGovernanceCapabilities().governance_policy_review === true
}

export function canApprovePolicy(): boolean {
  return getGovernanceCapabilities().governance_policy_approve === true
}

export function canActivatePolicy(): boolean {
  return getGovernanceCapabilities().governance_policy_activate === true
}

export function canReleaseQuarantine(): boolean {
  return getGovernanceCapabilities().governance_quarantine_action === true
}

export function canDiscardQuarantine(): boolean {
  return getGovernanceCapabilities().governance_quarantine_action === true
}

export function canExecuteReplay(): boolean {
  return getGovernanceCapabilities().governance_replay_action === true
}

export function canViewAudit(): boolean {
  return getGovernanceCapabilities().governance_audit_read === true
}

const ROLE_LABELS: Record<GovernanceRole, string> = {
  ADMINISTRATOR: 'Administrator',
  OPERATOR: 'Connector Operator',
  CONNECTOR_OPERATOR: 'Connector Operator',
  GOVERNANCE_OPERATOR: 'Governance Operator',
  GOVERNANCE_REVIEWER: 'Governance Reviewer',
  GOVERNANCE_APPROVER: 'Governance Approver',
  GOVERNANCE_AUDITOR: 'Governance Auditor',
  VIEWER: 'Viewer',
}

/** True for the four Governance-only roles; the backend refuses every non-Governance mutation for them. */
export function isGovernanceOnlyRole(): boolean {
  const role = getSessionRole()
  return role != null && role.startsWith('GOVERNANCE_')
}

export function governanceRoleLabel(): string | null {
  const role = getSessionRole() as GovernanceRole | null
  return role == null ? null : (ROLE_LABELS[role] ?? role)
}

/**
 * F-196: a 403 must read as "your role lacks access", not as an outage. Returns the access message when the
 * session capability map says the role cannot read this Governance area, otherwise null (caller keeps its
 * generic unavailable message).
 */
export function governanceAccessDeniedMessage(
  subject: string,
  capability: 'governance_read' | 'governance_audit_read' | 'governance_operations_access' = 'governance_read',
): string | null {
  if (getGovernanceCapabilities()[capability] !== false) return null
  const role = governanceRoleLabel()
  return `${role ? `The ${role} role` : 'Your role'} does not have access to ${subject}. Ask an Administrator if you need it.`
}

export function governanceReadOnlyReason(): string | null {
  const role = normalizeRole(getSessionRole())
  if (role == null) return null
  if (canEditPolicy()) return null
  if (role === 'CONNECTOR_OPERATOR') {
    return 'Governance write actions require Governance Operator role. Connector Operators can view Governance but cannot change it.'
  }
  if (role === 'GOVERNANCE_AUDITOR') {
    return 'Governance Auditor role is read-only for all write actions.'
  }
  if (role === 'GOVERNANCE_REVIEWER') {
    return 'Governance Reviewer can review approvals but cannot edit policies or activate.'
  }
  if (role === 'GOVERNANCE_APPROVER') {
    return 'Governance Approver can approve and activate policies but cannot edit drafts.'
  }
  if (role === 'VIEWER') {
    return 'Viewer role has read-only access to the Governance Dashboard.'
  }
  return 'You do not have permission to modify Governance resources.'
}

export function persistTestSession(role: GovernanceRole, username = 'test-user'): void {
  const caps = deriveGovernanceCapsFromRole(role)
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    user: {
      username,
      role: role === 'CONNECTOR_OPERATOR' ? 'OPERATOR' : role,
      status: 'ACTIVE',
      capabilities: caps,
    },
  }
  localStorage.setItem('gdc_platform_session_v1', JSON.stringify(session))
  window.dispatchEvent(new CustomEvent('gdc:session-changed'))
}

export function clearTestSession(): void {
  localStorage.removeItem('gdc_platform_session_v1')
  window.dispatchEvent(new CustomEvent('gdc:session-changed'))
}
