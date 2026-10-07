import { StrictMode, useEffect, useReducer, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './foundation-semantic-tokens.css'
import '@datarelay-labs/ui/styles.css'
import '@datarelay-labs/product-shell/styles.css'
import '@datarelay-labs/auth-ui/styles.css'
import '@datarelay-labs/system-admin-ui/styles.css'
import './index.css'
import App from './App.tsx'
import { clearChunkReloadGuard } from './lib/lazy-with-chunk-retry'
import { PlatformLoginPage } from './components/auth/platform-login-page'
import { ForceDefaultPasswordChangePage } from './components/auth/force-default-password-change-page'
import { getAuthMe } from './api/gdcAdmin'
import { tryRefreshSession } from './api'
import { accessTokenRequiresPasswordChange } from './auth/jwt-session-hints'
import {
  errorIndicatesPasswordChangeRequired,
  markSessionRequiresPasswordChange,
  syncSessionFromWhoAmI,
} from './auth/password-change-gate'
import { clearSession, getRefreshToken, isSessionExpired, onSessionChange, readSession } from './auth/session'
import { migrateAutoRefreshPreferences } from './localPreferences'

migrateAutoRefreshPreferences()
clearChunkReloadGuard()

function hasValidSession(): boolean {
  const s = readSession()
  if (!s) return false
  return !isSessionExpired()
}

function sessionRequiresPasswordChange(): boolean {
  const s = readSession()
  if (!s || isSessionExpired()) return false
  if (s.user.must_change_password === true) return true
  return accessTokenRequiresPasswordChange(s.access_token)
}

function PlatformSessionRoot() {
  const [, bump] = useReducer((c: number) => c + 1, 0)
  const [bootstrapRefreshing, setBootstrapRefreshing] = useState(() => {
    const session = readSession()
    return Boolean(session && isSessionExpired() && getRefreshToken())
  })
  const accessTokenFingerprint = readSession()?.access_token ?? ''

  const needsPasswordChangeGate = sessionRequiresPasswordChange()

  useEffect(() => {
    const session = readSession()
    if (!session || !isSessionExpired() || !getRefreshToken()) {
      setBootstrapRefreshing(false)
      return
    }
    let cancelled = false
    setBootstrapRefreshing(true)
    void tryRefreshSession().then((ok) => {
      if (cancelled) return
      if (!ok) clearSession()
      setBootstrapRefreshing(false)
      bump()
    })
    return () => {
      cancelled = true
    }
  }, [accessTokenFingerprint])

  useEffect(() => {
    if (!accessTokenFingerprint || isSessionExpired() || needsPasswordChangeGate) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const who = await getAuthMe()
        if (!cancelled) syncSessionFromWhoAmI(who)
      } catch (err) {
        if (cancelled) return
        if (errorIndicatesPasswordChangeRequired(err)) {
          markSessionRequiresPasswordChange()
        } else {
          clearSession()
        }
        bump()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accessTokenFingerprint, bump, needsPasswordChangeGate])

  useEffect(() => {
    const unsubA = onSessionChange(() => bump())
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === 'gdc_platform_session_v1') bump()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      unsubA()
      window.removeEventListener('storage', onStorage)
    }
  }, [bump])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!hasValidSession()) bump()
    }, 60_000)
    return () => window.clearInterval(id)
  }, [bump])

  if (bootstrapRefreshing) {
    return (
      <div className="dark flex min-h-screen items-center justify-center text-sm text-slate-300" data-dr-theme="dark">
        Restoring session…
      </div>
    )
  }

  if (!hasValidSession()) {
    return (
      <div className="dark" data-dr-theme="dark">
        <PlatformLoginPage onAuthenticated={bump} />
      </div>
    )
  }

  if (needsPasswordChangeGate) {
    return (
      <div className="dark" data-dr-theme="dark">
        <ForceDefaultPasswordChangePage onCompleted={bump} />
      </div>
    )
  }

  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <PlatformSessionRoot />
    </BrowserRouter>
  </StrictMode>,
)
