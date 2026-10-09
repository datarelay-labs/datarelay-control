import { useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { LockKeyhole, ShieldCheck } from 'lucide-react'
import {
  getAuthMfaStatus,
  postAuthMfaEnrollConfirm,
  postAuthMfaEnrollStart,
} from '../../api/gdcAdmin'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

type Enrollment = { secret: string; otpauth_uri: string; expires_at: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'MFA request failed. Please try again.'
}

/** Account-owner opt-in: no MFA secrets or recovery codes are persisted client-side. */
export function AdminMfaEnrollment() {
  const [status, setStatus] = useState<'loading' | 'disabled' | 'enabled' | 'unavailable'>('loading')
  const [currentPassword, setCurrentPassword] = useState('')
  const [setup, setSetup] = useState<Enrollment | null>(null)
  const [qrData, setQrData] = useState<string | null>(null)
  const [otp, setOtp] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void getAuthMfaStatus()
      .then(({ enabled }) => {
        if (mounted) setStatus(enabled ? 'enabled' : 'disabled')
      })
      .catch(() => {
        if (mounted) setStatus('unavailable')
      })
    return () => { mounted = false }
  }, [])

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!currentPassword || busy) return
    setBusy(true)
    setError(null)
    setQrData(null)
    setSetup(null)
    try {
      const pending = await postAuthMfaEnrollStart(currentPassword)
      setCurrentPassword('')
      setSetup(pending)
      try {
        // Local QR rendering only: never send the otpauth URI/secret to an external QR service.
        const data = await QRCode.toDataURL(pending.otpauth_uri, {
          errorCorrectionLevel: 'M', margin: 2, width: 192,
        })
        setQrData(data)
      } catch {
        // Manual key remains usable if image generation fails.
        setQrData(null)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCurrentPassword('')
      setBusy(false)
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!setup || !/^[0-9]{6}$/.test(otp) || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await postAuthMfaEnrollConfirm(otp)
      setRecoveryCodes(result.recovery_codes)
      setSetup(null)
      setQrData(null)
      setOtp('')
      setStatus('enabled')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="admin-mfa-heading"
      data-testid="admin-mfa-panel"
      className={cn(gdcUi.cardShell, 'overflow-hidden')}
    >
      <div className="flex gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:text-violet-200">
          <LockKeyhole className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h3 id="admin-mfa-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Authenticator (TOTP) MFA
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
            Optional, per-account protection for Web sign-in. Manage MFA for your own signed-in account.
            MFA is off until you complete enrollment.
          </p>
        </div>
      </div>

      <div className="space-y-4 px-4 py-5 text-sm text-slate-700 dark:text-slate-200 md:px-6">
        {status === 'loading' && <p role="status">Checking account MFA status…</p>}
        {status === 'unavailable' && (
          <p role="alert">Account MFA status is unavailable. Sign in with your local account and try again.</p>
        )}
        {error && <p role="alert" className="text-rose-600 dark:text-rose-300">{error}</p>}

        {status === 'enabled' && !recoveryCodes && (
          <p className="flex items-center gap-2" role="status">
            <ShieldCheck className="h-5 w-5 text-emerald-600" aria-hidden />
            MFA enabled. The next Web sign-in requires an authenticator or unused recovery code.
          </p>
        )}

        {status === 'disabled' && !setup && (
          <form onSubmit={(e) => void start(e)} className="space-y-3" data-testid="admin-mfa-start">
            <p>Confirm your current password to generate a private authenticator setup key.</p>
            <label htmlFor="admin-mfa-password" className="block font-medium">Current password</label>
            <input
              id="admin-mfa-password"
              type="password"
              autoComplete="current-password"
              className={cn(gdcUi.input, 'w-full max-w-sm')}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <button
              className="rounded-lg bg-gdc-primary px-4 py-2 font-semibold text-white disabled:opacity-50"
              type="submit"
              disabled={busy || !currentPassword}
            >
              {busy ? 'Starting…' : 'Set up authenticator'}
            </button>
          </form>
        )}

        {status === 'disabled' && setup && (
          <form onSubmit={(e) => void confirm(e)} className="space-y-3" data-testid="admin-mfa-confirm">
            <p>Scan this QR code using your authenticator app. This setup expires in five minutes.</p>
            {qrData ? (
              <img
                src={qrData}
                alt="TOTP authenticator enrollment QR code"
                className="h-48 w-48 rounded-lg border border-slate-200 bg-white p-1"
              />
            ) : (
              <p role="status">QR image unavailable. Enter the manual secret in your authenticator.</p>
            )}
            <div>
              <p className="font-medium">Manual setup key (keep private)</p>
              <code className="mt-1 block max-w-lg break-all rounded bg-slate-100 p-2 dark:bg-slate-800" data-testid="admin-mfa-manual-key">
                {setup.secret}
              </code>
            </div>
            <label htmlFor="admin-mfa-code" className="block font-medium">6-digit code from your authenticator</label>
            <input
              id="admin-mfa-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              className={cn(gdcUi.input, 'w-full max-w-xs')}
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="rounded-lg bg-gdc-primary px-4 py-2 font-semibold text-white disabled:opacity-50"
                disabled={busy || !/^[0-9]{6}$/.test(otp)}
              >
                {busy ? 'Enabling…' : 'Verify and enable MFA'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-4 py-2 dark:border-gdc-border"
                disabled={busy}
                onClick={() => { setSetup(null); setQrData(null); setOtp(''); setError(null) }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {recoveryCodes && (
          <div className="space-y-3" data-testid="admin-mfa-recovery-codes">
            <h4 className="font-semibold">Save your one-time recovery codes</h4>
            <p role="alert">
              These codes appear only once. Store them offline before closing this page.
              Enabling MFA also invalidated your existing session; sign in again afterward.
            </p>
            <ul className="grid max-w-md grid-cols-2 gap-2 rounded-lg bg-slate-100 p-4 font-mono dark:bg-slate-800">
              {recoveryCodes.map((code) => <li key={code}>{code}</li>)}
            </ul>
            <button
              type="button"
              className="rounded-lg bg-gdc-primary px-4 py-2 font-semibold text-white"
              onClick={() => setRecoveryCodes(null)}
            >
              I have saved the recovery codes
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
