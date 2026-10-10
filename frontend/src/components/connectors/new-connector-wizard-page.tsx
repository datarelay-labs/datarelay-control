import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { CurlImportDraft } from '../../api/gdcBackup'
import { createConnector, type ConnectorWritePayload } from '../../api/gdcConnectors'
import {
  navigateToConnectorWizardWithDraft,
  navigateToStreamWizardWithDraft,
  type HttpImportWizardLocationState,
} from '../../utils/httpImportDraft'
import { CurlImportPanel, PostmanImportPanel } from './http-import-panel'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { DEFAULT_GENERIC_HTTP_COMMON_HEADERS } from '../../constants/genericHttpConnectorDefaults'
import { ConnectorAuthTestPanel, type AuthTestHttpMethod } from './connector-auth-test-panel'
import { AuthHealthCheckFields } from './auth-health-check-fields'
import { connectorWritePayloadToInlineFlatSource } from './connector-write-to-inline-flat'
import { GenericHttpAuthFields, type AuthType } from './generic-http-auth-fields'
import { GenericHttpCommonHeadersEditor } from './generic-http-common-headers-editor'
import { S3ConnectorFields } from './s3-connector-fields'
import { DatabaseConnectorFields } from './database-connector-fields'
import { RemoteFileConnectorFields } from './remote-file-connector-fields'
import { WebhookReceiverFields } from './webhook-receiver-fields'

