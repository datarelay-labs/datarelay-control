import { useId } from 'react'
import type { ConnectorWritePayload } from '../../api/gdcConnectors'
import { gdcUi } from '../../lib/gdc-ui-tokens'
import { cn } from '../../lib/utils'

type Props = {
  form: ConnectorWritePayload
  set: <K extends keyof ConnectorWritePayload>(key: K, value: ConnectorWritePayload[K]) => void
  receiverPath?: string | null
  sharedSecretConfigured?: boolean
  bearerTokenConfigured?: boolean
}

export function WebhookReceiverFields({
  form,
  set,
  receiverPath,
  sharedSecretConfigured,
  bearerTokenConfigured,
}: Props) {
  const receiverUrlInputId = useId()
  const authMode = String(form.webhook_auth_mode ?? 'no_auth')
  const path = receiverPath || (form.receiver_key ? `/api/v1/ingest/webhook/${form.receiver_key}` : '')
  const receiverUrl = path ? `${window.location.origin}${path}` : ''
  const copyUrl = () => {
    if (!receiverUrl) return
    void navigator.clipboard?.writeText(receiverUrl)
  }

  const labelClass = cn('text-sm font-semibold', gdcUi.textMuted)

  return (
    <section className={cn('w-full min-w-0 max-w-full rounded-lg border p-4', gdcUi.cardShell)}>
      <h3 className={cn('mb-2 text-sm font-semibold', gdcUi.textTitle)}>Webhook Receiver</h3>
      <p className={cn('mb-3 text-xs', gdcUi.textMuted)}>
        External systems send JSON or NDJSON using HTTP POST to this receiver URL. Opening the URL in a
        browser does not send an event. Events use the same mapping, enrichment, routes, and delivery logs.
      </p>
      <div className="grid w-full min-w-0 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={receiverUrlInputId} className={labelClass}>Receiver URL</label>
          <div className="flex min-w-0 gap-2">
            <input
              id={receiverUrlInputId}
              readOnly
              value={receiverUrl || 'Generated after save'}
              className={cn(gdcUi.input, 'h-9 min-w-0 flex-1 font-mono text-sm')}
            />
            <button
              type="button"
              disabled={!receiverUrl}
              onClick={copyUrl}
              className="h-9 shrink-0 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-700 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200"
            >
              Copy URL
            </button>
          </div>
        </div>
        <label className="space-y-1">
          <span className={labelClass}>Auth mode</span>
          <select
            value={authMode}
            onChange={(e) => set('webhook_auth_mode', e.target.value)}
            className={cn(gdcUi.input, 'h-9 w-full text-sm')}
          >
            <option value="no_auth">No auth</option>
            <option value="shared_secret_header">Shared secret header</option>
            <option value="bearer_token">Bearer token</option>
          </select>
        </label>
        {authMode === 'shared_secret_header' ? (
          <>
            <label className="space-y-1">
              <span className={labelClass}>Shared secret header name</span>
              <input
                aria-label="Shared secret header name"
                placeholder="Shared secret header name"
                value={form.webhook_auth_header_name ?? 'X-GDC-Webhook-Secret'}
                onChange={(e) => set('webhook_auth_header_name', e.target.value)}
                className={cn(gdcUi.input, 'h-9 w-full text-sm')}
              />
            </label>
            <label className="space-y-1">
              <span className={labelClass}>Shared secret</span>
              <input
                aria-label="Shared secret"
                placeholder={sharedSecretConfigured ? 'Shared secret configured' : 'Shared secret *'}
                type="password"
                value={form.webhook_shared_secret ?? ''}
                onChange={(e) => set('webhook_shared_secret', e.target.value)}
                className={cn(gdcUi.input, 'h-9 w-full text-sm')}
              />
            </label>
          </>
        ) : null}
        {authMode === 'bearer_token' ? (
          <label className="space-y-1">
            <span className={labelClass}>Bearer token</span>
            <input
              aria-label="Bearer token"
              placeholder={bearerTokenConfigured ? 'Bearer token configured' : 'Bearer token *'}
              type="password"
              value={form.webhook_bearer_token ?? ''}
              onChange={(e) => set('webhook_bearer_token', e.target.value)}
              className={cn(gdcUi.input, 'h-9 w-full text-sm')}
            />
          </label>
        ) : null}
        <label className="space-y-1">
          <span className={labelClass}>Max request bytes</span>
          <input
            aria-label="Max request bytes"
            type="number"
            min={1024}
            max={10 * 1024 * 1024}
            value={form.max_request_bytes ?? 1048576}
            onChange={(e) => set('max_request_bytes', Math.max(1024, Number(e.target.value || 1048576)))}
            className={cn(gdcUi.input, 'h-9 w-full text-sm')}
          />
        </label>
        <label className="space-y-1 md:col-span-2">
          <span className={labelClass}>Payload preview</span>
          <textarea
            aria-label="Payload preview"
            placeholder='Payload preview, e.g. {"id":"evt-1","message":"hello"}'
            value={form.payload_preview ?? ''}
            onChange={(e) => set('payload_preview', e.target.value)}
            rows={6}
            className={cn(gdcUi.input, 'w-full font-mono text-sm')}
          />
        </label>
      </div>
    </section>
  )
}
