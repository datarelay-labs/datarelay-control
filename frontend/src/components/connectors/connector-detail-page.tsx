import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  buildConnectorExportPath,
  downloadBackupUrl,
  postCloneConnector,
} from '../../api/gdcBackup'
import { deleteConnector, fetchConnectorById, updateConnector, type ConnectorWritePayload } from '../../api/gdcConnectors'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'
import { ConnectorAuthTestPanel, type AuthTestHttpMethod } from './connector-auth-test-panel'
import { GenericHttpAuthFields, type AuthType } from './generic-http-auth-fields'
import { GenericHttpCommonHeadersEditor } from './generic-http-common-headers-editor'
import { S3ConnectorFields } from './s3-connector-fields'
import { DatabaseConnectorFields } from './database-connector-fields'
import { RemoteFileConnectorFields } from './remote-file-connector-fields'
import { WebhookReceiverFields } from './webhook-receiver-fields'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

type ConfiguredSecrets = Partial<
  Record<
    | 'basic_password'
    | 'bearer_token'
    | 'api_key_value'
    | 'oauth2_client_secret'
    | 'login_password'
    | 'refresh_token'
    | 'api_key'
    | 'secret_key'
    | 'db_password'
    | 'remote_password'
    | 'remote_private_key'
    | 'remote_private_key_passphrase'
    | 'webhook_shared_secret'
    | 'webhook_bearer_token',
    boolean
  >
>

