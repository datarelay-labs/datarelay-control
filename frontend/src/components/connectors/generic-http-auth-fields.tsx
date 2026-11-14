import { useEffect, useState } from 'react'
import type { ConnectorWritePayload } from '../../api/gdcConnectors'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

/** Compact controls for this form (shared light/dark surfaces via design tokens). */
const httpField = cn('h-9 w-full', gdcUi.input)
const httpSelect = cn('h-9 w-full', gdcUi.select)
const httpSelectMb = cn('mb-2 h-9 w-full', gdcUi.select)
const httpTextarea = cn('w-full py-2 font-mono text-[12px]', gdcUi.input)
const httpTextareaMin = cn('min-h-[120px] w-full py-2 font-mono text-[12px]', gdcUi.input)

/** Default login-request headers (JSON). Override per vendor API as needed. */
export const DEFAULT_SESSION_LOGIN_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
}

/** Login request body template. Placeholders are replaced at runtime with the username and password from the form. */
export const DEFAULT_SESSION_LOGIN_BODY_TEMPLATE: Record<string, string> = {
  username: '{{username}}',
  password: '{{password}}',
}

export type AuthType =
  | 'no_auth'
  | 'basic'
  | 'bearer'
  | 'api_key'
  | 'oauth2_client_credentials'
  | 'session_login'
  | 'jwt_refresh_token'
  | 'vendor_jwt_exchange'

export const AUTH_TYPE_OPTIONS: AuthType[] = [
  'no_auth',
  'basic',
  'bearer',
  'api_key',
  'oauth2_client_credentials',
  'session_login',
  'jwt_refresh_token',
  'vendor_jwt_exchange',
]

const MASK_PLACEHOLDER = '********'