export function NewConnectorWizardPage({
  onCreated,
  onCancel,
  onBusyChange,
}: {
  /** Contextual creation keeps the owning Wizard and all in-memory inputs mounted. */
  onCreated?: (connectorId: number) => void
  onCancel?: () => void
  /** Lets a contextual parent guard navigation until the create request settles. */
  onBusyChange?: (busy: boolean) => void
} = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectorWritePayload>({
    name: '',
    description: '',
    source_type: 'HTTP_API_POLLING',
    base_url: '',
    verify_ssl: true,
    http_proxy: '',
    common_headers: { ...DEFAULT_GENERIC_HTTP_COMMON_HEADERS },
    auth_type: 'no_auth',
    status: 'STOPPED',
    auth_health_check_interval: 'disabled',
    endpoint_url: '',
    bucket: '',
    region: 'us-east-1',
    prefix: '',
    access_key: '',
    secret_key: '',
    object_key_pattern: '',
    path_style_access: true,
    use_ssl: false,
    db_type: 'POSTGRESQL',
    host: '',
    database: '',
    port: undefined as number | undefined,
    db_username: '',
    db_password: '',
    ssl_mode: 'PREFER',
    connection_timeout_seconds: 15,
    remote_username: '',
    remote_password: '',
    remote_file_protocol: 'sftp',
    remote_private_key: '',
    remote_private_key_passphrase: '',
    known_hosts_policy: 'strict',
    known_hosts_text: '',
    webhook_auth_mode: 'no_auth',
    webhook_auth_header_name: 'X-GDC-Webhook-Secret',
    max_request_bytes: 1048576,
    payload_preview: '',
  })
  const isS3 = (form.source_type ?? 'HTTP_API_POLLING') === 'S3_OBJECT_POLLING'
  const isDb = (form.source_type ?? 'HTTP_API_POLLING') === 'DATABASE_QUERY'
  const isRemote = (form.source_type ?? 'HTTP_API_POLLING') === 'REMOTE_FILE_POLLING'
  const isWebhook = (form.source_type ?? 'HTTP_API_POLLING') === 'WEBHOOK_RECEIVER'
  const isHttp = !isS3 && !isDb && !isRemote && !isWebhook
  const authType = (form.auth_type ?? 'no_auth') as AuthType
  const prevAuthRef = useRef<AuthType>('no_auth')
  const curlHydratedRef = useRef(false)
  const pendingStreamDraftRef = useRef<CurlImportDraft['stream'] | null>(null)

  useEffect(() => {
    if (curlHydratedRef.current) return
    const state = (location.state ?? {}) as HttpImportWizardLocationState
    const draft = state.curlDraft
    if (!draft || typeof draft !== 'object') return
    curlHydratedRef.current = true
    setForm((prev) => ({
      ...prev,
      ...(draft as ConnectorWritePayload),
      status: 'STOPPED',
      common_headers: {
        ...DEFAULT_GENERIC_HTTP_COMMON_HEADERS,
        ...((draft.common_headers as Record<string, string> | undefined) ?? {}),
      },
    }))
    pendingStreamDraftRef.current = state.streamDraft ?? null
    if (state.streamDraft?.name) {
      setSuccess(`Stream draft "${state.streamDraft.name}" ready — save the connector, then continue to the stream wizard.`)
    } else {
      setSuccess('Connector fields loaded from import draft. Enter any secrets before saving.')
    }
  }, [location.state])

  const onApproveImport = useCallback(
    (draft: CurlImportDraft) => {
      navigateToConnectorWizardWithDraft(navigate, draft)
    },
    [navigate],
  )

  useEffect(() => {
    const prev = prevAuthRef.current
    prevAuthRef.current = authType
    if (authType !== 'vendor_jwt_exchange' || prev === 'vendor_jwt_exchange') return
    setForm((f) => ({
      ...f,
      token_url: f.token_url?.trim() || '/connect/api/v1/access_token',
      token_method: f.token_method || 'POST',
      token_auth_mode: f.token_auth_mode || 'basic_user_api_key',
      token_body_mode: f.token_body_mode || 'empty',
      token_path: f.token_path || '$.access_token',
      access_token_injection: f.access_token_injection || 'bearer_authorization',
    }))
  }, [authType])

  const buildAuthTestPayload = useCallback(
    (ctx: { method: AuthTestHttpMethod; testPath: string; jsonBody: unknown | undefined }) => {
      if (isS3) {
        if (!(form.endpoint_url ?? '').trim() || !(form.bucket ?? '').trim()) {
          throw new Error('Endpoint URL and bucket are required before running an S3 connectivity test.')
        }
        if (!(form.access_key ?? '').trim() || !(form.secret_key ?? '').trim()) {
          throw new Error('Access key and secret key are required before running an S3 connectivity test.')
        }
      } else if (isDb) {
        if (!(form.host ?? '').trim() || !(form.database ?? '').trim()) {
          throw new Error('Database host and database name are required before running a database connectivity test.')
        }
        if (!(form.db_username ?? '').trim() || !(form.db_password ?? '').trim()) {
          throw new Error('Database username and password are required before running a database connectivity test.')
        }
      } else if (isRemote) {
        if (!(form.host ?? '').trim() || !(form.remote_username ?? '').trim()) {
          throw new Error('Host and username are required before running a remote file connectivity test.')
        }
        const pw = String(form.remote_password ?? '').trim()
        const pk = String(form.remote_private_key ?? '').trim()
        if (!pw && !pk) {
          throw new Error('Password or private key is required before running a remote file connectivity test.')
        }
      } else if (!(form.base_url ?? form.host ?? '').trim()) {
        throw new Error('Host / Base URL is required before running an auth test.')
      }
      return {
        inline_flat_source: connectorWritePayloadToInlineFlatSource(form),
        method: ctx.method,
        test_path: ctx.testPath,
        json_body: ctx.jsonBody,
      }
    },
    [form, isS3, isDb, isRemote],
  )

  function set<K extends keyof ConnectorWritePayload>(key: K, value: ConnectorWritePayload[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function setSourceKind(next: 'HTTP_API_POLLING' | 'S3_OBJECT_POLLING' | 'DATABASE_QUERY' | 'REMOTE_FILE_POLLING' | 'WEBHOOK_RECEIVER') {
    setForm((prev) => {
      if (next === 'S3_OBJECT_POLLING') {
        return {
          ...prev,
          source_type: 'S3_OBJECT_POLLING',
          auth_type: 'no_auth',
          connector_type: 's3_compatible',
          path_style_access: true,
          use_ssl: false,
          region: prev.region?.trim() || 'us-east-1',
        }
      }
      if (next === 'DATABASE_QUERY') {
        return {
          ...prev,
          source_type: 'DATABASE_QUERY',
          auth_type: 'no_auth',
          connector_type: 'relational_database',
          db_type: prev.db_type ?? 'POSTGRESQL',
          ssl_mode: prev.ssl_mode ?? 'PREFER',
          connection_timeout_seconds: prev.connection_timeout_seconds ?? 15,
        }
      }
      if (next === 'REMOTE_FILE_POLLING') {
        return {
          ...prev,
          source_type: 'REMOTE_FILE_POLLING',
          auth_type: 'no_auth',
          connector_type: 'remote_file',
          remote_file_protocol: prev.remote_file_protocol ?? 'sftp',
          known_hosts_policy: prev.known_hosts_policy ?? 'strict',
          connection_timeout_seconds: prev.connection_timeout_seconds ?? 30,
          port: prev.port ?? 22,
        }
      }
      if (next === 'WEBHOOK_RECEIVER') {
        return {
          ...prev,
          source_type: 'WEBHOOK_RECEIVER',
          auth_type: 'no_auth',
          connector_type: 'webhook_receiver',
          webhook_auth_mode: prev.webhook_auth_mode ?? 'no_auth',
          webhook_auth_header_name: prev.webhook_auth_header_name ?? 'X-GDC-Webhook-Secret',
          max_request_bytes: prev.max_request_bytes ?? 1048576,
        }
      }
      return {
        ...prev,
        source_type: 'HTTP_API_POLLING',
        connector_type: 'generic_http',
        auth_type: 'no_auth',
      }
    })
  }

  function validate(): string | null {
    if (!form.name?.trim()) return 'Connector name is required.'
    if (isS3) {
      if (!(form.endpoint_url ?? '').trim()) return 'Endpoint URL is required.'
      if (!(form.bucket ?? '').trim()) return 'Bucket is required.'
      if (!(form.access_key ?? '').trim()) return 'Access key is required.'
      if (!(form.secret_key ?? '').trim()) return 'Secret key is required.'
      if (form.auth_type !== 'no_auth') return 'S3 connectors must use auth_type no_auth.'
      return null
    }
    if (isDb) {
      if (!(form.host ?? '').trim()) return 'Database host is required.'
      if (!(form.database ?? '').trim()) return 'Database name is required.'
      if (!(form.db_username ?? '').trim()) return 'Database username is required.'
      if (!(form.db_password ?? '').trim()) return 'Database password is required.'
      if (form.auth_type !== 'no_auth') return 'Database connectors must use auth_type no_auth.'
      return null
    }
    if (isRemote) {
      if (!(form.host ?? '').trim()) return 'Host is required.'
      if (!(form.remote_username ?? '').trim()) return 'Username is required.'
      const pw = String(form.remote_password ?? '').trim()
      const pk = String(form.remote_private_key ?? '').trim()
      if (!pw && !pk) return 'Password or private key is required.'
      if (form.auth_type !== 'no_auth') return 'Remote file connectors must use auth_type no_auth.'
      return null
    }
    if (isWebhook) {
      if (form.auth_type !== 'no_auth') return 'Webhook receiver connectors must use auth_type no_auth.'
      const mode = String(form.webhook_auth_mode ?? 'no_auth')
      if (mode === 'shared_secret_header' && !String(form.webhook_shared_secret ?? '').trim()) {
        return 'Shared secret is required for shared secret header mode.'
      }
      if (mode === 'bearer_token' && !String(form.webhook_bearer_token ?? '').trim()) {
        return 'Bearer token is required for bearer token mode.'
      }
      return null
    }
    if (!(form.base_url ?? form.host)?.trim()) return 'Host / Base URL is required.'
    if (!form.auth_type) return 'Authentication type is required.'
    if (authType === 'basic' && (!form.basic_username?.trim() || !form.basic_password?.trim())) return 'Basic auth requires username and password.'
    if (authType === 'bearer' && !form.bearer_token?.trim()) return 'Bearer token is required.'
    if (authType === 'api_key') {
      if (!form.api_key_name?.trim() || !form.api_key_value?.trim()) return 'API key name and value are required.'
      if (!form.api_key_location || !['headers', 'query_params'].includes(form.api_key_location)) return 'API key location must be headers or query_params.'
    }
    if (authType === 'oauth2_client_credentials') {
      if (!form.oauth2_client_id?.trim() || !form.oauth2_client_secret?.trim() || !form.oauth2_token_url?.trim()) {
        return 'OAuth2 client ID, client secret, and token URL are required.'
      }
    }
    if (authType === 'session_login') {
      if (!form.login_username?.trim() || !form.login_password?.trim()) return 'Session login requires username and password.'
      if (!(form.login_url ?? form.login_path)?.trim())
        return 'Session login requires a login base URL or endpoint path.'
    }
    if (authType === 'jwt_refresh_token') {
      if (!form.refresh_token?.trim()) return 'Refresh token is required.'
      if (!(form.token_url ?? form.token_path)?.trim()) return 'Token URL or path is required.'
    }
    if (authType === 'vendor_jwt_exchange') {
      if (!form.user_id?.trim() || !form.api_key?.trim() || !form.token_url?.trim()) {
        return 'Vendor JWT exchange requires user ID, API key, and token URL.'
      }
    }
    return null
  }

  async function onSubmit() {
    const msg = validate()
    if (msg) {
      setError(msg)
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const created = await createConnector({
        ...form,
        connector_type: isS3
          ? 's3_compatible'
          : isDb
            ? 'relational_database'
            : isRemote
              ? 'remote_file'
              : isWebhook
                ? 'webhook_receiver'
                : 'generic_http',
        auth_type: isS3 || isDb || isRemote || isWebhook ? 'no_auth' : form.auth_type,
      })
      if (!Number.isSafeInteger(created.id) || created.id <= 0) {
        throw new Error(
          'Connector creation response could not be verified. Check the Connector catalog before attempting another save.',
        )
      }
      if (onCreated) {
        onCreated(created.id)
        return
      }
      const streamDraft = pendingStreamDraftRef.current
      if (streamDraft && isHttp) {
        navigateToStreamWizardWithDraft(navigate, created.id, streamDraft)
        return
      }
      setSuccess('Connector saved.')
      navigate(`/connectors/${created.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col items-stretch gap-4">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Create Connector</h2>
      <p className={cn('text-[12px]', gdcUi.textMuted)}>
        Start from scratch, or import an HTTP request from cURL or Postman to prefill a draft (stream stays disabled until you save).
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <CurlImportPanel onApprove={onApproveImport} />
        <PostmanImportPanel onApprove={onApproveImport} />
      </div>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[12px] text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/35 dark:text-emerald-200">{success}</p>
      ) : null}

      <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
        <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Source type</h3>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input
              type="radio"
              name="src-kind"
              checked={isHttp}
              onChange={() => setSourceKind('HTTP_API_POLLING')}
            />
            HTTP API Polling
          </label>
          <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input type="radio" name="src-kind" checked={isS3} onChange={() => setSourceKind('S3_OBJECT_POLLING')} />
            S3 Object Polling (MinIO / AWS-compatible)
          </label>
          <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input
              type="radio"
              name="src-kind"
              checked={isDb}
              onChange={() => setSourceKind('DATABASE_QUERY')}
            />
            Database query (PostgreSQL)
          </label>
          <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input
              type="radio"
              name="src-kind"
              checked={isRemote}
              onChange={() => setSourceKind('REMOTE_FILE_POLLING')}
            />
            Remote file polling (SFTP / SFTP-compatible SCP mode)
          </label>
          <label className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
            <input
              type="radio"
              name="src-kind"
              checked={isWebhook}
              onChange={() => setSourceKind('WEBHOOK_RECEIVER')}
            />
            Webhook Receiver
          </label>
        </div>
      </section>

      <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
        <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Basic Information</h3>
        <div className="grid w-full min-w-0 gap-2 md:grid-cols-2">
          <input
            aria-label="Connector Name *"
            placeholder="Connector Name *"
            value={form.name ?? ''}
            onChange={(e) => set('name', e.target.value)}
            className={cn('h-9 w-full', gdcUi.input)}
          />
          {!isS3 && !isDb && !isRemote && !isWebhook ? (
            <input
              aria-label="Host / Base URL *"
              placeholder="Host / Base URL *"
              value={form.base_url ?? ''}
              onChange={(e) => set('base_url', e.target.value)}
              className={cn('h-9 w-full', gdcUi.input)}
            />
          ) : isDb ? (
            <input
              aria-label="Database host *"
              placeholder="Database host *"
              value={form.host ?? ''}
              onChange={(e) => set('host', e.target.value)}
              className={cn('h-9 w-full', gdcUi.input)}
            />
          ) : isRemote ? (
            <div className="text-[11px] leading-relaxed text-slate-500 dark:text-gdc-muted md:col-span-1">
              SSH host and credentials are configured in the <span className="font-semibold">Remote connection</span> section below.
            </div>
          ) : isWebhook ? (
            <div className="text-[11px] leading-relaxed text-slate-500 dark:text-gdc-muted md:col-span-1">
              Receiver URL and authentication are configured below.
            </div>
          ) : (
            <div className="text-[11px] leading-relaxed text-slate-500 dark:text-gdc-muted md:col-span-1">
              S3 connectors use <span className="font-semibold">Endpoint URL</span> in the section below instead of HTTP base URL.
            </div>
          )}
          <input
            aria-label="Description"
            placeholder="Description"
            value={form.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
            className={cn('h-9 w-full md:col-span-2', gdcUi.input)}
          />
        </div>
      </section>

      {isS3 ? (
        <S3ConnectorFields form={form} set={set} />
      ) : isDb ? (
        <DatabaseConnectorFields form={form} set={set} />
      ) : isRemote ? (
        <RemoteFileConnectorFields
          form={form}
          set={set}
          passwordConfigured={false}
          privateKeyConfigured={false}
          passphraseConfigured={false}
        />
      ) : isWebhook ? (
        <WebhookReceiverFields form={form} set={set} />
      ) : (
        <>
          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Connection Options</h3>
            <div className="grid w-full min-w-0 gap-2 md:grid-cols-2">
              <label className={cn('flex items-center gap-2 text-sm', gdcUi.textTitle)}>
                <input type="checkbox" checked={Boolean(form.verify_ssl)} onChange={(e) => set('verify_ssl', e.target.checked)} />
                Verify SSL
              </label>
              <input
                aria-label="HTTP Proxy"
                placeholder="HTTP Proxy"
                value={form.http_proxy ?? ''}
                onChange={(e) => set('http_proxy', e.target.value)}
                className={cn('h-9 w-full', gdcUi.input)}
              />
            </div>
          </section>

          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Common Headers</h3>
            <p className={cn('mb-2 text-[11px]', gdcUi.textMuted)}>
              Defaults match typical JSON APIs (Accept / Content-Type). Edit or remove as needed. Use{' '}
              <span className="font-semibold">Auth Test Request</span> below to verify headers against your API.
            </p>
            <GenericHttpCommonHeadersEditor value={form.common_headers ?? {}} onChange={(next) => set('common_headers', next)} />
          </section>

          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Authentication</h3>
            <GenericHttpAuthFields form={form} authType={authType} set={set} />
          </section>
        </>
      )}

      <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
        <AuthHealthCheckFields
          value={form.auth_health_check_interval}
          onChange={(v) => set('auth_health_check_interval', v)}
        />
      </section>

      <ConnectorAuthTestPanel
        buildAuthTestPayload={buildAuthTestPayload}
        onTestStart={() => setError(null)}
        mode={isS3 ? 's3' : isDb ? 'database' : isRemote ? 'remote_file' : 'http'}
      />

      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => onCancel ? onCancel() : navigate('/connectors')} className={cn('h-9 px-3', gdcUi.secondaryBtn)}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void onSubmit()} className={cn('h-9 px-3', gdcUi.primaryBtn)}>
          {busy ? 'Saving...' : 'Save Connector'}
        </button>
      </div>
    </div>
  )
}