export function ConnectorDetailPage() {
  const { connectorId = '' } = useParams<{ connectorId: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [form, setForm] = useState<ConnectorWritePayload | null>(null)
  const [configuredSecrets, setConfiguredSecrets] = useState<ConfiguredSecrets>({})
  const [backupBusy, setBackupBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [connectorSummary, setConnectorSummary] = useState<{ name: string; stream_count: number } | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      setLoading(true)
      const row = await fetchConnectorById(Number(connectorId))
      if (!active) return
      if (!row) {
        setError('Connector not found.')
        setLoading(false)
        return
      }
      setForm({
        name: row.name,
        description: row.description ?? '',
        base_url: row.base_url ?? row.host ?? '',
        verify_ssl: row.verify_ssl,
        http_proxy: row.http_proxy ?? '',
        common_headers: row.common_headers,
        auth_type: row.auth_type,
        status: row.status ?? 'STOPPED',
        basic_username: String(row.auth.basic_username ?? ''),
        basic_password: String(row.auth.basic_password ?? ''),
        bearer_token: String(row.auth.bearer_token ?? ''),
        api_key_name: String(row.auth.api_key_name ?? ''),
        api_key_value: String(row.auth.api_key_value ?? ''),
        api_key_location: (row.auth.api_key_location as 'headers' | 'query_params' | undefined) ?? 'headers',
        oauth2_client_id: String(row.auth.oauth2_client_id ?? ''),
        oauth2_client_secret: String(row.auth.oauth2_client_secret ?? ''),
        oauth2_token_url: String(row.auth.oauth2_token_url ?? ''),
        oauth2_scope: String(row.auth.oauth2_scope ?? ''),
        login_url: String(row.auth.login_url ?? ''),
        login_path: String(row.auth.login_path ?? ''),
        login_method: String(row.auth.login_method ?? 'POST').toUpperCase(),
        login_headers: (row.auth.login_headers as Record<string, string> | undefined) ?? {},
        login_body_template: (row.auth.login_body_template as Record<string, unknown> | undefined) ?? {},
        login_body_mode:
          (row.auth.login_body_mode as ConnectorWritePayload['login_body_mode'] | undefined) ?? 'json',
        login_body_raw: row.auth.login_body_raw != null ? String(row.auth.login_body_raw) : '',
        login_allow_redirects:
          row.auth.login_allow_redirects !== undefined && row.auth.login_allow_redirects !== null
            ? Boolean(row.auth.login_allow_redirects)
            : false,
        session_cookie_name:
          row.auth.session_cookie_name != null ? String(row.auth.session_cookie_name) : '',
        login_username: String(row.auth.login_username ?? ''),
        login_password: '',
        refresh_token: '',
        token_url: String(row.auth.token_url ?? ''),
        token_path: String(row.auth.token_path ?? ''),
        token_http_method: String(row.auth.token_http_method ?? 'POST').toUpperCase(),
        refresh_token_header_name: String(row.auth.refresh_token_header_name ?? 'Authorization'),
        refresh_token_header_prefix: String(row.auth.refresh_token_header_prefix ?? 'Bearer'),
        access_token_json_path: String(row.auth.access_token_json_path ?? '$.access_token'),
        access_token_header_name: String(row.auth.access_token_header_name ?? 'Authorization'),
        access_token_header_prefix: String(row.auth.access_token_header_prefix ?? 'Bearer'),
        token_ttl_seconds: Number(row.auth.token_ttl_seconds ?? 600),
        user_id: String(row.auth.user_id ?? ''),
        api_key: '',
        token_method: String(row.auth.token_method ?? 'POST').toUpperCase(),
        token_auth_mode: String(row.auth.token_auth_mode ?? 'basic_user_api_key'),
        token_content_type:
          row.auth.token_content_type != null ? String(row.auth.token_content_type as string) : '',
        token_body_mode: String(row.auth.token_body_mode ?? 'empty'),
        token_body: String(row.auth.token_body ?? ''),
        access_token_injection: String(row.auth.access_token_injection ?? 'bearer_authorization'),
        access_token_query_name: String(row.auth.access_token_query_name ?? ''),
        token_custom_headers: (row.auth.token_custom_headers as Record<string, string> | undefined) ?? {},
        source_type: row.source_type ?? 'HTTP_API_POLLING',
        connector_type: row.connector_type,
        endpoint_url: row.endpoint_url ?? '',
        bucket: row.bucket ?? '',
        region: row.region ?? 'us-east-1',
        prefix: row.prefix ?? '',
        object_key_pattern: row.object_key_pattern ?? '',
        access_key: row.access_key ?? '',
        secret_key: row.secret_key_configured ? '********' : '',
        path_style_access: row.path_style_access ?? true,
        use_ssl: row.use_ssl ?? false,
        db_type: (row.db_type as ConnectorWritePayload['db_type']) ?? 'POSTGRESQL',
        database: row.database ?? '',
        port: row.port ?? undefined,
        host: row.host ?? '',
        db_username: row.db_username ?? '',
        db_password: row.db_password_configured ? '********' : '',
        ssl_mode: row.ssl_mode ?? 'PREFER',
        connection_timeout_seconds: row.connection_timeout_seconds ?? 15,
        remote_username: row.remote_username ?? '',
        remote_password: row.remote_password_configured ? '********' : '',
        remote_file_protocol: (() => {
          const p = String(row.remote_file_protocol ?? 'sftp').toLowerCase()
          return (p === 'scp' ? 'sftp_compatible_scp' : p) as ConnectorWritePayload['remote_file_protocol']
        })(),
        remote_private_key: row.remote_private_key_configured ? '********' : '',
        remote_private_key_passphrase: row.remote_private_key_passphrase_configured ? '********' : '',
        known_hosts_policy: row.known_hosts_policy ?? 'strict',
        known_hosts_text: '',
        receiver_key: row.receiver_key ?? '',
        webhook_auth_mode: row.webhook_auth_mode ?? 'no_auth',
        webhook_auth_header_name: row.webhook_auth_header_name ?? 'X-GDC-Webhook-Secret',
        webhook_shared_secret: row.webhook_shared_secret_configured ? '********' : '',
        webhook_bearer_token: row.webhook_bearer_token_configured ? '********' : '',
        max_request_bytes: row.max_request_bytes ?? 1048576,
        payload_preview: row.payload_preview ?? '',
      })
      setConfiguredSecrets({
        basic_password: Boolean(row.auth.basic_password_configured),
        bearer_token: Boolean(row.auth.bearer_token_configured),
        api_key_value: Boolean(row.auth.api_key_value_configured),
        oauth2_client_secret: Boolean(row.auth.oauth2_client_secret_configured),
        login_password: Boolean(row.auth.login_password_configured),
        refresh_token: Boolean(row.auth.refresh_token_configured),
        api_key: Boolean((row.auth as Record<string, unknown>).api_key_configured),
        secret_key: Boolean(row.secret_key_configured),
        db_password: Boolean(row.db_password_configured),
        remote_password: Boolean(row.remote_password_configured),
        remote_private_key: Boolean(row.remote_private_key_configured),
        remote_private_key_passphrase: Boolean(row.remote_private_key_passphrase_configured),
        webhook_shared_secret: Boolean(row.webhook_shared_secret_configured),
        webhook_bearer_token: Boolean(row.webhook_bearer_token_configured),
      })
      setConnectorSummary({ name: row.name, stream_count: row.stream_count ?? 0 })
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [connectorId])

  /** Must stay above conditional returns — hooks cannot run only after loading completes. */
  const buildAuthTestPayload = useCallback(
    (ctx: { method: AuthTestHttpMethod; testPath: string; jsonBody: unknown | undefined }) => ({
      connector_id: Number(connectorId),
      method: ctx.method,
      test_path: ctx.testPath,
      json_body: ctx.jsonBody,
    }),
    [connectorId],
  )

  function set<K extends keyof ConnectorWritePayload>(key: K, value: ConnectorWritePayload[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }
  if (loading) return <p className={cn('text-sm', gdcUi.textMuted)}>Loading connector...</p>
  if (!form) return <p className="text-sm text-red-600 dark:text-red-400">{error ?? 'Invalid connector'}</p>

  const authType = (form.auth_type ?? 'no_auth') as AuthType
  const isS3 = ['S3_OBJECT_POLLING', 'S3'].includes(form.source_type ?? 'HTTP_API_POLLING')
  const isDb = (form.source_type ?? 'HTTP_API_POLLING') === 'DATABASE_QUERY'
  const isRemote = ['REMOTE_FILE_POLLING', 'REMOTE_FILE'].includes(form.source_type ?? 'HTTP_API_POLLING')
  const isWebhook = ['WEBHOOK_RECEIVER', 'WEBHOOK'].includes(form.source_type ?? 'HTTP_API_POLLING')

  async function onSave() {
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      if (isS3) {
        const nm = String(form.name ?? '').trim()
        if (!nm) {
          setError('Connector name is required.')
          return
        }
        const ep = String(form.endpoint_url ?? '').trim()
        const bkt = String(form.bucket ?? '').trim()
        const ak = String(form.access_key ?? '').trim()
        if (!ep) {
          setError('Endpoint URL is required.')
          return
        }
        if (!bkt) {
          setError('Bucket is required.')
          return
        }
        if (!ak) {
          setError('Access key is required.')
          return
        }
        const sk = String(form.secret_key ?? '').trim()
        const mask = '********'
        if (!configuredSecrets.secret_key && (!sk || sk === mask)) {
          setError('Secret access key is required.')
          return
        }
      }
      if (isDb) {
        const nm = String(form.name ?? '').trim()
        if (!nm) {
          setError('Connector name is required.')
          return
        }
        const h = String(form.host ?? '').trim()
        const dbn = String(form.database ?? '').trim()
        const u = String(form.db_username ?? '').trim()
        const pw = String(form.db_password ?? '').trim()
        const mask = '********'
        if (!h) {
          setError('Database host is required.')
          return
        }
        if (!dbn) {
          setError('Database name is required.')
          return
        }
        if (!u) {
          setError('Database username is required.')
          return
        }
        if (!configuredSecrets.db_password && (!pw || pw === mask)) {
          setError('Database password is required.')
          return
        }
      }
      if (isRemote) {
        const nm = String(form.name ?? '').trim()
        if (!nm) {
          setError('Connector name is required.')
          return
        }
        const h = String(form.host ?? '').trim()
        const u = String(form.remote_username ?? '').trim()
        const pw = String(form.remote_password ?? '').trim()
        const pk = String(form.remote_private_key ?? '').trim()
        const mask = '********'
        if (!h) {
          setError('Host is required.')
          return
        }
        if (!u) {
          setError('Username is required.')
          return
        }
        const havePw = configuredSecrets.remote_password || (pw && pw !== mask)
        const havePk = configuredSecrets.remote_private_key || (pk && pk !== mask)
        if (!havePw && !havePk) {
          setError('Password or private key is required.')
          return
        }
      }
      if (isWebhook) {
        const nm = String(form.name ?? '').trim()
        if (!nm) {
          setError('Connector name is required.')
          return
        }
        const mode = String(form.webhook_auth_mode ?? 'no_auth')
        const mask = '********'
        if (mode === 'shared_secret_header') {
          const secret = String(form.webhook_shared_secret ?? '').trim()
          if (!configuredSecrets.webhook_shared_secret && (!secret || secret === mask)) {
            setError('Shared secret is required.')
            return
          }
        }
        if (mode === 'bearer_token') {
          const token = String(form.webhook_bearer_token ?? '').trim()
          if (!configuredSecrets.webhook_bearer_token && (!token || token === mask)) {
            setError('Bearer token is required.')
            return
          }
        }
      }
      await updateConnector(Number(connectorId), form)
      setSuccess('Saved.')
      const refreshed = await fetchConnectorById(Number(connectorId))
      if (refreshed) {
        setConfiguredSecrets({
          basic_password: Boolean(refreshed.auth.basic_password_configured),
          bearer_token: Boolean(refreshed.auth.bearer_token_configured),
          api_key_value: Boolean(refreshed.auth.api_key_value_configured),
          oauth2_client_secret: Boolean(refreshed.auth.oauth2_client_secret_configured),
          login_password: Boolean(refreshed.auth.login_password_configured),
          refresh_token: Boolean(refreshed.auth.refresh_token_configured),
          api_key: Boolean((refreshed.auth as Record<string, unknown>).api_key_configured),
          secret_key: Boolean(refreshed.secret_key_configured),
          db_password: Boolean(refreshed.db_password_configured),
          remote_password: Boolean(refreshed.remote_password_configured),
          remote_private_key: Boolean(refreshed.remote_private_key_configured),
          remote_private_key_passphrase: Boolean(refreshed.remote_private_key_passphrase_configured),
          webhook_shared_secret: Boolean(refreshed.webhook_shared_secret_configured),
          webhook_bearer_token: Boolean(refreshed.webhook_bearer_token_configured),
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function executeDelete() {
    setDeleteBusy(true)
    setError(null)
    try {
      await deleteConnector(Number(connectorId))
      setDeleteOpen(false)
      navigate('/connectors')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  async function onExportConnectorJson() {
    setBackupBusy(true)
    setError(null)
    try {
      const id = Number(connectorId)
      const url = buildConnectorExportPath(id, { include_destinations: true })
      await downloadBackupUrl(url, `connector-${id}-export.json`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackupBusy(false)
    }
  }

  async function onCloneConnector() {
    setBackupBusy(true)
    setError(null)
    try {
      const id = Number(connectorId)
      const res = await postCloneConnector(id)
      navigate(res.redirect_path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBackupBusy(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col items-stretch gap-4">
      <h2 className={cn('text-lg font-semibold', gdcUi.textTitle)}>
        {isS3
          ? 'Edit S3 Connector'
          : isDb
            ? 'Edit Database Connector'
            : isRemote
              ? 'Edit Remote File Connector'
              : isWebhook
                ? 'Edit Webhook Receiver Connector'
                : 'Edit Generic HTTP Connector'}
      </h2>
      {error ? (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-[12px] text-red-700 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded border border-emerald-200 bg-emerald-50 p-2 text-[12px] text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/35 dark:text-emerald-200">{success}</p>
      ) : null}
      <p className={cn('text-[11px]', gdcUi.textMuted)}>
        Source type: <span className="font-semibold">{String(form.source_type ?? '').replace(/_/g, ' ')}</span>
      </p>
      <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
        <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Basic Information</h3>
        <div className="grid w-full min-w-0 gap-2 md:grid-cols-2">
          <input
            aria-label="Connector Name *"
            placeholder="Connector Name *"
            value={form.name ?? ''}
            onChange={(e) => set('name', e.target.value)}
            className={cn('h-9 w-full min-w-0', gdcUi.input)}
          />
          {!isS3 && !isDb && !isRemote && !isWebhook ? (
            <input
              aria-label="Host / Base URL *"
              placeholder="Host / Base URL *"
              value={form.base_url ?? ''}
              onChange={(e) => set('base_url', e.target.value)}
              className={cn('h-9 w-full min-w-0', gdcUi.input)}
            />
          ) : (
            <div className="hidden md:block" aria-hidden />
          )}
          <input
            aria-label="Description"
            placeholder="Description"
            value={form.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
            className={cn('h-9 w-full min-w-0 md:col-span-2', gdcUi.input)}
          />
        </div>
      </section>
      {isS3 ? (
        <S3ConnectorFields form={form} set={set} secretConfigured={configuredSecrets.secret_key} />
      ) : isDb ? (
        <DatabaseConnectorFields form={form} set={set} />
      ) : isRemote ? (
        <RemoteFileConnectorFields
          form={form}
          set={set}
          passwordConfigured={Boolean(configuredSecrets.remote_password)}
          privateKeyConfigured={Boolean(configuredSecrets.remote_private_key)}
          passphraseConfigured={Boolean(configuredSecrets.remote_private_key_passphrase)}
        />
      ) : isWebhook ? (
        <WebhookReceiverFields
          form={form}
          set={set}
          receiverPath={form.receiver_key ? `/api/v1/ingest/webhook/${form.receiver_key}` : undefined}
          sharedSecretConfigured={Boolean(configuredSecrets.webhook_shared_secret)}
          bearerTokenConfigured={Boolean(configuredSecrets.webhook_bearer_token)}
        />
      ) : (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-4">
          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Connection Options</h3>
            <div className="grid w-full min-w-0 gap-2 md:grid-cols-2">
              <label className={cn('flex min-w-0 items-center gap-2 text-sm', gdcUi.textTitle)}>
                <input type="checkbox" checked={Boolean(form.verify_ssl)} onChange={(e) => set('verify_ssl', e.target.checked)} />
                Verify SSL
              </label>
              <input
                aria-label="HTTP Proxy"
                placeholder="HTTP Proxy"
                value={form.http_proxy ?? ''}
                onChange={(e) => set('http_proxy', e.target.value)}
                className={cn('h-9 w-full min-w-0', gdcUi.input)}
              />
            </div>
          </section>
          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Common Headers</h3>
            <GenericHttpCommonHeadersEditor
              value={(form.common_headers as Record<string, string>) ?? {}}
              onChange={(next) => set('common_headers', next)}
            />
          </section>
          <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
            <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Authentication</h3>
            <GenericHttpAuthFields form={form} authType={authType} set={set} configured={configuredSecrets} />
          </section>
        </div>
      )}

      <ConnectorAuthTestPanel
        buildAuthTestPayload={buildAuthTestPayload}
        onTestStart={() => setError(null)}
        mode={isS3 ? 's3' : isDb ? 'database' : isRemote ? 'remote_file' : 'http'}
      />

      <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-gdc-border dark:bg-gdc-card">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Backup</p>
        <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
          Export JSON (secrets masked) or clone this connector as new disabled streams. Full import flow lives under{' '}
          <Link to="/operations/backup" className="font-semibold text-violet-700 hover:underline dark:text-violet-300">
            Backup & Import
          </Link>
          .
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || backupBusy}
            onClick={() => void onExportConnectorJson()}
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-borderStrong dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            {backupBusy ? 'Working…' : 'Export JSON'}
          </button>
          <button
            type="button"
            disabled={busy || backupBusy}
            onClick={() => void onCloneConnector()}
            className="h-9 rounded-md border border-violet-200 bg-violet-50 px-3 text-[12px] font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-900/40 dark:bg-violet-950/50 dark:text-violet-100 dark:hover:bg-violet-950/80"
          >
            Clone connector
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void onSave()} className="h-9 rounded bg-violet-600 px-3 text-sm font-semibold text-white">
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button type="button" disabled={busy} onClick={() => setDeleteOpen(true)} className="h-9 rounded border border-red-300 px-3 text-sm text-red-700">
          Delete
        </button>
      </div>
      <DangerousActionDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleteOpen(false)
        }}
        title="Delete connector permanently?"
        targetName={connectorSummary?.name ?? form?.name}
        impactBullets={[
          'Removes this connector and its source configuration.',
          'Delete fails while streams still reference this connector.',
        ]}
        dependencies={
          (connectorSummary?.stream_count ?? 0) > 0
            ? [{ label: 'Connected streams', count: connectorSummary?.stream_count }]
            : []
        }
        reversibility="Delete is permanent. Stop or remove dependent streams first if needed."
        primaryLabel="Delete connector"
        busy={deleteBusy}
        error={error}
        onConfirm={() => void executeDelete()}
        dataTestId="connector-detail-delete-dialog"
      />
    </div>
  )
}