type Props = {
  form: ConnectorWritePayload
  authType: AuthType
  set: <K extends keyof ConnectorWritePayload>(key: K, value: ConnectorWritePayload[K]) => void
  configured?: Partial<
    Record<
      | 'basic_password'
      | 'bearer_token'
      | 'api_key_value'
      | 'oauth2_client_secret'
      | 'login_password'
      | 'refresh_token'
      | 'api_key'
      | 'token_body',
      boolean
    >
  >
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function isEmptyObject(obj: Record<string, unknown> | Record<string, string> | undefined): boolean {
  return !obj || Object.keys(obj).length === 0
}

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g

/** Client-side preview only: unresolved placeholders shown as [name]; password masked. */
function buildSessionLoginTemplatePreview(
  form: ConnectorWritePayload,
  loginPasswordConfigured: boolean,
): string {
  const bodyRaw = form.login_body_mode === 'form_urlencoded' || form.login_body_mode === 'raw' ? form.login_body_raw ?? '' : ''
  const hdrText = JSON.stringify(form.login_headers ?? {}, null, 2)
  const qpText = JSON.stringify(form.login_query_params ?? {}, null, 2)
  const subst = (s: string) =>
    s.replace(PLACEHOLDER_RE, (_, key: string) => {
      const k = String(key).trim()
      if (k === 'username') return form.login_username || `[${k}]`
      if (k === 'password') return loginPasswordConfigured ? '********' : `[${k}]`
      return `[${k}]`
    })
  const lines = [`login_body_raw:\n${subst(bodyRaw)}`, `login_headers:\n${subst(hdrText)}`, `login_query_params:\n${subst(qpText)}`]
  return lines.join('\n\n')
}

export function GenericHttpAuthFields({ form, authType, set, configured }: Props) {
  /** Local textarea text so invalid JSON while typing does not snap back (controlled parse-only onChange bug). */
  const [loginHeadersDraft, setLoginHeadersDraft] = useState<string | null>(null)
  const [loginBodyDraft, setLoginBodyDraft] = useState<string | null>(null)
  const [preflightHeadersDraft, setPreflightHeadersDraft] = useState<string | null>(null)
  const [loginQueryDraft, setLoginQueryDraft] = useState<string | null>(null)
  const [extractionsJsonDraft, setExtractionsJsonDraft] = useState<string | null>(null)

  useEffect(() => {
    if (authType !== 'session_login') {
      setLoginHeadersDraft(null)
      setLoginBodyDraft(null)
      setPreflightHeadersDraft(null)
      setLoginQueryDraft(null)
      setExtractionsJsonDraft(null)
      return
    }
    const lhEmpty = isEmptyObject(form.login_headers)
    const lbEmpty = isEmptyObject(form.login_body_template as Record<string, unknown> | undefined)
    if (lhEmpty) set('login_headers', { ...DEFAULT_SESSION_LOGIN_HEADERS })
    if (lbEmpty) set('login_body_template', { ...DEFAULT_SESSION_LOGIN_BODY_TEMPLATE })
    // Only seed when switching into session_login — do not depend on template/header objects or clearing `{}` re-fills defaults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authType])

  const loginHeadersDisplay =
    loginHeadersDraft !== null ? loginHeadersDraft : JSON.stringify(form.login_headers ?? {}, null, 2)
  const loginBodyDisplay =
    loginBodyDraft !== null ? loginBodyDraft : JSON.stringify(form.login_body_template ?? {}, null, 2)
  const preflightHeadersDisplay =
    preflightHeadersDraft !== null
      ? preflightHeadersDraft
      : JSON.stringify(form.preflight_headers ?? {}, null, 2)
  const loginQueryDisplay =
    loginQueryDraft !== null ? loginQueryDraft : JSON.stringify(form.login_query_params ?? {}, null, 2)
  const extractionsJsonDisplay =
    extractionsJsonDraft !== null
      ? extractionsJsonDraft
      : JSON.stringify(form.session_login_extractions ?? [], null, 2)

  const csrf = (form.csrf_extract ?? {}) as Record<string, unknown>

  return (
    <div className="w-full min-w-0 max-w-full space-y-3">
      <select aria-label="Authentication Type" value={authType} onChange={(e) => set('auth_type', e.target.value as AuthType)} className={httpSelectMb}>
        {AUTH_TYPE_OPTIONS.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      {authType === 'basic' ? (
        <div className="grid gap-2 md:grid-cols-2">
          <input aria-label="Basic Username" placeholder="Basic Username" value={form.basic_username ?? ''} onChange={(e) => set('basic_username', e.target.value)} className={httpField} />
          <input aria-label="Basic Password" type="password" placeholder={configured?.basic_password ? MASK_PLACEHOLDER : 'Basic Password'} value={form.basic_password ?? ''} onChange={(e) => set('basic_password', e.target.value)} className={httpField} />
        </div>
      ) : null}
      {authType === 'bearer' ? <input aria-label="Bearer Token" type="password" placeholder={configured?.bearer_token ? MASK_PLACEHOLDER : 'Bearer Token'} value={form.bearer_token ?? ''} onChange={(e) => set('bearer_token', e.target.value)} className={httpField} /> : null}
      {authType === 'api_key' ? (
        <div className="grid gap-2 md:grid-cols-3">
          <input aria-label="API Key Name" placeholder="API Key Name" value={form.api_key_name ?? ''} onChange={(e) => set('api_key_name', e.target.value)} className={httpField} />
          <input aria-label="API Key Value" type="password" placeholder={configured?.api_key_value ? MASK_PLACEHOLDER : 'API Key Value'} value={form.api_key_value ?? ''} onChange={(e) => set('api_key_value', e.target.value)} className={httpField} />
          <select aria-label="API Key Location" value={form.api_key_location ?? 'headers'} onChange={(e) => set('api_key_location', e.target.value as 'headers' | 'query_params')} className={httpSelect}>
            <option value="headers">headers</option>
            <option value="query_params">query_params</option>
          </select>
        </div>
      ) : null}
      {authType === 'oauth2_client_credentials' ? (
        <div className="grid gap-2 md:grid-cols-2">
          <input aria-label="OAuth2 Client ID" placeholder="OAuth2 Client ID" value={form.oauth2_client_id ?? ''} onChange={(e) => set('oauth2_client_id', e.target.value)} className={httpField} />
          <input aria-label="OAuth2 Client Secret" type="password" placeholder={configured?.oauth2_client_secret ? MASK_PLACEHOLDER : 'OAuth2 Client Secret'} value={form.oauth2_client_secret ?? ''} onChange={(e) => set('oauth2_client_secret', e.target.value)} className={httpField} />
          <input aria-label="OAuth2 Token URL" placeholder="OAuth2 Token URL" value={form.oauth2_token_url ?? ''} onChange={(e) => set('oauth2_token_url', e.target.value)} className={httpField} />
          <input aria-label="OAuth2 Scope" placeholder="OAuth2 Scope" value={form.oauth2_scope ?? ''} onChange={(e) => set('oauth2_scope', e.target.value)} className={httpField} />
        </div>
      ) : null}
      {authType === 'session_login' ? (
        <div className="grid gap-4 md:grid-cols-2">
          <input
            aria-label="Login Base URL"
            placeholder="Login Base URL (scheme + host, optional path if no endpoint path below)"
            value={form.login_url ?? ''}
            onChange={(e) => set('login_url', e.target.value)}
            className={httpField}
          />
          <input
            aria-label="Login Endpoint Path"
            placeholder="/login.html"
            value={form.login_path ?? ''}
            onChange={(e) => set('login_path', e.target.value)}
            className={httpField}
          />
          <select aria-label="Login Method" value={form.login_method ?? 'POST'} onChange={(e) => set('login_method', e.target.value)} className={httpSelect}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
          <input aria-label="Login Username" placeholder="Login Username" value={form.login_username ?? ''} onChange={(e) => set('login_username', e.target.value)} className={httpField} />
          <input aria-label="Login Password" type="password" placeholder={configured?.login_password ? MASK_PLACEHOLDER : 'Login Password'} value={form.login_password ?? ''} onChange={(e) => set('login_password', e.target.value)} className={httpField} />
          <label className="flex flex-col gap-1 md:col-span-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
            Login body mode
            <select
              aria-label="Login body mode"
              value={(form.login_body_mode ?? 'json') as string}
              onChange={(e) => {
                const v = e.target.value as ConnectorWritePayload['login_body_mode']
                set('login_body_mode', v)
                if (v === 'form_urlencoded' && !(form.login_body_raw ?? '').trim()) {
                  set('login_body_raw', 'username={{username}}&password={{password}}')
                }
              }}
              className={httpSelect}
            >
              <option value="json">json</option>
              <option value="form_urlencoded">form_urlencoded</option>
              <option value="raw">raw</option>
            </select>
          </label>
          <label className="flex flex-wrap items-center gap-2 md:col-span-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
            <input
              aria-label="Follow redirects during login"
              type="checkbox"
              checked={Boolean(form.login_allow_redirects)}
              onChange={(e) => set('login_allow_redirects', e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Follow redirects during login (leave off for Cybereason-style form login)
          </label>
          <input
            aria-label="Expected session cookie name"
            placeholder="Session cookie name (optional, e.g. JSESSIONID)"
            value={form.session_cookie_name ?? ''}
            onChange={(e) => set('session_cookie_name', e.target.value || null)}
            className={cn(httpField, 'md:col-span-2')}
          />
          {(form.login_body_mode ?? 'json') === 'form_urlencoded' ? (
            <label className="md:col-span-2 block space-y-1">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Login body (application/x-www-form-urlencoded)
              </span>
              <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                Raw template string sent as <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">data=</code>. Preserves{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">&amp;</code> and field names. Placeholders{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{username}}'}</code> and{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{password}}'}</code> are replaced at runtime.
              </p>
              <textarea
                aria-label="Form-urlencoded login body template"
                value={form.login_body_raw ?? ''}
                onChange={(e) => set('login_body_raw', e.target.value)}
                rows={4}
                className={httpTextarea}
              />
            </label>
          ) : null}
          {(form.login_body_mode ?? 'json') === 'raw' ? (
            <label className="md:col-span-2 block space-y-1">
              <span className="text-sm font-medium text-slate-800 dark:text-slate-100">Raw login body</span>
              <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                Sent as raw bytes (<code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">content=</code>). Placeholders{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{username}}'}</code> and{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{password}}'}</code> are replaced at runtime.
              </p>
              <textarea
                aria-label="Raw login body template"
                value={form.login_body_raw ?? ''}
                onChange={(e) => set('login_body_raw', e.target.value)}
                rows={4}
                className={httpTextarea}
              />
            </label>
          ) : null}
          <div className="md:col-span-2 space-y-1">
            <label htmlFor="session-login-headers-json" className="text-sm font-medium text-slate-800 dark:text-slate-100">
              Login request headers (JSON)
            </label>
            <p id="session-login-headers-hint" className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
              HTTP headers sent with the login request. Adjust keys and values to match the vendor API (e.g.{' '}
              <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">Content-Type</code>). When empty, the example below is filled in automatically.
            </p>
            <textarea
              id="session-login-headers-json"
              aria-describedby="session-login-headers-hint"
              aria-label="Login request headers JSON"
              placeholder={JSON.stringify(DEFAULT_SESSION_LOGIN_HEADERS, null, 2)}
              value={loginHeadersDisplay}
              onChange={(e) => {
                const v = e.target.value
                setLoginHeadersDraft(v)
                const parsed = parseJsonObject(v)
                if (parsed !== null) set('login_headers', parsed as Record<string, string>)
              }}
              onBlur={() => {
                if (loginHeadersDraft === null) return
                if (parseJsonObject(loginHeadersDraft) !== null) setLoginHeadersDraft(null)
              }}
              className={httpTextareaMin}
            />
          </div>
          {(form.login_body_mode ?? 'json') === 'json' ? (
            <div className="md:col-span-2 space-y-1">
              <label htmlFor="session-login-body-json" className="text-sm font-medium text-slate-800 dark:text-slate-100">
                Login request body template (JSON)
              </label>
              <p id="session-login-body-hint" className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                JSON body for the login request (e.g. POST).{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{username}}'}</code> and{' '}
                <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{password}}'}</code> are replaced at runtime with the username and password entered above. Rename fields to match the product API.
              </p>
              <textarea
                id="session-login-body-json"
                aria-describedby="session-login-body-hint"
                aria-label="Login request body template JSON"
                placeholder={JSON.stringify(DEFAULT_SESSION_LOGIN_BODY_TEMPLATE, null, 2)}
                value={loginBodyDisplay}
                onChange={(e) => {
                  const v = e.target.value
                  setLoginBodyDraft(v)
                  const parsed = parseJsonObject(v)
                  if (parsed !== null) set('login_body_template', parsed)
                }}
                onBlur={() => {
                  if (loginBodyDraft === null) return
                  if (parseJsonObject(loginBodyDraft) !== null) setLoginBodyDraft(null)
                }}
                className={httpTextareaMin}
              />
            </div>
          ) : null}
          <details className="md:col-span-2 rounded-lg border border-slate-200 dark:border-gdc-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-100">
              Session Login Advanced Options
            </summary>
            <div className="grid gap-3 border-t border-slate-200 p-3 md:grid-cols-2 dark:border-gdc-border">
              <label className="flex flex-wrap items-center gap-2 md:col-span-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
                <input
                  aria-label="Enable preflight request"
                  type="checkbox"
                  checked={Boolean(form.preflight_enabled)}
                  onChange={(e) => set('preflight_enabled', e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Enable preflight request (runs before login on the same HTTP session)
              </label>
              {form.preflight_enabled ? (
                <>
                  <select
                    aria-label="Preflight method"
                    value={(form.preflight_method ?? 'GET').toUpperCase()}
                    onChange={(e) => set('preflight_method', e.target.value)}
                    className={httpSelect}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                  </select>
                  <input
                    aria-label="Preflight path"
                    placeholder="/login (path on connector base URL)"
                    value={form.preflight_path ?? ''}
                    onChange={(e) => set('preflight_path', e.target.value || null)}
                    className={httpField}
                  />
                  <input
                    aria-label="Preflight absolute URL optional"
                    placeholder="Preflight URL (optional, overrides path)"
                    value={form.preflight_url ?? ''}
                    onChange={(e) => set('preflight_url', e.target.value || null)}
                    className={cn(httpField, 'md:col-span-2')}
                  />
                  <label className="md:col-span-2 block space-y-1">
                    <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Preflight headers (JSON)</span>
                    <textarea
                      aria-label="Preflight headers JSON"
                      value={preflightHeadersDisplay}
                      onChange={(e) => {
                        const v = e.target.value
                        setPreflightHeadersDraft(v)
                        const parsed = parseJsonObject(v)
                        if (parsed !== null) set('preflight_headers', parsed as Record<string, string>)
                      }}
                      onBlur={() => {
                        if (preflightHeadersDraft === null) return
                        if (parseJsonObject(preflightHeadersDraft) !== null) setPreflightHeadersDraft(null)
                      }}
                      rows={3}
                      className={httpTextarea}
                    />
                  </label>
                  <label className="md:col-span-2 block space-y-1">
                    <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                      Preflight body (raw; POST/PUT/PATCH only)
                    </span>
                    <textarea
                      aria-label="Preflight body raw"
                      value={form.preflight_body_raw ?? ''}
                      onChange={(e) => set('preflight_body_raw', e.target.value)}
                      rows={2}
                      className={httpTextarea}
                    />
                  </label>
                  <label className="flex flex-wrap items-center gap-2 md:col-span-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
                    <input
                      aria-label="Preflight follow redirects"
                      type="checkbox"
                      checked={Boolean(form.preflight_follow_redirects)}
                      onChange={(e) => set('preflight_follow_redirects', e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Follow redirects during preflight
                  </label>
                </>
              ) : null}

              <label className="md:col-span-2 block space-y-1">
                <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                  Login query parameters (JSON; values support {'{{placeholders}}'})
                </span>
                <textarea
                  aria-label="Login query params JSON"
                  value={loginQueryDisplay}
                  onChange={(e) => {
                    const v = e.target.value
                    setLoginQueryDraft(v)
                    const parsed = parseJsonObject(v)
                    if (parsed !== null) set('login_query_params', parsed as Record<string, string>)
                  }}
                  onBlur={() => {
                    if (loginQueryDraft === null) return
                    if (parseJsonObject(loginQueryDraft) !== null) setLoginQueryDraft(null)
                  }}
                  rows={2}
                  placeholder='{"state": "{{oauth_state}}"}'
                  className={httpTextarea}
                />
              </label>

              <label className="flex flex-wrap items-center gap-2 md:col-span-2 text-[12px] font-medium text-slate-700 dark:text-slate-200">
                <input
                  aria-label="Enable token extraction rule"
                  type="checkbox"
                  checked={Boolean(csrf.enabled)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      set('csrf_extract', {
                        enabled: true,
                        source: 'body',
                        name: 'csrf_token',
                        extraction_mode: 'regex',
                        pattern: '',
                      })
                    } else {
                      set('csrf_extract', null)
                    }
                  }}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Enable token extraction (preflight response)
              </label>
              {csrf.enabled ? (
                <>
                  <input
                    aria-label="Extraction variable name"
                    placeholder="Variable name (e.g. csrf_token)"
                    value={String(csrf.name ?? '')}
                    onChange={(e) =>
                      set('csrf_extract', {
                        ...csrf,
                        enabled: true,
                        name: e.target.value,
                      })
                    }
                    className={httpField}
                  />
                  <select
                    aria-label="Extraction source"
                    value={String(csrf.source ?? 'body')}
                    onChange={(e) =>
                      set('csrf_extract', {
                        ...csrf,
                        enabled: true,
                        source: e.target.value,
                      })
                    }
                    className={httpSelect}
                  >
                    <option value="body">body</option>
                    <option value="header">header</option>
                    <option value="cookie">cookie</option>
                  </select>
                  <select
                    aria-label="Extraction mode"
                    value={String(csrf.extraction_mode ?? 'regex')}
                    onChange={(e) =>
                      set('csrf_extract', {
                        ...csrf,
                        enabled: true,
                        extraction_mode: e.target.value,
                      })
                    }
                    className={cn(httpSelect, 'md:col-span-2')}
                  >
                    <option value="regex">regex (body)</option>
                    <option value="jsonpath">jsonpath (body)</option>
                    <option value="header_name">header_name</option>
                    <option value="cookie_name">cookie_name</option>
                  </select>
                  <label className="md:col-span-2 block space-y-1">
                    <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                      Pattern / JSONPath / header name / cookie name
                    </span>
                    <textarea
                      aria-label="Extraction pattern"
                      value={String(csrf.pattern ?? '')}
                      onChange={(e) =>
                        set('csrf_extract', {
                          ...csrf,
                          enabled: true,
                          pattern: e.target.value,
                        })
                      }
                      rows={2}
                      className={httpTextarea}
                    />
                  </label>
                </>
              ) : null}

              <label className="md:col-span-2 block space-y-1">
                <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">
                  session_login_extractions (JSON array, optional; merges with single rule above)
                </span>
                <textarea
                  aria-label="Session login extractions JSON"
                  value={extractionsJsonDisplay}
                  onChange={(e) => {
                    const v = e.target.value
                    setExtractionsJsonDraft(v)
                    try {
                      const parsed = JSON.parse(v) as unknown
                      if (Array.isArray(parsed)) set('session_login_extractions', parsed as Array<Record<string, unknown>>)
                    } catch {
                      /* keep draft */
                    }
                  }}
                  onBlur={() => {
                    if (extractionsJsonDraft === null) return
                    try {
                      const parsed = JSON.parse(extractionsJsonDraft) as unknown
                      if (Array.isArray(parsed)) setExtractionsJsonDraft(null)
                    } catch {
                      /* invalid */
                    }
                  }}
                  rows={4}
                  className={httpTextarea}
                />
              </label>

              <div className="md:col-span-2 space-y-1">
                <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Template injection preview (local)</span>
                <p className="text-[11px] leading-relaxed text-slate-600 dark:text-gdc-muted">
                  Placeholders like <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{csrf_token}}'}</code>,{' '}
                  <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{cookie.JSESSIONID}}'}</code>,{' '}
                  <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">{'{{header.X-CSRF-Token}}'}</code> resolve at runtime after preflight. Unknown keys show as{' '}
                  <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">[key]</code> here.
                </p>
                <pre
                  className={cn(
                    'max-h-[200px] overflow-auto p-2 font-mono text-[11px] leading-relaxed text-slate-800 dark:text-gdc-foreground',
                    gdcUi.innerWell,
                  )}
                >
                  {buildSessionLoginTemplatePreview(form, Boolean(configured?.login_password))}
                </pre>
              </div>
            </div>
          </details>
        </div>
      ) : null}
      {authType === 'jwt_refresh_token' ? (
        <div className="grid gap-2 md:grid-cols-2">
          <input aria-label="Refresh Token" type="password" placeholder={configured?.refresh_token ? MASK_PLACEHOLDER : 'Refresh Token'} value={form.refresh_token ?? ''} onChange={(e) => set('refresh_token', e.target.value)} className={httpField} />
          <input aria-label="Token URL" placeholder="Token URL" value={form.token_url ?? ''} onChange={(e) => set('token_url', e.target.value)} className={httpField} />
          <input aria-label="Token Path" placeholder="Token Path" value={form.token_path ?? ''} onChange={(e) => set('token_path', e.target.value)} className={httpField} />
          <input aria-label="Access Token JSONPath" placeholder="$.access_token" value={form.access_token_json_path ?? '$.access_token'} onChange={(e) => set('access_token_json_path', e.target.value)} className={httpField} />
        </div>
      ) : null}
      {authType === 'vendor_jwt_exchange' ? (
        <div className="space-y-3">
          <p className="text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            For Stellar Cyber, use POST <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">/connect/api/v1/access_token</code> with{' '}
            <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">Authorization: Basic</code> over{' '}
            <code className="rounded bg-slate-100 px-1 dark:bg-gdc-elevated">user_id:api_key</code>, no request body, and leave Token Content-Type unset unless the vendor
            requires it.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            <input aria-label="User ID" placeholder="User ID" value={form.user_id ?? ''} onChange={(e) => set('user_id', e.target.value)} className={httpField} />
            <input aria-label="API Key" type="password" placeholder={configured?.api_key ? MASK_PLACEHOLDER : 'API Key'} value={form.api_key ?? ''} onChange={(e) => set('api_key', e.target.value)} className={httpField} />
            <input
              aria-label="Token exchange URL"
              placeholder="/connect/api/v1/access_token"
              value={form.token_url ?? ''}
              onChange={(e) => set('token_url', e.target.value)}
              className={cn(httpField, 'md:col-span-2')}
            />
            <input
              aria-label="Token Path"
              placeholder="$.access_token"
              value={form.token_path ?? '$.access_token'}
              onChange={(e) => set('token_path', e.target.value)}
              className={cn(httpField, 'md:col-span-2 font-mono text-[13px]')}
            />
          </div>
          <details className="rounded-lg border border-slate-200 dark:border-gdc-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-100">Advanced Token Exchange Options</summary>
            <div className="grid gap-2 border-t border-slate-200 p-3 md:grid-cols-2 dark:border-gdc-border">
              <select aria-label="Token method" value={(form.token_method ?? 'POST').toUpperCase()} onChange={(e) => set('token_method', e.target.value)} className={httpSelect}>
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
              <select
                aria-label="Token auth mode"
                value={form.token_auth_mode ?? 'basic_user_api_key'}
                onChange={(e) => set('token_auth_mode', e.target.value)}
                className={httpSelect}
              >
                <option value="basic_user_api_key">basic_user_api_key</option>
                <option value="basic_user_password">basic_user_password</option>
                <option value="basic_client_secret">basic_client_secret</option>
                <option value="bearer">bearer</option>
                <option value="api_key_header">api_key_header</option>
                <option value="api_key_query">api_key_query</option>
                <option value="custom_headers">custom_headers</option>
                <option value="none">none</option>
              </select>
              <select
                aria-label="Token Content-Type"
                value={form.token_content_type ?? ''}
                onChange={(e) => set('token_content_type', e.target.value === '' ? null : e.target.value)}
                className={cn(httpSelect, 'md:col-span-2')}
              >
                <option value="">Default (omit header)</option>
                <option value="application/x-www-form-urlencoded">application/x-www-form-urlencoded</option>
                <option value="application/json">application/json</option>
                <option value="none">none (omit)</option>
              </select>
              <select aria-label="Token body mode" value={form.token_body_mode ?? 'empty'} onChange={(e) => set('token_body_mode', e.target.value)} className={cn(httpSelect, 'md:col-span-2')}>
                <option value="empty">empty</option>
                <option value="form">form</option>
                <option value="json">json</option>
                <option value="raw">raw</option>
              </select>
              <label className="md:col-span-2 block space-y-1">
                <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Token body</span>
                <textarea
                  aria-label="Token body"
                  disabled={(form.token_body_mode ?? 'empty') === 'empty'}
                  placeholder={configured?.token_body ? `${MASK_PLACEHOLDER} (saved)` : '{ }'}
                  value={form.token_body ?? ''}
                  onChange={(e) => set('token_body', e.target.value)}
                  rows={3}
                  className={cn(gdcUi.input, 'w-full py-1.5 font-mono text-[12px] disabled:opacity-50')}
                />
                {configured?.token_body ? (
                  <span className="block text-[11px] text-slate-500 dark:text-gdc-muted" data-testid="token-body-saved-hint">
                    The saved token body is hidden because it may contain credentials. Leave this blank to keep it, or type
                    the complete new body to replace it.
                  </span>
                ) : null}
              </label>
              <select
                aria-label="Access token injection"
                value={form.access_token_injection ?? 'bearer_authorization'}
                onChange={(e) => set('access_token_injection', e.target.value)}
                className={cn(httpSelect, 'md:col-span-2')}
              >
                <option value="bearer_authorization">bearer_authorization</option>
                <option value="custom_header">custom_header</option>
                <option value="query_param">query_param</option>
              </select>
              {(form.access_token_injection ?? 'bearer_authorization') === 'custom_header' ? (
                <>
                  <input
                    aria-label="Access token header name"
                    placeholder="Authorization"
                    value={form.access_token_header_name ?? 'Authorization'}
                    onChange={(e) => set('access_token_header_name', e.target.value)}
                    className={httpField}
                  />
                  <input
                    aria-label="Access token header prefix"
                    placeholder="Bearer"
                    value={form.access_token_header_prefix ?? 'Bearer'}
                    onChange={(e) => set('access_token_header_prefix', e.target.value)}
                    className={httpField}
                  />
                </>
              ) : null}
              {(form.access_token_injection ?? 'bearer_authorization') === 'query_param' ? (
                <input
                  aria-label="Access token query parameter name"
                  placeholder="access_token"
                  value={form.access_token_query_name ?? ''}
                  onChange={(e) => set('access_token_query_name', e.target.value)}
                  className={cn(httpField, 'md:col-span-2')}
                />
              ) : null}
              {(form.token_auth_mode ?? 'basic_user_api_key') === 'custom_headers' ? (
                <label className="md:col-span-2 block space-y-1">
                  <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Token request custom headers (JSON)</span>
                  <textarea
                    aria-label="Token custom headers JSON"
                    placeholder='{"Authorization": "Bearer …"}'
                    value={JSON.stringify(form.token_custom_headers ?? {}, null, 2)}
                    onChange={(e) => {
                      const parsed = parseJsonObject(e.target.value)
                      if (parsed) set('token_custom_headers', parsed as Record<string, string>)
                    }}
                    rows={4}
                    className={cn(gdcUi.input, 'w-full py-1.5 font-mono text-[12px]')}
                  />
                </label>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
    </div>
  )
}
