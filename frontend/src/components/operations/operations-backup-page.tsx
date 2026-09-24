import { AlertTriangle, Download, FileJson, HardDrive, Loader2, Upload } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  buildWorkspaceExportPath,
  downloadBackupUrl,
  postImportApply,
  postImportPreview,
  type CurlImportDraft,
  type ImportMode,
  type ImportPreviewResult,
} from '../../api/gdcBackup'
import { NAV_PATH, SETTINGS_SECTION_PATH } from '../../config/nav-paths'
import { cn } from '../../lib/utils'
import { useSessionCapabilities } from '../../lib/rbac'
import { gdcUi } from '../../lib/gdc-ui-tokens'
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

const SECTION_STEP = 'text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted'

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
  const [helpersOpen, setHelpersOpen] = useState(false)
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
    <div className="flex w-full min-w-0 flex-col gap-6" data-testid="operations-backup-page">
      <header className="space-y-3 border-b border-slate-200/80 pb-5 dark:border-gdc-divider">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">Backup & Import</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
              Portable JSON configuration recovery for migration between environments. Follow export → choose source →
              validate & preview → review impact → explicit apply.
            </p>
          </div>
          <Link
            to={SETTINGS_SECTION_PATH.retention}
            className="inline-flex h-9 items-center rounded-lg border border-slate-200/90 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
          >
            Retention / cleanup
          </Link>
        </div>
        <div
          role="note"
          data-testid="backup-authority-banner"
          className="rounded-xl border border-sky-500/25 bg-sky-500/[0.07] px-4 py-3 text-sm text-sky-950 dark:border-sky-500/35 dark:bg-sky-500/10 dark:text-sky-100"
        >
          <p className="font-semibold">JSON export/import is additive or clone only — not database disaster recovery.</p>
          <p className="mt-1 leading-relaxed opacity-90">
            Secrets are masked in exports; re-enter credentials when required. PostgreSQL backup/restore remains the
            database recovery path and is intentionally separate from this workspace.
          </p>
        </div>
      </header>

      {pageError ? (
        <p
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
          role="alert"
        >
          {pageError}
        </p>
      ) : null}
      {pageInfo ? (
        <p
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100"
          role="status"
        >
          {pageInfo}
        </p>
      ) : null}

      <section
        className={cn(gdcUi.cardShell, 'overflow-hidden')}
        aria-labelledby="backup-export-heading"
        data-testid="backup-export-section"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-5 dark:border-gdc-border md:px-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
              <Download className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className={SECTION_STEP}>Step 1 · Export</p>
              <h3 id="backup-export-heading" className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-50">
                Export current workspace
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Download connectors, streams, mappings, enrichments, routes, and optional checkpoints. Destinations are
                included masked by default.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={wsBusy}
            onClick={() => void onWorkspaceDownload()}
            className={cn(gdcUi.primaryBtn, 'inline-flex h-9 items-center gap-2 px-3')}
          >
            {wsBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            Download JSON
          </button>
        </div>
        <div className="flex flex-wrap gap-4 px-4 py-4 text-sm text-slate-700 dark:text-gdc-mutedStrong md:px-6">
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

      <section
        className={cn(gdcUi.cardShell, 'overflow-hidden')}
        aria-labelledby="backup-import-heading"
        data-testid="backup-import-section"
      >
        <div className="space-y-6 px-4 py-5 md:px-6 md:py-6">
          <div className="flex min-w-0 gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.07] text-sky-700 dark:border-sky-400/35 dark:bg-sky-500/15 dark:text-sky-100">
              <Upload className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className={SECTION_STEP}>Step 2–5 · Import</p>
              <h3 id="backup-import-heading" className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-50">
                Choose source, validate, review, apply
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
                Upload a bundle or paste JSON, choose additive or clone mode, run preview, then confirm apply. Retired
                full restore is not offered.
              </p>
            </div>
          </div>

          <div data-testid="backup-import-source" className="space-y-3">
            <p className={SECTION_STEP}>Choose / import source</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-100 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-rowHover">
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Choose file
                <input
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <select
                aria-label="Import mode"
                className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
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
              className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong"
              role="note"
            >
              <p className="font-semibold">{modeHelp.title}</p>
              <p className="mt-1">{modeHelp.body}</p>
            </div>
            <textarea
              aria-label="Import JSON payload"
              className="min-h-[180px] w-full rounded-lg border border-slate-200 bg-slate-50/80 p-3 font-mono text-[11px] text-slate-900 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100"
              placeholder='Paste export JSON (must include "connectors" array, version 1 or 2).'
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value)
                setPreview(null)
                setConfirmApply(false)
              }}
            />
          </div>

          <div data-testid="backup-import-preview" className="space-y-3 border-t border-slate-100 pt-6 dark:border-gdc-border">
            <p className={SECTION_STEP}>Validate & preview</p>
            {!canPreviewImport || !canApplyImport ? (
              <p className="text-sm text-slate-600 dark:text-gdc-muted" role="status">
                {!canPreviewImport
                  ? 'Viewer role cannot run import preview or apply. Sign in as Operator or Administrator.'
                  : 'Operators may preview imports; applying import requires the Administrator role.'}
              </p>
            ) : null}
            <button
              type="button"
              disabled={previewBusy || !jsonText.trim() || !canPreviewImport}
              onClick={() => void onRunPreview()}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
            >
              {previewBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileJson className="h-4 w-4" aria-hidden />}
              Validate & preview
            </button>

            {preview ? (
              <div className="space-y-3" data-testid="backup-preview-result">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-semibold',
                      preview.ok
                        ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100'
                        : 'bg-amber-100 text-amber-950 dark:bg-amber-900/40 dark:text-amber-100',
                    )}
                  >
                    {preview.ok ? 'Preview OK' : 'Blocked'}
                  </span>
                  <span className="text-slate-600 dark:text-gdc-muted">
                    Connectors {preview.counts.connectors} · Streams {preview.counts.streams} · Routes{' '}
                    {preview.counts.routes}
                  </span>
                </div>

                {preview.conflicts.length ? (
                  <div
                    className="rounded-lg border border-amber-200 bg-amber-50/80 p-3 dark:border-amber-900/50 dark:bg-amber-950/30"
                    role="alert"
                  >
                    <p className="flex items-center gap-1 text-xs font-semibold text-amber-950 dark:text-amber-100">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      Conflicts
                    </p>
                    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-amber-950 dark:text-amber-50">
                      {preview.conflicts.map((c) => (
                        <li key={`${c.code}-${c.message}`}>
                          <span className="font-mono text-[10px]">{c.code}</span> — {c.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {preview.warnings.length ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-gdc-border dark:bg-gdc-elevated">
                    <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Warnings</p>
                    <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-slate-700 dark:text-gdc-mutedStrong">
                      {preview.warnings.map((w) => (
                        <li key={`${w.code}-${w.message}`}>{w.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-gdc-border">
                  <p className={SECTION_STEP}>Explicit apply</p>
                  <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
                    <input type="checkbox" checked={confirmApply} onChange={(e) => setConfirmApply(e.target.checked)} />
                    I reviewed the preview and want to apply this import.
                  </label>
                  <button
                    type="button"
                    disabled={applyBusy || !preview.ok || !preview.preview_token || !canApplyImport}
                    title={!canApplyImport ? 'Administrator role required to apply import.' : undefined}
                    onClick={() => openApplyDialog()}
                    data-testid="backup-apply-open"
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                  >
                    {applyBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                    Apply import
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className={cn(gdcUi.cardShell, 'px-4 py-4 md:px-6')}
        aria-labelledby="backup-pg-dr-heading"
        data-testid="backup-postgres-dr-note"
      >
        <div className="flex gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200">
            <HardDrive className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h3 id="backup-pg-dr-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              PostgreSQL disaster recovery
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-gdc-muted">
              Full database backup and restore stay outside this JSON workspace. Use the platform PostgreSQL backup/restore
              procedures when you need disaster recovery rather than configuration migration.
            </p>
          </div>
        </div>
      </section>

      <section className={cn(gdcUi.cardShell, 'overflow-hidden')} aria-labelledby="backup-helpers-heading">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left md:px-6"
          aria-expanded={helpersOpen}
          onClick={() => setHelpersOpen((v) => !v)}
        >
          <div>
            <p className={SECTION_STEP}>Optional helpers</p>
            <h3 id="backup-helpers-heading" className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-50">
              cURL / Postman connector import
            </h3>
          </div>
          <span className="text-xs font-semibold text-slate-600 dark:text-gdc-muted">
            {helpersOpen ? 'Hide' : 'Show'}
          </span>
        </button>
        {helpersOpen ? (
          <div className="grid gap-4 border-t border-slate-100 px-4 py-4 dark:border-gdc-border md:px-6 lg:grid-cols-2">
            <CurlImportPanel onApprove={onApproveHttpImport} />
            <PostmanImportPanel onApprove={onApproveHttpImport} />
          </div>
        ) : null}
      </section>

      <p className="text-sm text-slate-600 dark:text-gdc-muted">
        <Link to={NAV_PATH.administration} className="font-semibold text-gdc-primary hover:underline">
          Back to Administration
        </Link>
      </p>

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
