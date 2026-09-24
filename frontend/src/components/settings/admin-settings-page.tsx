import {
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  HardDrive,
  Info,
  Lock,
  Package,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  createAdminUser,
  deleteAdminUser,
  downloadAdminSupportBundle,
  getAdminHttpsSettings,
  getAdminSystemInfo,
  getAuthWhoAmI,
  listAdminUsers,
  postAdminPasswordChange,
  putAdminHttpsSettings,
  updateAdminUser,
  type HttpsSettingsDto,
  type PlatformUserDto,
  type SystemInfoDto,
} from '../../api/gdcAdmin'
import { NAV_PATH } from '../../config/nav-paths'
import { formatTimestampWithResolvedTimezone } from '../../lib/platform-timestamps'
import { isDevValidationLabUiEnabled } from '../../lib/feature-flags'
import { gdcUi, isAdminUiReadOnly, readAdminUiRole } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { AdminDevValidationPanel } from './admin-dev-validation-panel'
import { AdminDisplayTimezoneSettings } from './admin-display-timezone-settings'
import { AdminMaintenanceCenter } from './admin-maintenance-center'
import { AdminNetworkSettingsPage } from './admin-network-settings-page'
import { AdminRetentionSettings } from './admin-retention-settings'
import { AdminOperationalDashboard } from './admin-settings-operational'
import { passwordsMatch, validateNewPassword } from './admin-settings-validation'
import {
  httpsDraftFromSettings,
  readAdminSettingsSnapshot,
  writeAdminSettingsSnapshot,
} from './admin-settings-session-cache'

const VALID_DAY_OPTIONS = [30, 90, 180, 365, 730] as const

const SETTINGS_SECTION_JUMPS = [
  { href: '#admin-https-heading', label: 'HTTPS', group: 'Access & security' },
  { href: '#admin-password-heading', label: 'Password', group: 'Access & security' },
  { href: '#admin-users-heading', label: 'Users', group: 'Access & security' },
  { href: '#admin-display-timezone-heading', label: 'Timezone', group: 'Platform & network' },
  { href: '#admin-network-heading', label: 'Network', group: 'Platform & network' },
  { href: '#admin-retention-heading', label: 'Retention', group: 'Lifecycle & recovery' },
  { href: '/operations/backup', label: 'Backup', group: 'Lifecycle & recovery' },
  { href: '#admin-health-heading', label: 'System Health', group: 'Operations & audit' },
] as const

function validDaySelectOptions(current: number): number[] {
  const s = new Set<number>([...VALID_DAY_OPTIONS, current])
  return [...s].sort((a, b) => a - b)
}

function roleBadgeClass(role: string) {
  if (role === 'ADMINISTRATOR') {
    return 'border-violet-500/25 bg-violet-500/[0.08] text-violet-800 dark:border-violet-500/35 dark:bg-violet-500/12 dark:text-violet-100/90'
  }
  if (role === 'OPERATOR') {
    return 'border-sky-500/25 bg-sky-500/[0.08] text-sky-900 dark:border-sky-500/35 dark:bg-sky-500/12 dark:text-sky-100/90'
  }
  return 'border-slate-300/80 bg-slate-100 text-slate-700 dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:text-slate-200'
}

function roleLabel(role: string) {
  if (role === 'ADMINISTRATOR') return 'Administrator'
  if (role === 'OPERATOR') return 'Operator'
  return 'Viewer'
}

function formatTs(iso: string | null) {
  if (!iso) return '—'
  return formatTimestampWithResolvedTimezone(iso)
}

