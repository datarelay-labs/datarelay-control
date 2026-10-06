import { useEffect, useState, type FormEvent } from 'react'
import { AuthLayout } from '@datarelay-labs/auth-ui'
import { BookOpen, Eye, EyeOff, Globe, Lock, Mail, Rocket, ScrollText, User } from 'lucide-react'
import { postAuthLogin } from '../../api/gdcAdmin'
import { accessTokenRequiresPasswordChange } from '../../auth/jwt-session-hints'
import { markSessionRequiresPasswordChange } from '../../auth/password-change-gate'
import { persistSession } from '../../auth/session'
import { DataRelayLogoMark, DataRelayWordmark } from './datarelay-logo'

const RESOURCES: readonly {
  title: string
  subtitle: string
  href: string
  icon: typeof BookOpen
}[] = [
  { title: 'Documentation', subtitle: 'datarelay.run/docs', href: 'https://datarelay.run/docs', icon: BookOpen },
  { title: 'Quick Start Guide', subtitle: 'datarelay.run/quickstart', href: 'https://datarelay.run/quickstart', icon: Rocket },
  { title: 'Release Notes', subtitle: 'datarelay.run/releases', href: 'https://datarelay.run/releases', icon: ScrollText },
  { title: 'DataRelay Website', subtitle: 'datarelay.run', href: 'https://datarelay.run', icon: Globe },
  { title: 'Support', subtitle: 'support@datarelay.run', href: 'mailto:support@datarelay.run', icon: Mail },
]

type PlatformLoginPageProps = {
  onAuthenticated: () => void
}

export function PlatformLoginPage({ onAuthenticated }: PlatformLoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    try {
      if (sessionStorage.getItem('gdc_post_password_change') === '1') {
        sessionStorage.removeItem('gdc_post_password_change')
        setInfo('Password updated. Sign in with your new password.')
      }
    } catch {
      /* ignore */
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const u = username.trim()
    if (!u || !password) {
      setError('Enter your username and password.')
      return
    }
    setBusy(true)
    try {
      const res = await postAuthLogin({ username: u, password })
      persistSession({
        access_token: res.access_token,
        refresh_token: res.refresh_token,
        expires_at: res.expires_at,
        user: {
          username: res.user.username,
          role: res.user.role,
          status: res.user.status,
          ...(res.user.must_change_password === true ? { must_change_password: true } : {}),
          ...(res.user.capabilities ? { capabilities: res.user.capabilities } : {}),
        },
      })
      if (res.user.must_change_password === true || accessTokenRequiresPasswordChange(res.access_token)) {
        markSessionRequiresPasswordChange()
      }
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gdc-login-centered" data-testid="gdc-login-centered">
      <AuthLayout
      productName="DataRelay"
      productSubtitle="Operational Data Connector Platform"
      description="Collect. Transform. Deliver. Connect to any source, transform and enrich your data, then deliver it to multiple destinations reliably and securely."
      title="Welcome to DataRelay"
      subtitle="Please sign in to continue."
      brandMark={
        <>
          <DataRelayLogoMark className="h-12 w-auto" aria-label="DataRelay logo" />
          <DataRelayWordmark />
        </>
      }
      resources={RESOURCES.map(({ title, subtitle, href }) => ({
        title,
        description: subtitle,
        href,
        external: href.startsWith('http'),
      }))}
    >
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
        <div>
          <label htmlFor="platform-login-username" className="mb-1.5 block text-xs font-medium text-gdc-mutedStrong">
            Username
          </label>
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gdc-placeholder" aria-hidden />
            <input
              id="platform-login-username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              className="h-9 w-full rounded-lg border border-gdc-inputBorder bg-gdc-input py-2 pl-10 pr-3 text-sm text-gdc-foreground placeholder:text-gdc-placeholder focus:border-gdc-primary focus:outline-none focus:ring-2 focus:ring-violet-400/30"
            />
          </div>
        </div>

        <div>
          <label htmlFor="platform-login-password" className="mb-1.5 block text-xs font-medium text-gdc-mutedStrong">
            Password
          </label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gdc-placeholder" aria-hidden />
            <input
              id="platform-login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              className="h-9 w-full rounded-lg border border-gdc-inputBorder bg-gdc-input py-2 pl-10 pr-11 text-sm text-gdc-foreground placeholder:text-gdc-placeholder focus:border-gdc-primary focus:outline-none focus:ring-2 focus:ring-violet-400/30"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gdc-muted hover:bg-gdc-rowHover hover:text-gdc-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {info ? (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-100" role="status">
            {info}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-md border border-rose-500/30 bg-rose-950/40 px-3 py-2 text-xs text-rose-200" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 flex h-9 w-full items-center justify-center rounded-lg bg-gdc-primary text-sm font-semibold text-white hover:bg-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>

        <p className="pt-1 text-center text-xs leading-relaxed text-gdc-muted">
          Accounts are created by an administrator. Self-service registration is not available.
        </p>
      </form>
      </AuthLayout>
    </div>
  )
}
