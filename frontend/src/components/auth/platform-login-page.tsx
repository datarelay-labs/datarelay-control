import { useEffect, useState } from 'react'
import { AuthLayout, LoginForm, type LoginSubmission } from '@datarelay-labs/auth-ui'
import {
  BookOpen,
  Globe,
  Mail,
  Rocket,
  ScrollText,
} from 'lucide-react'
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
  {
    title: 'Documentation',
    subtitle: 'datarelay.run/docs',
    href: 'https://datarelay.run/docs',
    icon: BookOpen,
  },
  {
    title: 'Quick Start Guide',
    subtitle: 'datarelay.run/quickstart',
    href: 'https://datarelay.run/quickstart',
    icon: Rocket,
  },
  {
    title: 'Release Notes',
    subtitle: 'datarelay.run/releases',
    href: 'https://datarelay.run/releases',
    icon: ScrollText,
  },
  {
    title: 'DataRelay Website',
    subtitle: 'datarelay.run',
    href: 'https://datarelay.run',
    icon: Globe,
  },
  {
    title: 'Support',
    subtitle: 'support@datarelay.run',
    href: 'mailto:support@datarelay.run',
    icon: Mail,
  },
]

type PlatformLoginPageProps = {
  onAuthenticated: () => void
}

export function PlatformLoginPage({ onAuthenticated }: PlatformLoginPageProps) {
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

  async function onSubmit({ username: submittedUsername, password: submittedPassword }: LoginSubmission) {
    setError(null)
    const u = submittedUsername.trim()
    if (!u || !submittedPassword) { setError('Enter your username and password.'); return }
    setBusy(true)
    try {
      const res = await postAuthLogin({ username: u, password: submittedPassword })
      persistSession({ access_token: res.access_token, refresh_token: res.refresh_token, expires_at: res.expires_at, user: { username: res.user.username, role: res.user.role, status: res.user.status, ...(res.user.must_change_password === true ? { must_change_password: true } : {}), ...(res.user.capabilities ? { capabilities: res.user.capabilities } : {}) } })
      if (res.user.must_change_password === true || accessTokenRequiresPasswordChange(res.access_token)) markSessionRequiresPasswordChange()
      onAuthenticated()
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign-in failed.') } finally { setBusy(false) }
  }

  return (
    <AuthLayout productName="DataRelay" productSubtitle="Operational Data Connector Platform" description="Collect. Transform. Deliver. Connect to any source, transform and enrich your data, then deliver it to multiple destinations reliably and securely." title="Welcome to DataRelay" subtitle="Please sign in to continue." brandMark={<><DataRelayLogoMark className="h-12 w-auto" aria-label="DataRelay logo" /><DataRelayWordmark /></>} resources={RESOURCES.map(({ title, subtitle, href }) => ({ title, description: subtitle, href, external: href.startsWith('http') }))}>
      <LoginForm onSubmit={onSubmit} busy={busy} errorCategory={error ? 'unauthenticated' : undefined} errorMessage={error ?? undefined} infoMessage={info ?? undefined} submitLabel="Sign In" />
    </AuthLayout>
  )}
