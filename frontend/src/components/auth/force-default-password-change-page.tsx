import { useState, type FormEvent } from 'react'
import { Lock, Eye, EyeOff } from 'lucide-react'
import { postAuthChangePassword } from '../../api/gdcAdmin'
import { clearSession } from '../../auth/session'
import { cn } from '../../lib/utils'
import { DataRelayLogoMark, DataRelayWordmark } from './datarelay-logo'

type ForceDefaultPasswordChangePageProps = {
  onCompleted: () => void
}

export function ForceDefaultPasswordChangePage({ onCompleted }: ForceDefaultPasswordChangePageProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.')
      return
    }
    if (newPassword.trim().toLowerCase() === 'admin') {
      setError('The new password cannot be "admin". Choose a stronger password.')
      return
    }
    setBusy(true)
    try {
      await postAuthChangePassword({
        current_password: currentPassword,
        new_password: newPassword,
        confirm_new_password: confirmPassword,
      })
      try {
        sessionStorage.setItem('gdc_post_password_change', '1')
      } catch {
        /* ignore */
      }
      clearSession()
      setDone(true)
      onCompleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-gdc-page text-gdc-foreground">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-md">
          <header className="mb-8 flex flex-col items-center text-center">
            <DataRelayLogoMark className="mb-4 h-12 w-auto sm:h-12" aria-label="DataRelay logo" />
            <DataRelayWordmark />
          </header>

          <div className={cn('rounded-lg border border-gdc-border bg-gdc-card p-6 sm:p-8')}>
            <div className="mb-6 flex flex-col items-center text-center">
              <div
                className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-gdc-border bg-gdc-section"
                aria-hidden
              >
                <Lock className="h-5 w-5 text-violet-400" strokeWidth={2} />
              </div>
              <h1 className="text-xl font-semibold text-gdc-foreground sm:text-2xl">Change your password</h1>
              <p className="mt-2 text-sm leading-relaxed text-gdc-muted">
                Your account must use a new password before you can access the platform.
              </p>
            </div>

            {done ? (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100" role="status">
                Password updated. Sign in again with your new password.
              </p>
            ) : null}

            <form onSubmit={(e) => void onSubmit(e)} className="space-y-4">
              <div>
                <label htmlFor="force-pw-current" className="mb-1.5 block text-xs font-medium text-gdc-mutedStrong">
                  Current password
                </label>
                <div className="relative">
                  <input
                    id="force-pw-current"
                    name="current_password"
                    type={showCurrent ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="h-9 w-full rounded-lg border border-gdc-inputBorder bg-gdc-input py-2 pl-3 pr-11 text-sm text-gdc-foreground placeholder:text-gdc-placeholder focus:border-gdc-primary focus:outline-none focus:ring-2 focus:ring-violet-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gdc-muted hover:bg-gdc-rowHover hover:text-gdc-foreground"
                    aria-label={showCurrent ? 'Hide password' : 'Show password'}
                  >
                    {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="force-pw-new" className="mb-1.5 block text-xs font-medium text-gdc-mutedStrong">
                  New password
                </label>
                <div className="relative">
                  <input
                    id="force-pw-new"
                    name="new_password"
                    type={showNew ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="h-9 w-full rounded-lg border border-gdc-inputBorder bg-gdc-input py-2 pl-3 pr-11 text-sm text-gdc-foreground placeholder:text-gdc-placeholder focus:border-gdc-primary focus:outline-none focus:ring-2 focus:ring-violet-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gdc-muted hover:bg-gdc-rowHover hover:text-gdc-foreground"
                    aria-label={showNew ? 'Hide password' : 'Show password'}
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="force-pw-confirm" className="mb-1.5 block text-xs font-medium text-gdc-mutedStrong">
                  Confirm new password
                </label>
                <div className="relative">
                  <input
                    id="force-pw-confirm"
                    name="confirm_new_password"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="h-9 w-full rounded-lg border border-gdc-inputBorder bg-gdc-input py-2 pl-3 pr-11 text-sm text-gdc-foreground placeholder:text-gdc-placeholder focus:border-gdc-primary focus:outline-none focus:ring-2 focus:ring-violet-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gdc-muted hover:bg-gdc-rowHover hover:text-gdc-foreground"
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

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
                {busy ? 'Updating…' : 'Update password and sign in again'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
