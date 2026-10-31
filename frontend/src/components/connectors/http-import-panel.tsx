import { FileJson, Loader2, Save, Terminal } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  postCurlParse,
  postPostmanParse,
  type CurlImportDraft,
  type PostmanRequestSummary,
} from '../../api/gdcBackup'
import { TemplateDraftPreviewModal } from '../templates/template-draft-preview-modal'
import { cn } from '../../lib/utils'
import { parseApiError } from '../../lib/api-error-message'
import {
  defaultDraftDisplayName,
  importSourceFromDraftKind,
  requestStructureFromImportDraft,
} from '../../utils/templateDraftFromImport'

/**
 * Import failures name the reason and the next action (F-010). A rejected command (HTTP 4xx) points to
 * fixing the pasted text; anything else points to retrying or checking API availability.
 */
function importFailureMessage(error: unknown, kind: 'curl command' | 'Postman collection'): string {
  const parsed = parseApiError(error, `Could not parse the ${kind}.`)
  const rejected = parsed.status != null && parsed.status >= 400 && parsed.status < 500
  const nextAction = rejected
    ? kind === 'curl command'
      ? 'Check that the command starts with "curl" and includes a full http:// or https:// URL, then parse again.'
      : 'Check that the file is a Postman Collection v2.1 export, then parse again.'
    : 'Try again. If it keeps failing, check that the API is reachable.'
  const reason = /[.!?]$/.test(parsed.message) ? parsed.message : `${parsed.message}.`
  return `${reason} ${nextAction}`
}

type ParsedPreview = CurlImportDraft['parsed'] & {
  body_mode?: string | null
  has_json_body?: boolean
  has_raw_body?: boolean
}

