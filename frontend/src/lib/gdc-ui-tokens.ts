/**
 * GDC dark theme surface tokens (shell, admin, modals).
 * Hierarchy: page (L0) < panel/section (L1) < card (L2) < elevated (L3).
 * Dark surfaces use Cloudflare-like neutral off-black/gray layers — no navy glow.
 */
export const gdcUi = {
  cardShell:
    'rounded-lg border border-slate-200/90 bg-white shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card',
  innerWell:
    'rounded-lg border border-slate-100 bg-slate-50/40 dark:border-gdc-divider dark:bg-gdc-section dark:shadow-gdc-control',
  input:
    'rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-gdc-foreground dark:shadow-gdc-control dark:placeholder:text-gdc-placeholder dark:focus:border-gdc-primary dark:focus:ring-gdc-primary/45',
  select:
    'rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30 dark:border-gdc-inputBorder dark:bg-gdc-input dark:text-gdc-foreground dark:shadow-gdc-control dark:focus:border-gdc-primary dark:focus:ring-gdc-primary/45',
  modalPanel:
    'w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:shadow-gdc-elevated',
  primaryBtn: 'rounded-lg bg-gdc-primary px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gdc-card',
  secondaryBtn:
    'rounded-lg border border-slate-300 bg-white px-3 py-2 text-[12px] font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:border-gdc-borderStrong dark:bg-gdc-card dark:text-gdc-foreground dark:shadow-gdc-control dark:hover:bg-gdc-cardHover',
  textMuted: 'text-slate-600 dark:text-gdc-muted',
  textTitle: 'text-slate-900 dark:text-gdc-foreground',
  formLabel: 'text-xs font-semibold text-slate-600 dark:text-gdc-mutedStrong',
  /** Empty / zero-data panels */
  emptyPanel:
    'rounded-lg border border-dashed border-slate-200/90 bg-slate-50/60 px-5 py-8 text-center dark:border-gdc-border dark:bg-gdc-section',
} as const

/**
 * Effective role for the UI session.
 *
 * After spec 020 the source of truth is the JWT in `gdc_platform_session_v1`.
 * The legacy `gdc_platform_ui_role` localStorage key is consulted only as a
 * fallback for transient renders / older bundles — the server enforces role
 * via the bearer token regardless of what the UI displays.
 */
import { getSessionRole, getSessionUsername, clearSession, type SessionRole } from '../auth/session'

export function readAdminUiRole(): SessionRole | null {
  const fromSession = getSessionRole()
  if (fromSession) return fromSession
  try {
    const v = globalThis.localStorage?.getItem('gdc_platform_ui_role')?.trim().toUpperCase()
    if (v === 'VIEWER' || v === 'OPERATOR' || v === 'ADMINISTRATOR' || v === 'CONNECTOR_OPERATOR') return v as SessionRole
  } catch {
    /* ignore */
  }
  return null
}

export function readAdminUiUsername(): string | null {
  return getSessionUsername()
}

/** Kept for legacy callers; the JWT session is the real source of truth. */
export function persistAdminUiRole(role: 'ADMINISTRATOR' | 'OPERATOR' | 'VIEWER' | null, username?: string): void {
  try {
    if (role) {
      globalThis.localStorage?.setItem('gdc_platform_ui_role', role)
    } else {
      globalThis.localStorage?.removeItem('gdc_platform_ui_role')
    }
    if (username) {
      globalThis.localStorage?.setItem('gdc_platform_ui_username', username)
    }
  } catch {
    /* ignore */
  }
}

export function clearAdminUiSession(): void {
  clearSession()
}

export function isAdminUiReadOnly(): boolean {
  return readAdminUiRole() === 'VIEWER'
}

export function isAdminUiOperator(): boolean {
  return readAdminUiRole() === 'OPERATOR'
}
