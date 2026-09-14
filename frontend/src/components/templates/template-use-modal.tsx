import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { fetchDestinationsList } from '../../api/gdcDestinations'
import { instantiateTemplate } from '../../api/gdcTemplates'
import type { TemplateSummaryRead } from '../../api/types/gdcApi'
import type { DestinationListItem } from '../../api/gdcDestinations'
import { cn } from '../../lib/utils'

function buildCredentials(fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v.trim()) out[k] = v.trim()
  }
  return out
}

export function TemplateUseModal({
  open,
  template,
  onClose,
  onCreated,
}: {
  open: boolean
  template: TemplateSummaryRead | null
  onClose: () => void
  onCreated: (redirectPath: string) => void
}) {
  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  const [connectorName, setConnectorName] = useState('')
  const [host, setHost] = useState('')
  const [streamName, setStreamName] = useState('')
  const [destinationId, setDestinationId] = useState<string>('')
  const [createRoute, setCreateRoute] = useState(true)
  const [redirectTo, setRedirectTo] = useState<'stream_runtime' | 'connector_detail'>('stream_runtime')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const authType = template?.auth_type ?? 'no_auth'

  const [creds, setCreds] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setConnectorName(template?.name ? `${template.name} connector` : '')
    setHost('')
    setStreamName('')
    setDestinationId('')
    setCreateRoute(true)
    setRedirectTo('stream_runtime')
    setCreds({})
    void fetchDestinationsList()
      .then((rows) => setDestinations(rows ?? []))
      .catch(() => setDestinations([]))
  }, [open, template])

  const credFields = useMemo(() => {
    switch (authType) {
      case 'bearer':
        return [{ key: 'bearer_token', label: 'Bearer token', type: 'password' as const, optional: false as const }]
      case 'oauth2_client_credentials':
        return [
          { key: 'oauth2_client_id', label: 'Client ID', type: 'text' as const, optional: false as const },
          { key: 'oauth2_client_secret', label: 'Client secret', type: 'password' as const, optional: false as const },
          { key: 'oauth2_token_url', label: 'Token URL', type: 'text' as const, optional: false as const },
          { key: 'oauth2_scope', label: 'Scope (optional)', type: 'text' as const, optional: true as const },
        ]
      case 'vendor_jwt_exchange':
        return [
          { key: 'user_id', label: 'User ID', type: 'text' as const, optional: false as const },
          { key: 'api_key', label: 'API key', type: 'password' as const, optional: false as const },
          { key: 'token_url', label: 'Token URL', type: 'text' as const, optional: false as const },
        ]
      case 'basic':
        return [
          { key: 'basic_username', label: 'Username', type: 'text' as const, optional: false as const },
          { key: 'basic_password', label: 'Password', type: 'password' as const, optional: false as const },
        ]
      case 'api_key':
        return [
          { key: 'api_key_name', label: 'Header name', type: 'text' as const, optional: false as const },
          { key: 'api_key_value', label: 'API key value', type: 'password' as const, optional: false as const },
        ]
      default:
        return []
    }
  }, [authType])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!template) return
    const name = connectorName.trim()
    if (!name) {
      setError('Connector name is required.')
      return
    }
    const h = host.trim()
    if (!h) {
      setError('Host / base URL is required.')
      return
    }
    for (const f of credFields) {
      if (f.optional) continue
      if (!creds[f.key]?.trim()) {
        setError(`${f.label} is required for ${authType}.`)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const dest = destinationId ? Number(destinationId) : null
      const res = await instantiateTemplate(template.template_id, {
        connector_name: name,
        host: h,
        stream_name: streamName.trim() || null,
        credentials: buildCredentials(creds),
        destination_id: dest && !Number.isNaN(dest) ? dest : null,
        create_route: createRoute && Boolean(dest),
        redirect_to: redirectTo,
      })
      onCreated(res.redirect_path)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open || !template) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-label="Use template">
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200/80 bg-white shadow-xl dark:border-gdc-border dark:bg-gdc-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-200/80 px-4 py-3 dark:border-gdc-border">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">Use template</p>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{template.name}</h2>
          </div>
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <form className="space-y-3 px-4 py-3" onSubmit={onSubmit}>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Connector name</span>
            <input
              value={connectorName}
              onChange={(e) => setConnectorName(e.target.value)}
              className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[13px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Host / base URL</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="https://api.vendor.com"
              className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[13px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              autoComplete="off"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Stream name (optional)</span>
            <input
              value={streamName}
              onChange={(e) => setStreamName(e.target.value)}
              className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[13px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              autoComplete="off"
            />
          </label>
          {credFields.map((f) => (
            <label key={f.key} className="block space-y-1">
              <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">{f.label}</span>
              <input
                type={f.type}
                value={creds[f.key] ?? ''}
                onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[13px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
                autoComplete="off"
              />
            </label>
          ))}
          <label className="block space-y-1">
            <span className="text-[12px] font-medium text-slate-700 dark:text-slate-200">Destination (optional)</span>
            <select
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              className="h-9 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[13px] dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
            >
              <option value="">Skip route for now</option>
              {destinations.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name} ({d.destination_type})
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[12px] text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={createRoute} onChange={(e) => setCreateRoute(e.target.checked)} />
            Create route when destination is selected
          </label>
          <fieldset className="space-y-1">
            <legend className="text-[12px] font-medium text-slate-700 dark:text-slate-200">After create</legend>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="radio"
                name="redirect"
                checked={redirectTo === 'stream_runtime'}
                onChange={() => setRedirectTo('stream_runtime')}
              />
              Open stream runtime
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="radio"
                name="redirect"
                checked={redirectTo === 'connector_detail'}
                onChange={() => setRedirectTo('connector_detail')}
              />
              Open connector detail
            </label>
          </fieldset>
          {error ? <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="h-9 rounded-md border border-slate-200/90 px-3 text-[12px] font-semibold text-slate-800 dark:border-gdc-border dark:text-slate-100"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={cn(
                'h-9 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50',
              )}
            >
              {busy ? 'Creating…' : 'Create scaffolding'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
