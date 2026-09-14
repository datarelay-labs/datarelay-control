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

const MODE_HELP: Record<ImportMode, { title: string; body: string; destructive?: boolean }> = {
  full_restore: {
    title: 'Full restore (snapshot replacement)',
    body: 'Replaces all connectors, streams, routes, destinations, and related configuration with the backup snapshot. Existing operational entities are removed first. Platform admin accounts, delivery logs, and migration history are preserved.',
    destructive: true,
  },
  additive: {
    title: 'Merge import (additive)',
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
  const [importMode, setImportMode] = useState<ImportMode>('full_restore')
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [confirmDestructive, setConfirmDestructive] = useState(false)
  const [applyDialogOpen, setApplyDialogOpen] = useState(false)
  const [confirmTypeValue, setConfirmTypeValue] = useState('')
  const [pageError, setPageError] = useState<string | null>(null)
  const [pageInfo, setPageInfo] = useState<string | null>(null)
  const applyIdempotencyKeyRef = useRef<string | null>(null)
  const isFullRestore = importMode === 'full_restore'
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
      setConfirmDestructive(false)
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
    if (isFullRestore && !confirmDestructive) {
      setPageError('Acknowledge the destructive full restore scope before applying.')
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
        confirm_destructive: isFullRestore ? true : false,
        idempotency_key: applyIdempotencyKeyRef.current,
      })
      applyIdempotencyKeyRef.current = null
      setApplyDialogOpen(false)
      setConfirmTypeValue('')
      if (res.redirect_path) {
        navigate(res.redirect_path)
      } else {
        setPageInfo(
          res.idempotent_replay
            ? 'Import already applied (idempotent replay).'
            : isFullRestore
              ? 'Full restore completed. Platform configuration matches the snapshot.'
              : 'Import completed.',
        )
      }
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplyBusy(false)
    }
  }, [canApplyImport, confirmApply, confirmDestructive, importMode, isFullRestore, jsonText, navigate, preview])

  const openApplyDialog = useCallback(() => {
    if (!canApplyImport) return
    if (!preview?.preview_token || !preview.ok) return
    if (!confirmApply) {
      setPageError('Enable confirmation before applying import.')
      return
    }
    if (isFullRestore && !confirmDestructive) {
      setPageError('Acknowledge the destructive full restore scope before applying.')
      return
    }
    applyIdempotencyKeyRef.current = null
    setPageError(null)
    setConfirmTypeValue('')
    setApplyDialogOpen(true)
  }, [canApplyImport, confirmApply, confirmDestructive, isFullRestore, preview])

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Backup & Import</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-slate-600 dark:text-gdc-muted">
          Export portable JSON snapshots, preview validation, then restore with full snapshot replacement (default for
          disaster recovery) or merge import for additive migration. Secrets are masked in exports; re-enter credentials
          when required.
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
              masked by default. Use this file for full restore.
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
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Restore JSON</h3>
        </div>
        <p className="mt-1 text-[12px] text-slate-600 dark:text-gdc-muted">Upload a bundle or paste JSON, choose restore mode, run preview, then confirm apply.</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-[12px] font-semibold text-slate-800 hover:bg-slate-100 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-100 dark:hover:bg-gdc-rowHover">
            <Upload className="h-3.5 w-3.5" aria-hidden />
            Choose file
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
          </label>
          <select
            aria-label="Restore mode"
            className={cn(
              'h-9 rounded-md border px-2 text-[12px] dark:bg-gdc-card dark:text-slate-100',
              isFullRestore
                ? 'border-red-300 bg-red-50 font-semibold text-red-950 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100'
                : 'border-slate-200 bg-white dark:border-gdc-border',
            )}
            value={importMode}
            onChange={(e) => {
              setImportMode(e.target.value as ImportMode)
              setPreview(null)
              setConfirmApply(false)
              setConfirmDestructive(false)
            }}
          >
            <option value="full_restore">Full restore — replace snapshot (destructive)</option>
            <option value="additive">Merge import — additive (non-destructive)</option>
            <option value="clone">Clone — suffix names (non-destructive)</option>
          </select>
        </div>

        <div
          className={cn(
            'mt-3 rounded-md border p-3 text-[12px]',
            modeHelp.destructive
              ? 'border-red-200 bg-red-50/90 text-red-950 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-50'
              : 'border-slate-200 bg-slate-50 text-slate-800 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong',
          )}
          role="note"
        >
          <p className="flex items-center gap-1 font-semibold">
            {modeHelp.destructive ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            {modeHelp.title}
          </p>
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
            setConfirmDestructive(false)
          }}
        />

        {!canPreviewImport || !canApplyImport ? (
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted" role="status">
            {!canPreviewImport
              ? 'Viewer role cannot run import preview or apply. Sign in as Operator or Administrator.'
              : 'Operators may preview imports; applying restore requires the Administrator role.'}
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

            {isFullRestore && preview.full_restore_purge ? (
              <div className="rounded-md border border-red-200 bg-red-50/80 p-3 dark:border-red-900/50 dark:bg-red-950/30">
                <p className="flex items-center gap-1 text-[11px] font-semibold text-red-950 dark:text-red-100">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  Will remove existing configuration
                </p>
                <ul className="mt-2 list-inside list-disc space-y-0.5 text-[11px] text-red-950 dark:text-red-50">
                  <li>{preview.full_restore_purge.connectors} connectors</li>
                  <li>{preview.full_restore_purge.streams} streams</li>
                  <li>{preview.full_restore_purge.destinations} destinations</li>
                  <li>{preview.full_restore_purge.routes} routes</li>
                  {preview.full_restore_purge.continuous_validations > 0 ? (
                    <li>{preview.full_restore_purge.continuous_validations} continuous validations</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

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
              {isFullRestore
                ? 'I reviewed the preview and want to replace operational configuration with this snapshot.'
                : 'I reviewed the preview and want to apply this import.'}
            </label>
            {isFullRestore ? (
              <label className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/60 p-2 text-[12px] font-semibold text-red-950 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-100">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmDestructive}
                  onChange={(e) => setConfirmDestructive(e.target.checked)}
                />
                I understand this is a destructive full restore: all existing connectors, streams, routes, and destinations
                will be permanently removed and replaced by the backup contents.
              </label>
            ) : null}
            <button
              type="button"
              disabled={applyBusy || !preview.ok || !preview.preview_token || !canApplyImport}
              title={!canApplyImport ? 'Administrator role required to apply restore.' : undefined}
              onClick={() => openApplyDialog()}
              data-testid="backup-apply-open"
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md px-3 text-[12px] font-semibold text-white disabled:opacity-50',
                isFullRestore
                  ? 'bg-red-700 hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500'
                  : 'bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white',
              )}
            >
              {applyBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {isFullRestore ? 'Apply full restore' : 'Apply import'}
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
              setConfirmTypeValue('')
            }
          }}
          title={isFullRestore ? 'Apply destructive full restore?' : 'Apply import?'}
          targetName={`${MODE_HELP[importMode].title} · mode=${importMode}`}
          risk={isFullRestore ? 'critical' : 'high'}
          confirmMode={isFullRestore ? 'type-name' : 'click'}
          expectedTypeName={isFullRestore ? 'FULL RESTORE' : ''}
          typeNameValue={confirmTypeValue}
          onTypeNameChange={setConfirmTypeValue}
          impactBullets={
            isFullRestore
              ? [
                  'Removes existing connectors, streams, routes, and destinations, then recreates them from the snapshot.',
                  'Running streams must be stopped first; the backend rejects full restore while any stream is RUNNING.',
                  'Preview token must match the latest preview; stale previews are rejected.',
                  'Secrets remain masked — re-enter credentials after restore when required.',
                ]
              : [
                  'Applies the selected import mode to the current workspace.',
                  'Matching entities may be overwritten depending on mode.',
                  'Preview token must match the latest preview; stale previews are rejected.',
                ]
          }
          dependencies={
            isFullRestore && preview?.full_restore_purge
              ? [
                  { label: 'Connectors replaced', count: preview.full_restore_purge.connectors },
                  { label: 'Streams replaced', count: preview.full_restore_purge.streams },
                  { label: 'Destinations replaced', count: preview.full_restore_purge.destinations },
                  { label: 'Routes replaced', count: preview.full_restore_purge.routes },
                ]
              : [{ label: 'Mode', detail: importMode }]
          }
          reversibility={
            isFullRestore
              ? 'Full restore is not reversible except by importing a prior backup.'
              : 'Import effects depend on mode; keep a fresh export before applying.'
          }
          primaryLabel={isFullRestore ? 'Apply full restore' : 'Apply import'}
          busy={applyBusy}
          error={pageError}
          onConfirm={() => void onApply()}
          dataTestId="backup-apply-dialog"
        />
      ) : null}
    </div>
  )
}
