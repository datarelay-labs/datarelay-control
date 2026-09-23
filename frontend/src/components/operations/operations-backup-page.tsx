import { AlertTriangle, Download, FileJson, Loader2, Upload } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  buildWorkspaceExportPath,
  downloadBackupUrl,
  postImportApply,
  postImportPreview,
  type CurlImportDraft,
  type ImportMode,
  type ImportPreviewResult,
} from '../../api/gdcBackup'
import { cn } from '../../lib/utils'
import { useSessionCapabilities } from '../../lib/rbac'
import { navigateToConnectorWizardWithDraft } from '../../utils/httpImportDraft'
import { CurlImportPanel, PostmanImportPanel } from '../connectors/http-import-panel'
import { DangerousActionDialog } from '../ui/dangerous-action-dialog'

const MODE_HELP: Record<ImportMode, { title: string; body: string }> = {
  additive: {
    title: 'Additive import',
    body: 'Adds backup entities on top of the current configuration without deleting existing rows. Useful for migration or copying configuration into another environment.',
  },
  clone: {
    title: 'Clone (suffix names)',
    body: 'Creates a copy of the bundle with a name suffix. Does not remove existing configuration.',
  },
}

export function OperationsBackupPage() {
  const navigate = useNavigate()
  const caps = useSessionCapabilities()
  const canPreviewImport = caps.backup_import_preview === true
  const canApplyImport = caps.backup_import_apply === true
  const [wsCkpt, setWsCkpt] = useState(true)
  const [wsDest, setWsDest] = useState(true)
  const [wsBusy, setWsBusy] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [importMode, setImportMode] = useState<ImportMode>('additive')
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [applyDialogOpen, setApplyDialogOpen] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [pageInfo, setPageInfo] = useState<string | null>(null)
  const applyIdempotencyKeyRef = useRef<string | null>(null)
  const modeHelp = MODE_HELP[importMode]

  const onWorkspaceDownload = useCallback(async () => {
    setPageError(null)
    setWsBusy(true)
    try {
      const url = buildWorkspaceExportPath({ include_checkpoints: wsCkpt, include_destinations: wsDest })
      await downloadBackupUrl(url, 'gdc-workspace-export.json')
      setPageInfo('Workspace snapshot downloaded.')
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setWsBusy(false)
    }
  }, [wsCkpt, wsDest])

  const onPickFile = useCallback((file: File | null) => {
    if (!file) return
    void file.text().then((t) => {
      setJsonText(t)
      setPreview(null)
      setConfirmApply(false)
      setPageError(null)
    })
  }, [])

  const onRunPreview = useCallback(async () => {
    if (!canPreviewImport) return
    setPageError(null)
    setPageInfo(null)
    setPreview(null)
    setPreviewBusy(true)
    try {
      const bundle = JSON.parse(jsonText || '{}') as unknown
      const res = await postImportPreview(bundle, importMode)
      setPreview(res)
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setPreviewBusy(false)
    }
  }, [canPreviewImport, jsonText, importMode])

  const onApproveHttpImport = useCallback(
    (draft: CurlImportDraft) => {
      setPageInfo('Opening connector wizard with imported draft. Re-enter secrets before saving.')
      navigateToConnectorWizardWithDraft(navigate, draft)
    },
    [navigate],
  )

  const onApply = useCallback(async () => {
    if (!canApplyImport) return
    if (!preview?.preview_token || !preview.ok) return
    if (!confirmApply) {
      setPageError('Enable confirmation before applying import.')
      return
    }
    setPageError(null)
    setApplyBusy(true)
    if (!applyIdempotencyKeyRef.current) {
      applyIdempotencyKeyRef.current =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `import-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    try {
      const bundle = JSON.parse(jsonText || '{}') as unknown
      const res = await postImportApply(bundle, importMode, preview.preview_token, {
        confirm: true,
        idempotency_key: applyIdempotencyKeyRef.current,
      })
      applyIdempotencyKeyRef.current = null
      setApplyDialogOpen(false)
      if (res.redirect_path) {
        navigate(res.redirect_path)
      } else {
        setPageInfo(res.idempotent_replay ? 'Import already applied (idempotent replay).' : 'Import completed.')
      }
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplyBusy(false)
    }
  }, [canApplyImport, confirmApply, importMode, jsonText, navigate, preview])

  const openApplyDialog = useCallback(() => {
    if (!canApplyImport) return
    if (!preview?.preview_token || !preview.ok) return
    if (!confirmApply) {
      setPageError('Enable confirmation before applying import.')
      return
    }
    applyIdempotencyKeyRef.current = null
    setPageError(null)
    setApplyDialogOpen(true)
  }, [canApplyImport, confirmApply, preview])

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Backup & Import</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-slate-600 dark:text-gdc-muted">
          Export and import portable JSON configuration for migration between environments (additive or clone). This is
          not database disaster recovery — use PostgreSQL backup/restore for that. Secrets are masked in exports;
          re-enter credentials when required.
        </p>
      </div>

      {pageError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200" role="alert">
          {pageError}
        </p>
      ) : null}
      {pageInfo ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100">
          {pageInfo}
        </p>
      ) : null}

      <section
        className={cn(
          'rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card',
        )}
        aria-label="Workspace snapshot export"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Snapshot</p>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Workspace export</h3>
            <p className="max-w-xl text-[12px] text-slate-600 dark:text-gdc-muted">
              All connectors, streams, mappings, enrichments, routes, and optional checkpoints. Destinations are included
              masked by default. Use this file for additive or clone import.
            </p>
          </div>
          <button
            type="button"
            disabled={wsBusy}
            onClick={() => void onWorkspaceDownload()}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-violet-600 px-3 text-[12px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-60"
          >
            {wsBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            Download JSON
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-slate-700 dark:text-gdc-mutedStrong">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={wsCkpt} onChange={(e) => setWsCkpt(e.target.checked)} />
            Include checkpoints
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={wsDest} onChange={(e) => setWsDest(e.target.checked)} />
            Include destinations (masked)
          </label>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <CurlImportPanel onApprove={onApproveHttpImport} />
        <PostmanImportPanel onApprove={onApproveHttpImport} />
      </div>

      <section
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
        aria-label="Import configuration"
      >
        <div className="flex flex-wrap items-center gap-2">
          <FileJson className="h-4 w-4 text-slate-500" aria-hidden />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Import JSON</h3>
        </div>
        <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">
          Upload a bundle or paste JSON, choose additive or clone mode, run preview, then confirm apply.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-100 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-rowHover">
            <Upload className="h-3.5 w-3.5" aria-hidden />
            Choose file
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
          </label>
          <select
            aria-label="Import mode"
            className="h-9 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
            value={importMode}
            onChange={(e) => {
              setImportMode(e.target.value as ImportMode)
              setPreview(null)
              setConfirmApply(false)
            }}
          >
            <option value="additive">Additive — merge without deleting</option>
            <option value="clone">Clone — suffix names</option>
          </select>
        </div>

        <div
          className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong"
          role="note"
        >
          <p className="font-semibold">{modeHelp.title}</p>
          <p className="mt-1">{modeHelp.body}</p>
        </div>

        <textarea
          aria-label="Import JSON payload"
          className="mt-3 min-h-[180px] w-full rounded-md border border-slate-200 bg-slate-50/80 p-2 font-mono text-[11px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
          placeholder='Paste export JSON (must include "connectors" array, version 1 or 2).'
          value={jsonText}
          onChange={(e) => {
            setJsonText(e.target.value)
            setPreview(null)
            setConfirmApply(false)
          }}
        />

        {!canPreviewImport || !canApplyImport ? (
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted" role="status">
            {!canPreviewImport
              ? 'Viewer role cannot run import preview or apply. Sign in as Operator or Administrator.'
              : 'Operators may preview imports; applying import requires the Administrator role.'}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={previewBusy || !jsonText.trim() || !canPreviewImport}
            onClick={() => void onRunPreview()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            {previewBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Validate & preview
          </button>
        </div>

        {preview ? (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 dark:border-gdc-border">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  preview.ok ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100' : 'bg-amber-100 text-amber-950 dark:bg-amber-900/40 dark:text-amber-100',
                )}
              >
                {preview.ok ? 'Preview OK' : 'Blocked'}
              </span>
              <span className="text-slate-600 dark:text-gdc-muted">
                Connectors {preview.counts.connectors} · Streams {preview.counts.streams} · Routes {preview.counts.routes}
              </span>
            </div>

            {preview.conflicts.length ? (
              <div className="rounded-md border border-amber-200 bg-amber-50/80 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-amber-950 dark:text-amber-100">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Conflicts
                </p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-[11px] text-amber-950 dark:text-amber-50">
                  {preview.conflicts.map((c) => (
                    <li key={`${c.code}-${c.message}`}>
                      <span className="font-mono text-[10px]">{c.code}</span> — {c.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.warnings.length ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-gdc-border dark:bg-gdc-elevated">
                <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Warnings</p>
                <ul className="mt-2 list-inside list-disc space-y-1 text-[11px] text-slate-700 dark:text-gdc-mutedStrong">
                  {preview.warnings.map((w) => (
                    <li key={`${w.code}-${w.message}`}>{w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <label className="flex items-center gap-2 text-[12px] text-slate-800 dark:text-slate-200">
              <input type="checkbox" checked={confirmApply} onChange={(e) => setConfirmApply(e.target.checked)} />
              I reviewed the preview and want to apply this import.
            </label>
            <button
              type="button"
              disabled={applyBusy || !preview.ok || !preview.preview_token || !canApplyImport}
              title={!canApplyImport ? 'Administrator role required to apply import.' : undefined}
              onClick={() => openApplyDialog()}
              data-testid="backup-apply-open"
              className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-900 px-3 text-[12px] font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
            >
              {applyBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Apply import
            </button>
          </div>
        ) : null}
      </section>

      {applyDialogOpen ? (
        <DangerousActionDialog
          open
          onOpenChange={(open) => {
            if (!open && !applyBusy) {
              setApplyDialogOpen(false)
            }
          }}
          title="Apply import?"
          targetName={`${MODE_HELP[importMode].title} · mode=${importMode}`}
          risk="high"
          confirmMode="click"
          impactBullets={[
            'Applies the selected import mode to the current workspace without deleting existing configuration.',
            'Matching display names may create additional entities depending on mode.',
            'Preview token must match the latest preview; stale previews are rejected.',
            'Secrets remain masked — re-enter credentials after import when required.',
          ]}
          dependencies={[{ label: 'Mode', detail: importMode }]}
          reversibility="Import effects depend on mode; keep a fresh export before applying. Database disaster recovery uses PostgreSQL backup/restore, not JSON import."
          primaryLabel="Apply import"
          busy={applyBusy}
          error={pageError}
          onConfirm={() => void onApply()}
          dataTestId="backup-apply-dialog"
        />
      ) : null}
    </div>
  )
}
