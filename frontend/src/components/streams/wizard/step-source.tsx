import { type ReactNode, useEffect, useState } from 'react'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '../../../lib/utils'
import { fetchCatalogSnapshot, type CatalogSnapshot } from '../../../api/gdcCatalog'
import { fetchConnectorById } from '../../../api/gdcConnectors'
import { wizardConnectorPatchFromApi, type WizardState } from './wizard-state'
import { readWizardCatalogSnapshot, writeWizardCatalogSnapshot } from './wizard-catalog-cache'

export type StepSourceSection = 'connector'

type StepSourceProps = {
  state: WizardState
  section?: StepSourceSection
  connectorReadonly?: boolean
  onCreateConnector?: () => void
  onChange: (next: Partial<WizardState['connector']>) => void
  onOpenRequestConfiguration?: () => void
  requestConfigurationLabel?: string
}

const inputCls =
  'h-9 w-full rounded-md border border-slate-200/90 bg-white px-2.5 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

export function StepSource({
  state,
  section = 'connector',
  connectorReadonly = false,
  onCreateConnector,
  onChange,
  onOpenRequestConfiguration,
  requestConfigurationLabel = 'Request Configuration',
}: StepSourceProps) {
  const sessionSnapshot = readWizardCatalogSnapshot()
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(() => sessionSnapshot)
  const [loading, setLoading] = useState(() => sessionSnapshot == null)
  const [detailBusy, setDetailBusy] = useState(false)
  const c = state.connector

  useEffect(() => {
    let cancelled = false
    const background = sessionSnapshot != null
    if (!background) setLoading(true)
    if (background && sessionSnapshot) {
      onChange({
        candidates: { connectors: sessionSnapshot.connectors, sources: sessionSnapshot.sources },
        apiBacked: sessionSnapshot.apiBacked,
      })
    }
    void (async () => {
      const snap = await fetchCatalogSnapshot()
      if (cancelled) return
      writeWizardCatalogSnapshot(snap)
      setSnapshot(snap)
      setLoading(false)
      onChange({ candidates: { connectors: snap.connectors, sources: snap.sources }, apiBacked: snap.apiBacked })
    })()
    return () => {
      cancelled = true
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (c.connectorId == null) return
    let cancelled = false
    setDetailBusy(true)
    void (async () => {
      const row = await fetchConnectorById(c.connectorId)
      if (cancelled || !row) {
        if (!cancelled) setDetailBusy(false)
        return
      }
      onChange({
        connectorId: row.id,
        sourceId: row.source_id ?? null,
        registryModuleId: null,
        schemaFormValues: {},
        ...wizardConnectorPatchFromApi(row),
      })
      if (!cancelled) setDetailBusy(false)
    })()
    return () => {
      cancelled = true
    }
  }, [c.connectorId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && snapshot == null) {
    return (
      <section className="rounded-xl border border-slate-200/80 bg-white p-6 text-center shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-violet-600" aria-hidden />
        <p className="mt-3 text-[12px] font-medium text-slate-700 dark:text-slate-200">Loading connector catalog…</p>
      </section>
    )
  }

  const selectedIdValid = typeof c.connectorId === 'number' && Number.isSafeInteger(c.connectorId) && c.connectorId > 0
  // A newly saved connector can appear before the source/catalog read catches up.
  // Preserve its ID for verification instead of silently hiding it as "no connector".
  const hasSavedConnectors = Boolean(snapshot && snapshot.connectors.length > 0) || selectedIdValid
  const catalogUnavailable = snapshot?.apiBacked === false

  async function retryCatalog() {
    setLoading(true)
    try {
      const fresh = await fetchCatalogSnapshot()
      writeWizardCatalogSnapshot(fresh)
      setSnapshot(fresh)
      onChange({
        candidates: { connectors: fresh.connectors, sources: fresh.sources },
        apiBacked: fresh.apiBacked,
      })
    } finally {
      setLoading(false)
    }
  }

  if (!hasSavedConnectors) {
    return (
      <section className="rounded-xl border border-amber-300/70 bg-amber-50 p-4 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {catalogUnavailable ? 'Connector catalog unavailable' : 'No connectors available'}
        </h3>
        <p className="mt-1 text-[12px] text-amber-800 dark:text-amber-300">
          {catalogUnavailable
            ? 'Could not verify saved Connectors and Sources. Check API access or your session, then retry. This does not mean zero Connectors are configured.'
            : 'Create a connector first, then return here to bind it to a new stream.'}
        </p>
        {catalogUnavailable ? (
          <button type="button" onClick={() => void retryCatalog()} disabled={loading} className="mt-3 inline-flex min-h-9 items-center rounded-md bg-violet-600 px-3 text-xs font-semibold text-white disabled:opacity-60" data-testid="wizard-retry-connector-catalog">
            {loading ? 'Checking catalog…' : 'Retry Connector catalog'}
          </button>
        ) : onCreateConnector && !connectorReadonly ? (
          <button type="button" onClick={onCreateConnector} className="mt-3 inline-flex min-h-9 items-center rounded-md bg-violet-600 px-3 text-xs font-semibold text-white" data-testid="wizard-add-connector">
            Add Connector without leaving this Data Flow
          </button>
        ) : (
          <Link to="/connectors/new" className="mt-3 inline-flex min-h-9 items-center rounded-md bg-violet-600 px-3 text-xs font-semibold text-white">
            Go to Connector Create Page
          </Link>
        )}
      </section>
    )
  }

  if (section !== 'connector') {
    return null
  }

  return (
    <div className="space-y-4" data-testid="wizard-connect-connector">
      <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Saved Connector</h3>
          <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
            Choose an existing connector. Authentication and connection settings are inherited from the saved connector.
          </p>
        </div>

        {onCreateConnector && !connectorReadonly ? (
          <button type="button" onClick={onCreateConnector} data-testid="wizard-add-connector" className="mt-3 text-xs font-semibold text-violet-700 hover:underline dark:text-violet-300">
            + Add Connector
          </button>
        ) : null}
        {catalogUnavailable ? (
          <p role="status" className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            The Connector/Source catalog could not be fully verified. Review API access before continuing.
          </p>
        ) : null}
        <div className="mt-4 space-y-3">
          <Field label="Connector">
            <select
              value={c.connectorId ?? ''}
              disabled={detailBusy || connectorReadonly}
              onChange={(e) => {
                if (connectorReadonly) return
                const raw = e.target.value
                const id = raw ? Number(raw) : null
                if (id == null || Number.isNaN(id)) {
                  onChange({ connectorId: null, sourceId: null })
                  return
                }
                onChange({
                  connectorId: id,
                  registryModuleId: null,
                  schemaFormValues: {},
                  selectedTemplateIds: [],
                })
              }}
              className={inputCls}
              data-testid="wizard-saved-connector-select"
            >
              <option value="">Select saved connector</option>
              {selectedIdValid && !snapshot?.connectors.some((conn) => conn.id === c.connectorId) ? (
                <option value={c.connectorId}>
                  {c.connectorName?.trim() || `Connector #${c.connectorId}`} · verifying source link
                </option>
              ) : null}
              {snapshot?.connectors.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name}
                </option>
              ))}
            </select>
          </Field>

          {detailBusy ? (
            <p className="flex items-center gap-2 text-[12px] text-slate-600 dark:text-gdc-muted">
              <Loader2 className="h-4 w-4 animate-spin text-violet-600" aria-hidden />
              Loading connector details…
            </p>
          ) : null}

          {c.connectorId != null && !detailBusy ? (
            <div className="rounded-lg border border-slate-200/80 bg-slate-50/70 p-3 text-[11px] dark:border-gdc-border dark:bg-gdc-card">
              <p className="font-semibold text-slate-800 dark:text-slate-200">Inherited from connector (read-only)</p>
              <dl className="mt-2 space-y-1.5">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Name</dt>
                  <dd className="max-w-[70%] text-right font-medium text-slate-800 dark:text-slate-200">{c.connectorName || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Auth type</dt>
                  <dd className="font-medium text-slate-800 dark:text-slate-200">{c.authType || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">
                    {c.sourceType === 'S3_OBJECT_POLLING'
                      ? 'Endpoint URL'
                      : c.sourceType === 'REMOTE_FILE_POLLING'
                        ? 'SSH host'
                        : c.sourceType === 'WEBHOOK_RECEIVER'
                          ? 'Receiver URL'
                          : 'Base URL'}
                  </dt>
                  <dd className="max-w-[70%] break-all text-right font-medium text-slate-800 dark:text-slate-200">{c.hostBaseUrl || '—'}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[10px] text-slate-500 dark:text-gdc-muted">
                Authentication is inherited from the saved connector and cannot be changed in this wizard.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {c.connectorId != null && !detailBusy && onOpenRequestConfiguration ? (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-emerald-200/80 bg-emerald-500/[0.06] p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-emerald-900 dark:text-emerald-100">
              Connector selected — {c.connectorName?.trim() || `Connector #${c.connectorId}`}
            </p>
            <p className="mt-0.5 text-[11px] text-emerald-900/90 dark:text-emerald-100/90">
              <span className="font-semibold">Next required:</span> Configure the stream request settings before sampling data.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenRequestConfiguration}
            data-testid="wizard-connect-open-request-configuration"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400"
          >
            {requestConfigurationLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">{label}</label>
      {children}
    </div>
  )
}