function formatUptimeSeconds(sec: number | null | undefined) {
  if (sec == null || Number.isNaN(sec)) return '—'
  const s = Math.max(0, Math.floor(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

type UserFormState = { username: string; password: string; role: string; status: string }

export function AdminSettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const sessionSnapshot = readAdminSettingsSnapshot()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [https, setHttps] = useState<HttpsSettingsDto | null>(() => sessionSnapshot?.https ?? null)
  const [httpsDraft, setHttpsDraft] = useState<{
    enabled: boolean
    certificate_ip_addresses: string
    certificate_dns_names: string
    redirect_http_to_https: boolean
    certificate_valid_days: number
    regenerate_certificate: boolean
  } | null>(() => sessionSnapshot?.httpsDraft ?? null)
  const [users, setUsers] = useState<PlatformUserDto[]>(() => sessionSnapshot?.users ?? [])
  const [pageMsg, setPageMsg] = useState<string | null>(null)
  const [pageErr, setPageErr] = useState<string | null>(null)

  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwUser, setPwUser] = useState('admin')
  const [showPw, setShowPw] = useState(false)

  const [userModal, setUserModal] = useState<'create' | 'edit' | null>(null)
  const [editingUser, setEditingUser] = useState<PlatformUserDto | null>(null)
  const [userForm, setUserForm] = useState<UserFormState>({ username: '', password: '', role: 'VIEWER', status: 'ACTIVE' })

  const [systemOpen, setSystemOpen] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfoDto | null>(null)
  const [systemFooter, setSystemFooter] = useState<SystemInfoDto | null>(() => sessionSnapshot?.systemFooter ?? null)
  const [opReload, setOpReload] = useState(0)
  const [backendRole, setBackendRole] = useState<import('../../auth/session').SessionRole | null>(readAdminUiRole())

  const readOnly = isAdminUiReadOnly() || backendRole === 'VIEWER'
  const isOperator = (backendRole ?? readAdminUiRole()) === 'OPERATOR'

  useEffect(() => {
    const hash = location.hash.replace(/^#/, '').trim()
    if (!hash) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.hash, https, users, systemFooter])

  const refreshAll = useCallback(async (options?: { background?: boolean }) => {
    setLoadError(null)
    try {
      const [h, u, sys, who] = await Promise.all([
        getAdminHttpsSettings(),
        listAdminUsers(),
        getAdminSystemInfo(),
        getAuthWhoAmI().catch(() => null),
      ])
      const draft = httpsDraftFromSettings(h)
      setHttps(h)
      setHttpsDraft(draft)
      setUsers(u)
      setSystemFooter(sys)
      writeAdminSettingsSnapshot({ https: h, httpsDraft: draft, users: u, systemFooter: sys })
      if (who && (who.role === 'ADMINISTRATOR' || who.role === 'OPERATOR' || who.role === 'VIEWER')) {
        setBackendRole(who.role)
      }
      if (!options?.background) {
        setOpReload((n) => n + 1)
      }
    } catch (e) {
      if (!options?.background) {
        setLoadError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [])

  useEffect(() => {
    void refreshAll({ background: sessionSnapshot != null })
  }, [refreshAll]) // eslint-disable-line react-hooks/exhaustive-deps

  const httpsDirty = useMemo(() => {
    if (!https || !httpsDraft) return false
    const ips = httpsDraft.certificate_ip_addresses
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const dns = httpsDraft.certificate_dns_names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const baseDirty =
      https.enabled !== httpsDraft.enabled ||
      https.redirect_http_to_https !== httpsDraft.redirect_http_to_https ||
      https.certificate_valid_days !== httpsDraft.certificate_valid_days ||
      https.certificate_ip_addresses.join(',') !== ips.join(',') ||
      https.certificate_dns_names.join(',') !== dns.join(',')
    const regenDirty = httpsDraft.regenerate_certificate === false
    return baseDirty || regenDirty
  }, [https, httpsDraft])

  const activeAdminCount = useMemo(
    () => users.filter((u) => u.role === 'ADMINISTRATOR' && u.status === 'ACTIVE').length,
    [users],
  )

  const userStats = useMemo(() => {
    const total = users.length
    const active = users.filter((u) => u.status === 'ACTIVE').length
    const admins = users.filter((u) => u.role === 'ADMINISTRATOR').length
    const operators = users.filter((u) => u.role === 'OPERATOR').length
    const viewers = users.filter((u) => u.role === 'VIEWER').length
    return { total, active, admins, operators, viewers }
  }, [users])

  const onSaveHttps = async () => {
    if (!httpsDraft) return
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      const ips = httpsDraft.certificate_ip_addresses
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const dns = httpsDraft.certificate_dns_names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await putAdminHttpsSettings({
        enabled: httpsDraft.enabled,
        certificate_ip_addresses: ips,
        certificate_dns_names: dns,
        redirect_http_to_https: httpsDraft.redirect_http_to_https,
        certificate_valid_days: httpsDraft.certificate_valid_days,
        regenerate_certificate: httpsDraft.regenerate_certificate,
      })
      const extra =
        res.proxy_fallback_to_http && !res.proxy_https_effective
          ? ' The proxy fell back to HTTP-only so access stays available.'
          : ''
      const restart = res.restart_required ? ' Manual reverse-proxy reload may still be required.' : ''
      setPageMsg(`${res.message}${extra}${restart}`)
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onChangePassword = async () => {
    setPageErr(null)
    setPageMsg(null)
    const v = validateNewPassword(pwNew)
    if (v) {
      setPageErr(v)
      return
    }
    if (!passwordsMatch(pwNew, pwConfirm)) {
      setPageErr('New password and confirmation do not match.')
      return
    }
    setBusy(true)
    try {
      await postAdminPasswordChange({
        username: pwUser.trim(),
        current_password: pwCurrent,
        new_password: pwNew,
        confirm_password: pwConfirm,
      })
      setPageMsg('Password updated.')
      setPwCurrent('')
      setPwNew('')
      setPwConfirm('')
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openCreateUser = () => {
    setUserForm({ username: '', password: '', role: 'VIEWER', status: 'ACTIVE' })
    setEditingUser(null)
    setUserModal('create')
  }

  const openEditUser = (u: PlatformUserDto) => {
    setEditingUser(u)
    setUserForm({ username: u.username, password: '', role: u.role, status: u.status })
    setUserModal('edit')
  }

  const onSaveUser = async () => {
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      if (userModal === 'create') {
        const err = validateNewPassword(userForm.password)
        if (err) {
          setPageErr(err)
          return
        }
        await createAdminUser({
          username: userForm.username.trim(),
          password: userForm.password,
          role: userForm.role,
        })
        setPageMsg('User created.')
      } else if (editingUser) {
        const body: { password?: string; role?: string; status?: string } = {}
        if (userForm.password.trim()) {
          const err = validateNewPassword(userForm.password)
          if (err) {
            setPageErr(err)
            return
          }
          body.password = userForm.password
        }
        if (userForm.role !== editingUser.role) body.role = userForm.role
        if (userForm.status !== editingUser.status) body.status = userForm.status
        if (Object.keys(body).length === 0) {
          setPageMsg('No changes to save.')
        } else {
          await updateAdminUser(editingUser.id, body)
          setPageMsg('User updated.')
        }
      }
      setUserModal(null)
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDeleteUser = async (u: PlatformUserDto) => {
    if (!window.confirm(`Delete user ${u.username}?`)) return
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      await deleteAdminUser(u.id)
      setPageMsg('User deleted.')
      await refreshAll()
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openSystem = async () => {
    setSystemOpen(true)
    setSystemInfo(null)
    try {
      setSystemInfo(await getAdminSystemInfo())
    } catch {
      setSystemInfo(null)
    }
  }

  const onDownloadSupportBundle = async () => {
    setPageErr(null)
    setPageMsg(null)
    setBusy(true)
    try {
      await downloadAdminSupportBundle()
      setPageMsg('Support bundle download started.')
    } catch (e) {
      setPageErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const httpsStatusLabel = https?.https_listener_active
    ? 'TLS active'
    : https?.enabled
      ? 'TLS pending'
      : 'HTTP only'
  const httpsStatusBadge = (
    <span
      data-testid="admin-https-status-badge"
      className={cn(
        'inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ring-1',
        https?.https_listener_active
          ? 'bg-emerald-500/15 text-emerald-900 ring-emerald-500/30 dark:text-emerald-100/90'
          : https?.enabled
            ? 'bg-amber-500/15 text-amber-950 ring-amber-500/30 dark:text-amber-100/85'
            : 'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-gdc-elevated dark:text-gdc-muted dark:ring-gdc-border',
      )}
    >
      {httpsStatusLabel}
    </span>
  )

  const cardShell = gdcUi.cardShell
  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:focus-visible:ring-gdc-primary/45'
  const fieldLabel = 'text-sm font-medium text-slate-700 dark:text-slate-200'
  const fieldHint = 'mt-1 text-xs leading-relaxed text-slate-500 dark:text-gdc-muted'
  const sectionStepLabel = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'

  return (
    <div className="flex w-full min-w-0 flex-col gap-6" data-testid="admin-settings-page">
      <header className="space-y-3 border-b border-slate-200/80 pb-5 dark:border-gdc-divider">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Admin settings</h2>
          <p
            className="max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted"
            data-testid="admin-settings-purpose"
          >
            Review access and operational context, jump to a task section, then apply changes with the existing
            confirmation workflows. High-risk controls stay grouped under Access & security, Platform & network,
            Lifecycle & recovery, and Operations & audit.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={NAV_PATH.administration}
            data-testid="admin-settings-back-to-hub"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            Back to Administration
          </Link>
        </div>
        <nav
          aria-label="Settings section groups"
          data-testid="admin-settings-section-nav"
          className="flex flex-wrap gap-2"
        >
          {SETTINGS_SECTION_JUMPS.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex items-center rounded-lg border border-slate-200/90 bg-slate-50/80 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200 dark:hover:bg-gdc-cardHover"
            >
              <span className="sr-only">{item.group}: </span>
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      {readOnly ? (
        <div
          role="status"
          data-testid="admin-settings-readonly-banner"
          className="rounded-lg border border-sky-500/25 bg-sky-500/[0.07] px-3 py-2 text-sm text-sky-950 dark:border-sky-500/35 dark:bg-sky-500/10 dark:text-sky-100"
        >
          <strong>Read-only Viewer session.</strong> Mutating actions are disabled in the UI <em>and</em> rejected by the backend
          role guard (HTTP 403). Sign in as <code className="rounded bg-black/5 px-1 dark:bg-white/10">OPERATOR</code> or{' '}
          <code className="rounded bg-black/5 px-1 dark:bg-white/10">ADMINISTRATOR</code> to make changes.
        </div>
      ) : null}
      {isOperator ? (
        <div
          role="status"
          data-testid="admin-settings-operator-banner"
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Operator session — admin/security settings (HTTPS, accounts, retention policy, alert settings) are restricted to
          Administrators.
        </div>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Could not load admin settings: {loadError}
        </div>
      ) : null}
      {pageErr ? (
        <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-900 dark:text-red-100/90">
          {pageErr}
        </div>
      ) : null}
      {pageMsg ? (
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2 text-sm text-emerald-950 dark:text-emerald-100/90">
          {pageMsg}
        </div>
      ) : null}

      <section aria-labelledby="admin-settings-group-access" className="space-y-6" data-testid="admin-settings-group-access">
        <h2 id="admin-settings-group-access" className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Access & security
        </h2>

      {/* HTTPS / Security */}
      <section
        className={cn(cardShell, 'overflow-hidden')}
        aria-labelledby="admin-https-heading"
        data-testid="admin-https-panel"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Lock className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 id="admin-https-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                HTTPS / Security
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Review current TLS and proxy state, then change certificate settings and save. Self-signed TLS is served via
                nginx; HTTP stays available if TLS reload fails.
              </p>
            </div>
          </div>
          {httpsStatusBadge}
        </div>

        <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
          <div data-testid="admin-https-current-state" className="space-y-3">
            <p className={sectionStepLabel}>Current state</p>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[
                { term: 'Listener mode', detail: https?.https_listener_active ? 'HTTPS' : https?.enabled ? 'Configured' : 'HTTP' },
                { term: 'HTTP listener', detail: https?.http_listener_active ? 'Active' : 'Inactive' },
                { term: 'HTTPS listener', detail: https?.https_listener_active ? 'Active' : 'Inactive' },
                {
                  term: 'Redirect effective',
                  detail: https?.redirect_http_to_https_effective ? 'Yes' : 'No',
                },
                { term: 'Proxy status', detail: https?.proxy_status ?? '—' },
                {
                  term: 'Proxy health',
                  detail: https?.proxy_health_ok == null ? 'n/a' : https.proxy_health_ok ? 'Ok' : 'Failed',
                },
                { term: 'Last reload', detail: formatTs(https?.proxy_last_reload_at ?? null) },
                {
                  term: 'Certificate valid to',
                  detail: https?.certificate_not_after ? formatTs(https.certificate_not_after) : '—',
                },
              ].map((item) => (
                <div key={item.term} className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{item.term}</dt>
                  <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{item.detail}</dd>
                </div>
              ))}
            </dl>
            {https?.proxy_last_reload_detail ? (
              <p className="break-words text-sm text-slate-600 dark:text-gdc-muted">{https.proxy_last_reload_detail}</p>
            ) : null}
            {https?.proxy_fallback_to_http_last ? (
              <p className="text-sm font-medium text-amber-800 dark:text-amber-100/90">
                Recent proxy reload used HTTP fallback.
              </p>
            ) : null}
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className={fieldLabel} htmlFor="current-access">
                  Current access URL
                </label>
                <input
                  id="current-access"
                  readOnly
                  value={https?.current_access_url ?? '—'}
                  className={cn('mt-1.5 w-full', gdcUi.input, 'opacity-90')}
                />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="browser-http">
                  Browser HTTP URL
                </label>
                <input
                  id="browser-http"
                  readOnly
                  value={https?.browser_http_url || '—'}
                  className={cn('mt-1.5 w-full', gdcUi.input, 'opacity-90')}
                />
              </div>
              {https?.browser_https_url ? (
                <div>
                  <label className={fieldLabel} htmlFor="browser-https">
                    Browser HTTPS URL
                  </label>
                  <input
                    id="browser-https"
                    readOnly
                    value={https.browser_https_url}
                    className={cn('mt-1.5 w-full', gdcUi.input, 'opacity-90')}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div data-testid="admin-https-configuration" className="space-y-4 border-t border-slate-100 pt-6 dark:border-gdc-border">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className={sectionStepLabel}>Configuration</p>
                <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                  Edit TLS settings, then save. At least one IP or DNS SAN is required when HTTPS is enabled.
                </p>
              </div>
            </div>
            {httpsDraft ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <label
                  htmlFor="https-enabled"
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 px-4 py-3 dark:border-gdc-border"
                >
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">Enable HTTPS</span>
                  <input
                    id="https-enabled"
                    type="checkbox"
                    className={cn('h-4 w-4 accent-violet-600', focusRing)}
                    checked={httpsDraft.enabled}
                    disabled={readOnly}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, enabled: e.target.checked } : d))}
                  />
                </label>
                <label
                  htmlFor="https-redirect"
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 px-4 py-3 dark:border-gdc-border"
                >
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">Redirect HTTP to HTTPS</span>
                  <input
                    id="https-redirect"
                    type="checkbox"
                    className={cn('h-4 w-4 accent-violet-600', focusRing)}
                    checked={httpsDraft.redirect_http_to_https}
                    disabled={readOnly}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, redirect_http_to_https: e.target.checked } : d))}
                  />
                </label>
                <div className="lg:col-span-2">
                  <label className={fieldLabel} htmlFor="san-ip">
                    Certificate IP addresses (SAN)
                  </label>
                  <input
                    id="san-ip"
                    className={cn('mt-1.5 w-full', gdcUi.input)}
                    placeholder="e.g. 192.168.1.10, 10.0.0.5"
                    value={httpsDraft.certificate_ip_addresses}
                    disabled={readOnly}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, certificate_ip_addresses: e.target.value } : d))}
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className={fieldLabel} htmlFor="san-dns">
                    Certificate DNS names (SAN) (optional)
                  </label>
                  <input
                    id="san-dns"
                    className={cn('mt-1.5 w-full', gdcUi.input)}
                    placeholder="e.g. gdc.example.com, gdc.local"
                    value={httpsDraft.certificate_dns_names}
                    disabled={readOnly}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, certificate_dns_names: e.target.value } : d))}
                  />
                </div>
                <label
                  htmlFor="https-regenerate"
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/90 px-4 py-3 dark:border-gdc-border lg:col-span-2"
                >
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    Regenerate self-signed certificate on save
                  </span>
                  <input
                    id="https-regenerate"
                    type="checkbox"
                    className={cn('h-4 w-4 accent-violet-600', focusRing)}
                    checked={httpsDraft.regenerate_certificate}
                    disabled={readOnly}
                    onChange={(e) => setHttpsDraft((d) => (d ? { ...d, regenerate_certificate: e.target.checked } : d))}
                  />
                </label>
                <div>
                  <label className={fieldLabel} htmlFor="valid-days">
                    Certificate valid days
                  </label>
                  <select
                    id="valid-days"
                    className={cn('mt-1.5 w-full', gdcUi.select)}
                    value={httpsDraft.certificate_valid_days}
                    disabled={readOnly}
                    onChange={(e) =>
                      setHttpsDraft((d) => (d ? { ...d, certificate_valid_days: Number(e.target.value) } : d))
                    }
                  >
                    {validDaySelectOptions(httpsDraft.certificate_valid_days).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500" role="status">
                Loading HTTPS settings…
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500 dark:text-gdc-muted">
                {httpsDirty ? 'Unsaved HTTPS configuration changes.' : 'No unsaved HTTPS changes.'}
              </p>
              <button
                type="button"
                data-testid="admin-https-save"
                disabled={readOnly || !httpsDirty || busy || !httpsDraft}
                onClick={() => void onSaveHttps()}
                className={cn(
                  'rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
                  focusRing,
                  !readOnly && httpsDirty && !busy
                    ? 'bg-gdc-primary text-white hover:opacity-95'
                    : 'cursor-not-allowed bg-slate-200 text-slate-500 dark:bg-gdc-border dark:text-gdc-muted',
                )}
              >
                Save changes
              </button>
            </div>
          </div>

          <aside
            data-testid="admin-https-safeguards"
            className="rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-4 text-sm leading-relaxed text-sky-950 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-100/90"
          >
            <p className="flex items-center gap-2 font-semibold text-sky-900 dark:text-sky-100">
              <Info className="h-4 w-4 shrink-0" aria-hidden />
              Safeguards and evidence
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>Certificates are self-signed for internal or lab use.</li>
              <li>At least one IP or DNS SAN is required when HTTPS is enabled.</li>
              <li>PEM files are written to configured paths on save; previous files are copied under a backups folder.</li>
              <li>The reverse proxy reloads when GDC_PROXY_RELOAD_URL is configured; otherwise reload nginx manually.</li>
            </ul>
          </aside>
        </div>
      </section>

      {/* Password Management */}
      <section
        className={cn(cardShell, 'overflow-hidden')}
        aria-labelledby="admin-password-heading"
        data-testid="admin-password-panel"
      >
        <div className="border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200">
              <UserRound className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-password-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                Password Management
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Choose the target local account, confirm the current credential, then set and confirm the new password.
              </p>
            </div>
          </div>
        </div>
        <form
          className="space-y-5 px-4 py-5 md:px-6 md:py-6"
          onSubmit={(e) => {
            e.preventDefault()
            void onChangePassword()
          }}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2 md:max-w-sm">
              <label className={fieldLabel} htmlFor="pw-user">
                Target account username
              </label>
              <input
                id="pw-user"
                className={cn('mt-1.5 w-full', gdcUi.input)}
                value={pwUser}
                disabled={readOnly}
                onChange={(e) => setPwUser(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="pw-cur">
                Current password
              </label>
              <div className="relative mt-1.5">
                <input
                  id="pw-cur"
                  type={showPw ? 'text' : 'password'}
                  className={cn('w-full py-2 pl-3 pr-10', gdcUi.input)}
                  value={pwCurrent}
                  disabled={readOnly}
                  onChange={(e) => setPwCurrent(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className={cn(
                    'absolute right-1 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-gdc-rowHover',
                    focusRing,
                  )}
                  aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
                  aria-pressed={showPw}
                  onClick={() => setShowPw((s) => !s)}
                >
                  {showPw ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                </button>
              </div>
            </div>
            <div>
              <label className={fieldLabel} htmlFor="pw-new">
                New password
              </label>
              <input
                id="pw-new"
                type={showPw ? 'text' : 'password'}
                className={cn('mt-1.5 w-full', gdcUi.input)}
                value={pwNew}
                disabled={readOnly}
                onChange={(e) => setPwNew(e.target.value)}
                autoComplete="new-password"
                aria-describedby="pw-new-hint"
              />
              <p id="pw-new-hint" className={fieldHint}>
                Minimum 8 characters.
              </p>
            </div>
            <div className="md:col-span-2 md:max-w-md">
              <label className={fieldLabel} htmlFor="pw-conf">
                Confirm new password
              </label>
              <input
                id="pw-conf"
                type={showPw ? 'text' : 'password'}
                className={cn('mt-1.5 w-full', gdcUi.input)}
                value={pwConfirm}
                disabled={readOnly}
                onChange={(e) => setPwConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="flex justify-end border-t border-slate-100 pt-4 dark:border-gdc-border">
            <button
              type="submit"
              data-testid="admin-password-submit"
              disabled={readOnly || busy}
              className={cn(
                'rounded-lg border border-gdc-primary/40 bg-gdc-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-95 disabled:opacity-50',
                focusRing,
              )}
            >
              Change password
            </button>
          </div>
        </form>
      </section>

      {/* User Management */}
      <section
        className={cn(cardShell, 'overflow-hidden')}
        aria-labelledby="admin-users-heading"
        data-testid="admin-users-panel"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Users className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 id="admin-users-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                User Management
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Local platform accounts with lightweight roles. This is not a full enterprise RBAC engine.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="admin-users-create"
            onClick={openCreateUser}
            disabled={readOnly}
            className={cn(
              'rounded-lg border border-gdc-primary/50 px-3.5 py-2 text-sm font-semibold text-gdc-primary hover:bg-gdc-primary/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-200',
              focusRing,
            )}
          >
            New user
          </button>
        </div>

        <div className="space-y-4 px-4 py-5 md:px-6">
          <div data-testid="admin-users-summary" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              { label: 'Total users', value: userStats.total },
              { label: 'Active', value: userStats.active },
              { label: 'Administrators', value: userStats.admins },
              { label: 'Operators', value: userStats.operators },
              { label: 'Viewers', value: userStats.viewers },
            ].map((s) => (
              <div key={s.label} className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                <p className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{s.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">{s.value}</p>
              </div>
            ))}
          </div>
          <p
            data-testid="admin-users-role-note"
            className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-3.5 py-3 text-sm leading-relaxed text-slate-600 dark:border-gdc-border dark:bg-gdc-panel dark:text-gdc-muted"
          >
            Roles are stored for account management. Viewer sessions remain read-only in the UI and are rejected by the
            backend role guard. Operator sessions cannot change HTTPS, accounts, retention policy, or alert settings.
            Permission enforcement beyond these local-account guards is limited until a fuller RBAC model is implemented.
          </p>

          {users.length === 0 ? (
            <div className={gdcUi.emptyPanel} data-testid="admin-users-empty" role="status">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">No platform users loaded</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                Create a local account or refresh admin settings after the API is available.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-gdc-border">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm" data-testid="admin-users-table">
                  <caption className="sr-only">Platform user accounts</caption>
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted">
                      <th scope="col" className="px-3 py-3">
                        Username
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Role
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Created at
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Last login
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const lastOnlyAdmin =
                        u.role === 'ADMINISTRATOR' && u.status === 'ACTIVE' && activeAdminCount <= 1
                      const hideActions = u.username.toLowerCase() === 'admin' || lastOnlyAdmin
                      return (
                        <tr
                          key={u.id}
                          className="border-b border-slate-50 last:border-0 dark:border-gdc-border/60"
                          data-testid={`admin-user-row-${u.username}`}
                        >
                          <th scope="row" className="px-3 py-3 font-medium text-slate-900 dark:text-slate-50">
                            {u.username}
                          </th>
                          <td className="px-3 py-3">
                            <span
                              className={cn(
                                'inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                                roleBadgeClass(u.role),
                              )}
                            >
                              {roleLabel(u.role)}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={
                                u.status === 'ACTIVE'
                                  ? 'text-sm font-medium text-emerald-700 dark:text-emerald-300'
                                  : 'text-sm text-slate-500 dark:text-gdc-muted'
                              }
                            >
                              {u.status === 'ACTIVE' ? 'Active' : u.status === 'DISABLED' ? 'Disabled' : u.status}
                            </span>
                          </td>
                          <td className="px-3 py-3 tabular-nums text-slate-600 dark:text-gdc-mutedStrong">
                            {formatTs(u.created_at)}
                          </td>
                          <td className="px-3 py-3 tabular-nums text-slate-600 dark:text-gdc-mutedStrong">
                            {formatTs(u.last_login_at)}
                          </td>
                          <td className="px-3 py-3 text-right">
                            {hideActions || readOnly ? (
                              <span className="text-xs text-slate-400">
                                {readOnly ? 'Read-only' : lastOnlyAdmin ? 'Protected' : '—'}
                              </span>
                            ) : (
                              <span className="inline-flex justify-end gap-1">
                                <button
                                  type="button"
                                  className={cn(
                                    'rounded-md p-1.5 text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover',
                                    focusRing,
                                  )}
                                  aria-label={`Edit user ${u.username}`}
                                  onClick={() => openEditUser(u)}
                                >
                                  <Pencil className="h-4 w-4" aria-hidden />
                                </button>
                                <button
                                  type="button"
                                  className={cn('rounded-md p-1.5 text-red-600 hover:bg-red-500/10', focusRing)}
                                  aria-label={`Delete user ${u.username}`}
                                  onClick={() => void onDeleteUser(u)}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-slate-500 dark:text-gdc-muted">
                Showing {users.length === 0 ? '0' : `1 to ${users.length}`} of {users.length} users
              </p>
            </>
          )}
        </div>
      </section>
      </section>

      <section
        aria-labelledby="admin-settings-group-platform"
        className="space-y-6"
        data-testid="admin-settings-group-platform"
      >
        <h2
          id="admin-settings-group-platform"
          className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50"
        >
          Platform & network
        </h2>

      <AdminDisplayTimezoneSettings
        backendRole={backendRole}
        readOnly={readOnly}
        busy={busy}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />

      <AdminNetworkSettingsPage />
      </section>

      <section
        aria-labelledby="admin-settings-group-lifecycle"
        className="space-y-6"
        data-testid="admin-settings-group-lifecycle"
      >
        <h2
          id="admin-settings-group-lifecycle"
          className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50"
        >
          Lifecycle & recovery
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
          Retention cleanup and portable configuration recovery live here. Audit history and system health stay under
          Operations & audit.
        </p>

      <AdminRetentionSettings
        reloadToken={opReload}
        readOnly={readOnly}
        busy={busy}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />

      <section
        className={cn(cardShell, 'overflow-hidden')}
        aria-labelledby="admin-backup-recovery-heading"
        data-testid="admin-backup-recovery-card"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
              <HardDrive className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 id="admin-backup-recovery-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                Backup & Import
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Export or import portable JSON workspace configuration (additive or clone). Database disaster recovery uses
                PostgreSQL backup/restore — not JSON import.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/operations/backup')}
            data-testid="admin-open-backup-import"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            Open Backup & Import
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </section>
      </section>

      {isDevValidationLabUiEnabled() ? <AdminDevValidationPanel backendRole={backendRole} /> : null}

      <section
        aria-labelledby="admin-settings-group-operations"
        className="space-y-6"
        data-testid="admin-settings-group-operations"
      >
        <h2
          id="admin-settings-group-operations"
          className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-50"
        >
          Operations & audit
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
          Maintenance readiness, support evidence, audit/config history, and health monitoring live here. Retention and
          Backup & Import stay under Lifecycle & recovery.
        </p>

      <AdminMaintenanceCenter backendRole={backendRole} busy={busy} setBusy={setBusy} />

      <section className={cn(cardShell, 'p-4 md:p-6')} aria-labelledby="admin-support-bundle-heading" data-testid="admin-support-bundle-panel">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Package className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="admin-support-bundle-heading" className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                Support bundle
              </h3>
              <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                Generates a ZIP of masked JSON summaries for troubleshooting. Does not change runtime, checkpoints, or delivery
                behavior. Only the Administrator role may download.
              </p>
            </div>
          </div>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-[13px] font-semibold transition-colors',
              backendRole === 'ADMINISTRATOR' && !busy
                ? 'border-violet-500/30 bg-violet-600 text-white hover:bg-violet-500 dark:border-violet-500/40 dark:bg-violet-600 dark:hover:bg-violet-500'
                : 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted',
            )}
            disabled={backendRole !== 'ADMINISTRATOR' || busy}
            onClick={() => void onDownloadSupportBundle()}
          >
            <Download className="h-4 w-4 shrink-0" aria-hidden />
            Generate Support Bundle
          </button>
        </div>
        {backendRole !== 'ADMINISTRATOR' ? (
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
            Sign in as <span className="font-medium text-slate-800 dark:text-slate-200">Administrator</span> to download a
            support bundle.
          </p>
        ) : null}
      </section>

      <AdminOperationalDashboard
        reloadToken={opReload}
        readOnly={readOnly}
        busy={busy}
        setBusy={setBusy}
        setPageMsg={setPageMsg}
        setPageErr={setPageErr}
      />
      </section>

      {/* System information footer */}
      <section className={cn(cardShell, 'flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6')} aria-label="System information summary">
        <div className="flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-2 text-[12px] text-slate-600 dark:text-gdc-muted">
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Environment</span> {systemFooter?.app_env ?? '—'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Version</span> {systemFooter?.app_version ?? '—'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Uptime</span> {formatUptimeSeconds(systemFooter?.uptime_seconds ?? undefined)}
          </span>
          <span className="max-w-[min(100%,28rem)] truncate" title={systemFooter?.database_version ?? ''}>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Database</span>{' '}
            {systemFooter?.database_reachable === false ? 'unreachable' : systemFooter?.database_version?.split(',')[0]?.trim() ?? 'PostgreSQL'}
          </span>
          <span>
            <span className="font-semibold text-slate-800 dark:text-slate-100">Timezone</span> {systemFooter?.timezone ?? '—'}
          </span>
          <span className="tabular-nums">
            <span className="font-semibold text-slate-800 dark:text-slate-100">Server (UTC)</span>{' '}
            {systemFooter?.server_time_utc ? formatTs(systemFooter.server_time_utc) : '—'}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void openSystem()}
            data-testid="admin-open-system-information"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-card"
          >
            <Server className="h-3.5 w-3.5" aria-hidden />
            System information
          </button>
          <button
            type="button"
            onClick={() => void refreshAll()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-gdc-border dark:text-slate-100 dark:hover:bg-gdc-card"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </button>
        </div>
      </section>

      {userModal ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60" role="dialog" aria-modal="true" aria-labelledby="admin-user-modal-title">
          <div className={cn(gdcUi.modalPanel, 'max-w-md')}>
            <h4 id="admin-user-modal-title" className="text-base font-semibold text-slate-900 dark:text-slate-50">
              {userModal === 'create' ? 'New user' : 'Edit user'}
            </h4>
            <div className="mt-4 space-y-3">
              <div>
                <label className={fieldLabel} htmlFor="user-form-username">
                  Username
                </label>
                <input
                  id="user-form-username"
                  disabled={userModal === 'edit'}
                  className={cn('mt-1.5 w-full', gdcUi.input, 'disabled:bg-slate-100 dark:disabled:bg-gdc-elevated')}
                  value={userForm.username}
                  onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="user-form-password">
                  {userModal === 'create' ? 'Password' : 'New password (optional)'}
                </label>
                <input
                  id="user-form-password"
                  type="password"
                  className={cn('mt-1.5 w-full', gdcUi.input)}
                  value={userForm.password}
                  onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
              <div>
                <label className={fieldLabel} htmlFor="user-form-role">
                  Role
                </label>
                <select
                  id="user-form-role"
                  className={cn('mt-1.5 w-full', gdcUi.select, 'dark:[color-scheme:dark]')}
                  value={userForm.role}
                  onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                >
                  <option value="VIEWER">Viewer</option>
                  <option value="OPERATOR">Connector Operator (legacy Operator)</option>
                  <option value="CONNECTOR_OPERATOR">Connector Operator</option>
                  <option value="GOVERNANCE_OPERATOR">Governance Operator</option>
                  <option value="GOVERNANCE_REVIEWER">Governance Reviewer</option>
                  <option value="GOVERNANCE_APPROVER">Governance Approver</option>
                  <option value="GOVERNANCE_AUDITOR">Governance Auditor</option>
                  <option value="ADMINISTRATOR">Administrator</option>
                </select>
              </div>
              {userModal === 'edit' ? (
                <div>
                  <label className={fieldLabel} htmlFor="user-form-status">
                    Status
                  </label>
                  <select
                    id="user-form-status"
                    className={cn('mt-1.5 w-full', gdcUi.select, 'dark:[color-scheme:dark]')}
                    value={userForm.status}
                    onChange={(e) => setUserForm((f) => ({ ...f, status: e.target.value }))}
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="DISABLED">Disabled</option>
                  </select>
                </div>
              ) : null}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className={cn('rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:hover:bg-gdc-rowHover', focusRing)}
                onClick={() => setUserModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={readOnly || busy}
                className={cn('rounded-lg bg-gdc-primary px-3 py-1.5 text-sm font-semibold text-white hover:opacity-95 disabled:opacity-50', focusRing)}
                onClick={() => void onSaveUser()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {systemOpen ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60" role="dialog" aria-modal="true">
          <div className={cn(gdcUi.modalPanel, 'max-w-lg')}>
            <h4 className="text-[15px] font-semibold text-slate-900 dark:text-slate-50">System information</h4>
            {systemInfo ? (
              <dl className="mt-4 space-y-2 text-[13px]">
                {Object.entries(systemInfo).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1 dark:border-gdc-border">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="max-w-[60%] break-all text-right font-medium text-slate-900 dark:text-slate-100">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-3 text-[13px] text-slate-500">Loading…</p>
            )}
            <div className="mt-4 flex justify-end">
              <button type="button" className="rounded-lg bg-slate-900 px-3 py-1.5 text-[13px] font-semibold text-white dark:bg-slate-100 dark:text-slate-900" onClick={() => setSystemOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
