import { clearFrontendDataCaches } from '../lib/clear-frontend-data-caches'

/**
 * Local JWT session storage for the platform SPA (spec 020).
 *
 * The platform issues access + refresh JWTs at `/auth/login`.  The SPA stores
 * them in `localStorage` under `gdc_platform_session_v1` and replays the
 * access token via `Authorization: Bearer <jwt>` on every API request.  When
 * a request comes back with `401`, callers should attempt one `/auth/refresh`
 * round-trip and, on failure, call {@link clearSession} which redirects to
 * the login screen.
 *
 * All access is wrapped in try/catch so a missing/SSR/legacy environment
 * cannot crash the app.
 */

export type SessionRole =
  | 'ADMINISTRATOR'
  | 'OPERATOR'
  | 'CONNECTOR_OPERATOR'
  | 'GOVERNANCE_OPERATOR'
  | 'GOVERNANCE_REVIEWER'
  | 'GOVERNANCE_APPROVER'
  | 'GOVERNANCE_AUDITOR'
  | 'VIEWER'

export type SessionUser = {
  username: string
  role: SessionRole
  status: string
  /** When true, the SPA must block main navigation until password is changed. */
  must_change_password?: boolean
  /** Populated by the auth API; older cached sessions may omit this. */
  capabilities?: Record<string, boolean>
  /** IANA timezone override for timestamp display. */
  timezone?: string | null
}

export type StoredSession = {
  access_token: string
  refresh_token: string
  expires_at: string
  user: SessionUser
}

const STORAGE_KEY = 'gdc_platform_session_v1'
// Legacy keys from the spec 019 X-GDC-Role flow.  We clear them on logout so
// old role hints cannot accidentally re-grant access if the SPA bundle is
// downgraded.
const LEGACY_ROLE_KEY = 'gdc_platform_ui_role'
const LEGACY_USERNAME_KEY = 'gdc_platform_ui_username'

const SESSION_EVENT = 'gdc:session-changed'

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function isSessionRole(value: unknown): value is SessionRole {
  return (
    value === 'ADMINISTRATOR' ||
    value === 'OPERATOR' ||
    value === 'CONNECTOR_OPERATOR' ||
    value === 'GOVERNANCE_OPERATOR' ||
    value === 'GOVERNANCE_REVIEWER' ||
    value === 'GOVERNANCE_APPROVER' ||
    value === 'GOVERNANCE_AUDITOR' ||
    value === 'VIEWER'
  )
}

function notifyChanged(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SESSION_EVENT))
    }
  } catch {
    /* ignore — purely advisory */
  }
}

/** Read the persisted session, returning null when missing or malformed. */
export function readSession(): StoredSession | null {
  const store = safeStorage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw) as Partial<StoredSession> | null
    if (
      !obj ||
      typeof obj.access_token !== 'string' ||
      typeof obj.refresh_token !== 'string' ||
      typeof obj.expires_at !== 'string' ||
      !obj.user ||
      typeof obj.user.username !== 'string' ||
      !isSessionRole(obj.user.role)
    ) {
      return null
    }
    const caps =
      obj.user.capabilities && typeof obj.user.capabilities === 'object' && !Array.isArray(obj.user.capabilities)
        ? (obj.user.capabilities as Record<string, boolean>)
        : undefined
    const mustChange = obj.user.must_change_password === true
    return {
      access_token: obj.access_token,
      refresh_token: obj.refresh_token,
      expires_at: obj.expires_at,
      user: {
        username: obj.user.username,
        role: obj.user.role,
        status: typeof obj.user.status === 'string' ? obj.user.status : 'ACTIVE',
        ...(mustChange ? { must_change_password: true } : {}),
        ...(caps ? { capabilities: caps } : {}),
      },
    }
  } catch {
    return null
  }
}

export function persistSession(s: StoredSession): void {
  const store = safeStorage()
  if (!store) return
  try {
    const previous = readSession()
    if (
      previous &&
      (previous.user.username !== s.user.username || previous.user.role !== s.user.role)
    ) {
      // A direct account/role switch can happen without a full page reload.
      // Never let the new identity inherit admin-only UI snapshots.
      clearFrontendDataCaches()
    }
    store.setItem(STORAGE_KEY, JSON.stringify(s))
    // Keep the legacy keys in sync so any not-yet-migrated UI logic that still
    // reads `gdc_platform_ui_role` continues to render correctly (read-only).
    store.setItem(LEGACY_ROLE_KEY, s.user.role)
    store.setItem(LEGACY_USERNAME_KEY, s.user.username)
  } catch {
    /* quota / permissions */
  }
  notifyChanged()
}

export function clearSession(): void {
  const store = safeStorage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
    store.removeItem(LEGACY_ROLE_KEY)
    store.removeItem(LEGACY_USERNAME_KEY)
  } catch {
    /* ignore */
  }
  try {
    clearFrontendDataCaches()
  } catch {
    /* ignore cache clear failures during sign-out */
  }
  notifyChanged()
}

export function getAccessToken(): string | null {
  const s = readSession()
  if (!s) return null
  return s.access_token
}

export function getRefreshToken(): string | null {
  return readSession()?.refresh_token ?? null
}

export function getSessionRole(): SessionRole | null {
  return readSession()?.user.role ?? null
}

export function getSessionUsername(): string | null {
  return readSession()?.user.username ?? null
}

/** True when the persisted access token has passed its server-issued expiry. */
export function isSessionExpired(): boolean {
  const s = readSession()
  if (!s) return true
  const exp = Date.parse(s.expires_at)
  if (Number.isNaN(exp)) return true
  return exp <= Date.now()
}

export function onSessionChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const fn = () => handler()
  window.addEventListener(SESSION_EVENT, fn)
  return () => window.removeEventListener(SESSION_EVENT, fn)
}

export const SESSION_STORAGE_KEY = STORAGE_KEY