function ParsedRequestPreview({
  parsed,
  warnings,
  authTypeHint,
}: {
  parsed: ParsedPreview
  warnings: string[]
  authTypeHint?: string
}) {
  const headers = (parsed.headers_masked ?? {}) as Record<string, string>
  const queryParams = (parsed.query_params ?? {}) as Record<string, string>
  const bodyBits: string[] = []
  if (parsed.has_json_body) bodyBits.push('JSON body')
  else if (parsed.has_raw_body) bodyBits.push('Raw body')
  if (parsed.body_mode) bodyBits.push(`mode: ${parsed.body_mode}`)

  return (
    <div className="mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50/90 p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-elevated">
      <p className="font-semibold text-slate-800 dark:text-slate-100">Parsed request preview</p>
      <dl className="grid gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Method</dt>
          <dd className="font-mono text-slate-900 dark:text-slate-100">{String(parsed.method ?? 'GET')}</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Base URL</dt>
          <dd className="font-mono break-all text-slate-900 dark:text-slate-100">{String(parsed.base_url ?? '—')}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-slate-500 dark:text-gdc-muted">Endpoint / path</dt>
          <dd className="font-mono break-all text-slate-900 dark:text-slate-100">{String(parsed.endpoint ?? '/')}</dd>
        </div>
        {bodyBits.length ? (
          <div className="sm:col-span-2">
            <dt className="text-slate-500 dark:text-gdc-muted">Body</dt>
            <dd className="text-slate-900 dark:text-slate-100">{bodyBits.join(' · ')}</dd>
          </div>
        ) : null}
      </dl>
      {Object.keys(headers).length ? (
        <div>
          <p className="mb-1 font-medium text-slate-700 dark:text-gdc-mutedStrong">Headers (masked)</p>
          <ul className="max-h-28 overflow-auto font-mono text-[10px] text-slate-800 dark:text-slate-200">
            {Object.entries(headers).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {Object.keys(queryParams).length ? (
        <div>
          <p className="mb-1 font-medium text-slate-700 dark:text-gdc-mutedStrong">Query params</p>
          <ul className="font-mono text-[10px] text-slate-800 dark:text-slate-200">
            {Object.entries(queryParams).map(([k, v]) => (
              <li key={k}>
                {k}={v}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {authTypeHint && authTypeHint !== 'no_auth' ? (
        <p className="text-amber-900 dark:text-amber-100">
          Auth hint: {authTypeHint} — enter credentials in the connector wizard (secrets are not imported).
        </p>
      ) : null}
      {warnings.length ? (
        <ul className="list-inside list-disc text-amber-900 dark:text-amber-100">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

type CurlImportPanelProps = {
  onApprove: (draft: CurlImportDraft) => void
  className?: string
}

export function CurlImportPanel({ onApprove, className }: CurlImportPanelProps) {
  const navigate = useNavigate()
  const [curlText, setCurlText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CurlImportDraft | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [draftModalOpen, setDraftModalOpen] = useState(false)

  const onParse = useCallback(async () => {
    setError(null)
    setDraft(null)
    setWarnings([])
    setBusy(true)
    try {
      const res = await postCurlParse(curlText)
      if (!res.ok || !res.draft) {
        setError(res.parse_errors.join(' ') || 'Could not parse curl command.')
        return
      }
      setDraft(res.draft)
      setWarnings([...res.warnings, ...(res.draft.warnings ?? [])])
    } catch (e) {
      setError(importFailureMessage(e, 'curl command'))
    } finally {
      setBusy(false)
    }
  }, [curlText])

  return (
    <section className={cn('rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card', className)} aria-label="Import from curl">
      <div className="flex flex-wrap items-center gap-2">
        <Terminal className="h-4 w-4 text-slate-500" aria-hidden />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Import from cURL</h3>
      </div>
      <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
        Paste a curl command. Review the parsed request, then approve to prefill a draft connector and stream (disabled until you save).
      </p>
      {error ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {error}
        </p>
      ) : null}
      <textarea
        aria-label="Curl command"
        className="mt-3 min-h-[100px] w-full rounded-md border border-slate-200 bg-slate-50/80 p-2 font-mono text-[11px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
        placeholder="curl -X GET 'https://api.example.com/v1/events' -H 'Accept: application/json'"
        value={curlText}
        onChange={(e) => {
          setCurlText(e.target.value)
          setDraft(null)
          setWarnings([])
          setError(null)
        }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !curlText.trim()}
          onClick={() => void onParse()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Parse cURL
        </button>
        {draft ? (
          <>
            <button
              type="button"
              onClick={() => setDraftModalOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 text-[12px] font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
            >
              <Save className="h-4 w-4" aria-hidden />
              Save as Template Draft
            </button>
            <button
              type="button"
              onClick={() => onApprove(draft)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
            >
              Approve and open wizard
            </button>
          </>
        ) : null}
      </div>
      {draft?.parsed ? (
        <ParsedRequestPreview
          parsed={draft.parsed as ParsedPreview}
          warnings={warnings}
          authTypeHint={String(draft.connector.auth_type ?? '')}
        />
      ) : null}
      {draft ? (
        <TemplateDraftPreviewModal
          open={draftModalOpen}
          onClose={() => setDraftModalOpen(false)}
          onSaved={() => navigate('/templates', { state: { tab: 'drafts' } })}
          importSource={importSourceFromDraftKind(draft)}
          displayNameDefault={defaultDraftDisplayName(draft)}
          requestStructure={requestStructureFromImportDraft(draft)}
          authType={String(draft.connector.auth_type ?? '')}
          connectorDraft={draft.connector as Record<string, unknown>}
          streamDraft={draft.stream as Record<string, unknown>}
        />
      ) : null}
    </section>
  )
}

type PostmanImportPanelProps = {
  onApprove: (draft: CurlImportDraft) => void
  className?: string
}

export function PostmanImportPanel({ onApprove, className }: PostmanImportPanelProps) {
  const navigate = useNavigate()
  const [jsonText, setJsonText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<PostmanRequestSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<CurlImportDraft | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [collection, setCollection] = useState<Record<string, unknown> | null>(null)
  const [draftModalOpen, setDraftModalOpen] = useState(false)

  const onPickFile = useCallback((file: File | null) => {
    if (!file) return
    void file.text().then((t) => {
      setJsonText(t)
      setItems([])
      setSelectedId('')
      setDraft(null)
      setCollection(null)
      setError(null)
    })
  }, [])

  const onParseCollection = useCallback(async () => {
    setError(null)
    setItems([])
    setSelectedId('')
    setDraft(null)
    setWarnings([])
    setBusy(true)
    try {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonText || '{}') as Record<string, unknown>
      } catch {
        setError('Invalid JSON. Paste or upload a Postman Collection v2.1 export.')
        return
      }
      const res = await postPostmanParse(parsed)
      if (!res.ok) {
        setError(res.parse_errors.join(' ') || 'Could not parse Postman collection.')
        return
      }
      setCollection(parsed)
      setItems(res.items)
      setWarnings(res.warnings)
      if (res.items.length === 1) setSelectedId(res.items[0].item_id)
    } catch (e) {
      setError(importFailureMessage(e, 'Postman collection'))
    } finally {
      setBusy(false)
    }
  }, [jsonText])

  const onBuildDraft = useCallback(async () => {
    if (!collection || !selectedId) {
      setError('Select a request from the collection.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const res = await postPostmanParse(collection, { itemId: selectedId })
      if (!res.ok || !res.draft) {
        setError(res.parse_errors.join(' ') || 'Could not build draft for the selected request.')
        return
      }
      setDraft(res.draft)
      setWarnings([...res.warnings, ...(res.draft.warnings ?? [])])
    } catch (e) {
      setError(importFailureMessage(e, 'Postman collection'))
    } finally {
      setBusy(false)
    }
  }, [collection, selectedId])

  return (
    <section
      className={cn('rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card', className)}
      aria-label="Import Postman collection"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FileJson className="h-4 w-4 text-slate-500" aria-hidden />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Import Postman Collection</h3>
      </div>
      <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
        Upload or paste Postman Collection v2.1 JSON. Pick one request to prefill a draft connector and stream.
      </p>
      {error ? (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-100 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100">
          Upload JSON
          <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <textarea
        aria-label="Postman collection JSON"
        className="mt-3 min-h-[100px] w-full rounded-md border border-slate-200 bg-slate-50/80 p-2 font-mono text-[11px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
        placeholder='{ "info": { "name": "My API", "schema": "..." }, "item": [ ... ] }'
        value={jsonText}
        onChange={(e) => {
          setJsonText(e.target.value)
          setItems([])
          setSelectedId('')
          setDraft(null)
          setCollection(null)
          setError(null)
        }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !jsonText.trim()}
          onClick={() => void onParseCollection()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Parse collection
        </button>
        {items.length ? (
          <>
            <select
              aria-label="Postman request"
              className="h-9 min-w-[12rem] rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value)
                setDraft(null)
              }}
            >
              <option value="">Select request…</option>
              {items.map((item) => (
                <option key={item.item_id} value={item.item_id}>
                  {item.folder_path ? `${item.folder_path} / ` : ''}
                  {item.name} ({item.method})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selectedId}
              onClick={() => void onBuildDraft()}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            >
              Preview request
            </button>
          </>
        ) : null}
        {draft ? (
          <>
            <button
              type="button"
              onClick={() => setDraftModalOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 text-[12px] font-semibold text-violet-900 hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100"
            >
              <Save className="h-4 w-4" aria-hidden />
              Save as Template Draft
            </button>
            <button
              type="button"
              onClick={() => onApprove(draft)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700"
            >
              Approve and open wizard
            </button>
          </>
        ) : null}
      </div>
      {items.length && !draft ? (
        <ul className="mt-2 max-h-32 overflow-auto text-[11px] text-slate-600 dark:text-gdc-muted">
          {items.map((item) => (
            <li key={item.item_id} className="font-mono">
              {item.method} {item.url_preview}
            </li>
          ))}
        </ul>
      ) : null}
      {draft?.parsed ? (
        <ParsedRequestPreview
          parsed={draft.parsed as ParsedPreview}
          warnings={warnings}
          authTypeHint={String(draft.connector.auth_type ?? '')}
        />
      ) : null}
      {draft ? (
        <TemplateDraftPreviewModal
          open={draftModalOpen}
          onClose={() => setDraftModalOpen(false)}
          onSaved={() => navigate('/templates', { state: { tab: 'drafts' } })}
          importSource={importSourceFromDraftKind(draft)}
          displayNameDefault={defaultDraftDisplayName(draft)}
          requestStructure={requestStructureFromImportDraft(draft)}
          authType={String(draft.connector.auth_type ?? '')}
          connectorDraft={draft.connector as Record<string, unknown>}
          streamDraft={draft.stream as Record<string, unknown>}
        />
      ) : null}
    </section>
  )
}
