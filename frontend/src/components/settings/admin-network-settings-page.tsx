import { AlertTriangle, CheckCircle2, ChevronDown, Globe2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getAdminNetworkSettings,
  getAuthWhoAmI,
  postAdminNetworkSettingsApply,
  putAdminNetworkSettings,
  type NetworkSettingsApplyDto,
  type NetworkSettingsDto,
  type NetworkSettingsSaveDto,
} from '../../api/gdcAdmin'
import { gdcUi, isAdminUiReadOnly, readAdminUiRole } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

type Draft = {
  http_port: string
  https_port: string
}

type FieldErrors = Partial<Record<keyof Draft, string>>
type ApplyInterruption = {
  message: string
  httpUrl: string
  httpsUrl: string
}

function validatePortField(label: string, value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return `${label} is required.`
  if (!/^\d+$/.test(trimmed)) return `${label} must contain numbers only.`
  const port = Number(trimmed)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `${label} must be a valid TCP port between 1 and 65535.`
  }
  return null
}

export function validateNetworkPortDraft(draft: Draft): { errors: FieldErrors; formError: string | null } {
  const errors: FieldErrors = {}
  const httpError = validatePortField('HTTP Port', draft.http_port)
  const httpsError = validatePortField('HTTPS Port', draft.https_port)
  if (httpError) errors.http_port = httpError
  if (httpsError) errors.https_port = httpsError

  const formError =
    !httpError && !httpsError && Number(draft.http_port.trim()) === Number(draft.https_port.trim())
      ? 'HTTP Port and HTTPS Port cannot match.'
      : null
  return { errors, formError }
}

function cleanApiError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/^\d+:\s+(?:\[[^\]]+\]\s*)?/, '')
}

function envLineFromDraft(draft: Draft, key: 'GDC_HTTP_PORT' | 'GDC_HTTPS_PORT'): string {
  const value = key === 'GDC_HTTP_PORT' ? draft.http_port.trim() : draft.https_port.trim()
  return `${key}=${value || '—'}`
}

function reconnectUrls(draft: Draft): { httpUrl: string; httpsUrl: string } {
  const host = window.location.hostname || 'localhost'
  return {
    httpUrl: `http://${host}:${draft.http_port.trim()}`,
    httpsUrl: `https://${host}:${draft.https_port.trim()}`,
  }
}

function isApplyNetworkInterruption(e: unknown): boolean {
  if (e instanceof TypeError) return true
  const message = e instanceof Error ? e.message : String(e)
  return /failed to fetch|networkerror|load failed|connection.*(reset|closed|aborted)/i.test(message)
}

function workflowStepClass(active: boolean, complete: boolean): string {
  if (complete) {
    return 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-900 dark:border-emerald-500/35 dark:bg-emerald-500/12 dark:text-emerald-100'
  }
  if (active) {
    return 'border-sky-500/30 bg-sky-500/[0.08] text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/12 dark:text-sky-100'
  }
  return 'border-slate-200/90 bg-slate-50/80 text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-muted'
}

export function AdminNetworkSettingsPage() {
  const [settings, setSettings] = useState<NetworkSettingsDto | null>(null)
  const [draft, setDraft] = useState<Draft>({ http_port: '', https_port: '' })
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saveResult, setSaveResult] = useState<NetworkSettingsSaveDto | null>(null)
  const [applyResult, setApplyResult] = useState<NetworkSettingsApplyDto | null>(null)
  const [applyInterruption, setApplyInterruption] = useState<ApplyInterruption | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [backendRole, setBackendRole] = useState<import('../../auth/session').SessionRole | null>(readAdminUiRole())

  const readOnly = isAdminUiReadOnly() || backendRole !== 'ADMINISTRATOR'
  const sectionStepLabel = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'
  const fieldLabel = 'text-sm font-medium text-slate-700 dark:text-slate-200'
  const fieldHint = 'mt-1 text-xs leading-relaxed text-slate-500 dark:text-gdc-muted'

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [network, who] = await Promise.all([getAdminNetworkSettings(), getAuthWhoAmI().catch(() => null)])
      setSettings(network)
      setDraft({ http_port: String(network.http_port), https_port: String(network.https_port) })
      setSaveResult(null)
      setApplyResult(null)
      setApplyInterruption(null)
      if (who && (who.role === 'ADMINISTRATOR' || who.role === 'OPERATOR' || who.role === 'VIEWER')) {
        setBackendRole(who.role)
      }
    } catch (e) {
      setLoadError(cleanApiError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = useMemo(() => {
    if (!settings) return false
    return draft.http_port.trim() !== String(settings.http_port) || draft.https_port.trim() !== String(settings.https_port)
  }, [draft, settings])

  const onSave = async () => {
    setSubmitError(null)
    setFieldErrors({})
    setSaveResult(null)
    setApplyResult(null)
    setApplyInterruption(null)
    const validation = validateNetworkPortDraft(draft)
    setFieldErrors(validation.errors)
    if (validation.formError) {
      setSubmitError(validation.formError)
      return
    }
    if (Object.keys(validation.errors).length > 0) return
    if (readOnly) return

    setSaving(true)
    try {
      const result = await putAdminNetworkSettings({
        http_port: Number(draft.http_port.trim()),
        https_port: Number(draft.https_port.trim()),
      })
      setSettings(result)
      setDraft({ http_port: String(result.http_port), https_port: String(result.https_port) })
      setSaveResult(result)
    } catch (e) {
      setSubmitError(cleanApiError(e))
    } finally {
      setSaving(false)
    }
  }

  const onApply = async () => {
    setSubmitError(null)
    setApplyResult(null)
    setApplyInterruption(null)
    if (readOnly) return

    setApplying(true)
    try {
      const result = await postAdminNetworkSettingsApply()
      setApplyResult(result)
    } catch (e) {
      if (isApplyNetworkInterruption(e)) {
        setApplyInterruption({
          message:
            'The reverse proxy may have restarted and interrupted this browser request. Check the configured port and reconnect.',
          ...reconnectUrls(draft),
        })
      } else {
        setSubmitError(cleanApiError(e))
      }
    } finally {
      setApplying(false)
    }
  }

  const saveComplete = Boolean(saveResult)
  const applyComplete = Boolean(applyResult?.success || applyInterruption)
  const reconnectComplete = Boolean(
    (applyResult?.success && !applyInterruption) || applyInterruption,
  )
  const activeStep = applying ? 2 : saveComplete && !applyComplete ? 2 : dirty || !saveComplete ? 1 : 3

  return (
    <div className="flex w-full min-w-0 flex-col gap-6" data-testid="admin-network-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="admin-network-heading" className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Network / Reverse Proxy Settings
          </h2>
          <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
            Review the published browser ports, save the desired values, then apply the reverse-proxy change and reconnect
            if the browser session moves to a new port.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving || applying}
          className={cn(gdcUi.secondaryBtn, (loading || saving || applying) && 'cursor-not-allowed opacity-60')}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      {readOnly ? (
        <div
          role="status"
          data-testid="admin-network-readonly"
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Administrator role is required to save reverse-proxy network settings.
        </div>
      ) : null}

      {loadError ? (
        <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-900 dark:text-red-100/90">
          Could not load network settings: {loadError}
        </div>
      ) : null}

      {submitError ? (
        <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-sm text-red-900 dark:text-red-100/90">
          {submitError}
        </div>
      ) : null}

      {applying ? (
        <div
          role="status"
          className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-sm text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
        >
          Applying reverse-proxy change...
        </div>
      ) : null}

      <ol
        data-testid="admin-network-workflow"
        className="grid gap-2 sm:grid-cols-3"
        aria-label="Save, apply, and reconnect workflow"
      >
        {[
          { step: 1, title: 'Save ports', detail: 'Persist database and .env values' },
          { step: 2, title: 'Apply reverse proxy', detail: 'Recreate reverse-proxy only' },
          { step: 3, title: 'Reconnect / result', detail: 'Confirm access on published ports' },
        ].map((item) => (
          <li
            key={item.step}
            className={cn(
              'rounded-xl border px-3 py-3 text-sm',
              workflowStepClass(
                activeStep === item.step,
                item.step === 1 ? saveComplete : item.step === 2 ? applyComplete : reconnectComplete,
              ),
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-wide opacity-80">Step {item.step}</p>
            <p className="mt-1 font-semibold">{item.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed opacity-90">{item.detail}</p>
          </li>
        ))}
      </ol>

      <section className={cn(gdcUi.cardShell, 'overflow-hidden')} aria-labelledby="network-settings-heading">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-500/[0.07] text-violet-700 dark:border-gdc-primary/35 dark:bg-gdc-primary/15 dark:text-violet-100">
              <Globe2 className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h3 id="network-settings-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
                Published reverse-proxy ports
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Defaults are HTTP 18080 and HTTPS 18443. The backend validates duplicate, reserved, and out-of-range ports.
              </p>
            </div>
          </div>
          <span className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:border-gdc-border dark:text-gdc-muted">
            Browser apply supported
          </span>
        </div>

        <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
          <div data-testid="admin-network-current-state" className="space-y-3">
            <p className={sectionStepLabel}>Current state</p>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { term: 'Saved HTTP port', detail: settings ? String(settings.http_port) : '—' },
                { term: 'Saved HTTPS port', detail: settings ? String(settings.https_port) : '—' },
                {
                  term: 'Restart required',
                  detail: settings?.restart_required || saveResult?.restart_required ? 'Yes' : 'No',
                },
                {
                  term: 'Draft vs saved',
                  detail: dirty ? 'Unsaved changes' : 'In sync',
                },
              ].map((item) => (
                <div key={item.term} className={cn('rounded-xl px-3 py-3', gdcUi.innerWell)}>
                  <dt className="text-xs font-medium text-slate-500 dark:text-gdc-muted">{item.term}</dt>
                  <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div data-testid="admin-network-configuration" className="space-y-4 border-t border-slate-100 pt-6 dark:border-gdc-border">
            <div>
              <p className={sectionStepLabel}>Configuration</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">
                Edit the published ports, save, then apply. Saving alone does not recreate the reverse-proxy container.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className={fieldLabel} htmlFor="network-http-port">
                  HTTP Port
                </label>
                <p className={fieldHint}>Browser HTTP listener published by nginx.</p>
                <input
                  id="network-http-port"
                  inputMode="numeric"
                  className={cn('mt-1.5 w-full', gdcUi.input, fieldErrors.http_port && 'border-red-400 focus:border-red-500')}
                  disabled={loading || applying || readOnly}
                  value={draft.http_port}
                  onChange={(e) => setDraft((d) => ({ ...d, http_port: e.target.value }))}
                />
                {fieldErrors.http_port ? (
                  <p className="mt-1 text-sm text-red-700 dark:text-red-200">{fieldErrors.http_port}</p>
                ) : null}
              </div>

              <div>
                <label className={fieldLabel} htmlFor="network-https-port">
                  HTTPS Port
                </label>
                <p className={fieldHint}>Browser HTTPS listener published by nginx.</p>
                <input
                  id="network-https-port"
                  inputMode="numeric"
                  className={cn('mt-1.5 w-full', gdcUi.input, fieldErrors.https_port && 'border-red-400 focus:border-red-500')}
                  disabled={loading || applying || readOnly}
                  value={draft.https_port}
                  onChange={(e) => setDraft((d) => ({ ...d, https_port: e.target.value }))}
                />
                {fieldErrors.https_port ? (
                  <p className="mt-1 text-sm text-red-700 dark:text-red-200">{fieldErrors.https_port}</p>
                ) : null}
              </div>
            </div>

            <div
              className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-4 text-sm leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100"
              data-testid="admin-network-safeguards"
            >
              <p className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                Apply required after saving
              </p>
              <p className="mt-2">
                The platform keeps serving on currently active published ports until the reverse-proxy container is
                recreated. After apply, reconnect using the newly configured HTTP or HTTPS port if this browser session
                disconnects.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="admin-network-save"
                disabled={loading || saving || applying || readOnly || !dirty}
                onClick={() => void onSave()}
                className={cn(
                  gdcUi.primaryBtn,
                  (loading || saving || applying || readOnly || !dirty) && 'cursor-not-allowed opacity-55',
                )}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                data-testid="admin-network-apply"
                disabled={loading || saving || applying || readOnly}
                onClick={() => void onApply()}
                className={cn(
                  gdcUi.secondaryBtn,
                  (loading || saving || applying || readOnly) && 'cursor-not-allowed opacity-55',
                )}
              >
                {applying ? 'Applying…' : 'Apply reverse-proxy change'}
              </button>
            </div>

            <details className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section/60">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
                Environment values (.env)
              </summary>
              <pre
                data-testid="network-env-example"
                className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              >
                {envLineFromDraft(draft, 'GDC_HTTP_PORT')}
                {'\n'}
                {envLineFromDraft(draft, 'GDC_HTTPS_PORT')}
              </pre>
            </details>
          </div>
        </div>
      </section>

      {saveResult ? (
        <section
          className={cn(gdcUi.cardShell, 'border-emerald-500/25 p-4 dark:border-emerald-500/30 md:p-6')}
          aria-labelledby="network-save-result-heading"
          data-testid="admin-network-save-result"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3
                id="network-save-result-heading"
                className="flex items-center gap-2 text-base font-semibold text-emerald-900 dark:text-emerald-100"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                Network settings saved
              </h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">{saveResult.message}</p>
            </div>
            {saveResult.restart_required ? (
              <span className="rounded border border-amber-500/35 bg-amber-500/12 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:text-amber-100">
                Restart required
              </span>
            ) : null}
          </div>

          <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3 text-sm leading-relaxed text-amber-950 dark:border-amber-500/35 dark:bg-amber-500/10 dark:text-amber-100">
            Next: click Apply reverse-proxy change to recreate the reverse-proxy container. Reconnect using HTTP{' '}
            {saveResult.http_port} or HTTPS {saveResult.https_port} if the browser disconnects.
          </p>
        </section>
      ) : null}

      {applyResult ? (
        <section
          className={cn(
            gdcUi.cardShell,
            applyResult.success
              ? 'border-emerald-500/25 p-4 dark:border-emerald-500/30 md:p-6'
              : 'border-red-500/25 p-4 dark:border-red-500/30 md:p-6',
          )}
          aria-labelledby="network-apply-result-heading"
          data-testid="admin-network-apply-result"
        >
          <h3
            id="network-apply-result-heading"
            className={cn(
              'flex items-center gap-2 text-base font-semibold',
              applyResult.success ? 'text-emerald-900 dark:text-emerald-100' : 'text-red-900 dark:text-red-100',
            )}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {applyResult.success ? 'Reverse proxy applied' : 'Reverse proxy apply failed'}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">{applyResult.message}</p>
          <details className="mt-4 rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 dark:border-gdc-border dark:bg-gdc-section/60">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <ChevronDown className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
              Command and output
            </summary>
            <div className="mt-3 space-y-2 text-sm">
              <p className="font-mono text-xs text-slate-600 dark:text-gdc-muted" data-testid="admin-network-apply-command">
                {applyResult.command} exited with {applyResult.exit_code}
              </p>
              {applyResult.stdout || applyResult.stderr ? (
                <pre
                  data-testid="admin-network-apply-output"
                  className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                >
                  {applyResult.stdout}
                  {applyResult.stderr ? `\n${applyResult.stderr}` : ''}
                </pre>
              ) : null}
            </div>
          </details>
        </section>
      ) : null}

      {applyInterruption ? (
        <section
          className={cn(gdcUi.cardShell, 'border-amber-500/25 p-4 dark:border-amber-500/30 md:p-6')}
          aria-labelledby="network-apply-interrupted-heading"
          data-testid="admin-network-apply-interrupted"
        >
          <h3
            id="network-apply-interrupted-heading"
            className="flex items-center gap-2 text-base font-semibold text-amber-950 dark:text-amber-100"
          >
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Reverse proxy request interrupted
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-gdc-muted">{applyInterruption.message}</p>
          <div className={cn('mt-4 rounded-xl border p-4 text-sm', gdcUi.innerWell)}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
              Reconnect URLs
            </p>
            <div className="mt-2 space-y-1 font-mono text-sm text-slate-800 dark:text-slate-100">
              <p>{applyInterruption.httpUrl}</p>
              <p>{applyInterruption.httpsUrl}</p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
