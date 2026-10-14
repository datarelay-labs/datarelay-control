import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyAdminConfigSnapshot,
  getAdminConfigVersions,
  getAdminSafeRollbackPreview,
  type ConfigSafeRollbackPreviewDto,
  type ConfigVersionDto,
} from '../../api/gdcAdmin'
import type { StreamRuntimeStatus } from '../../api/streamRows'

type Props = {
  streamId: number
  runtimeStatus: StreamRuntimeStatus
  canRestore: boolean
  restoreBlocked: boolean
  onRestored: () => Promise<void> | void
}

export function StreamConfigurationRevisions({
  streamId,
  runtimeStatus,
  canRestore,
  restoreBlocked,
  onRestored,
}: Props) {
  const [versions, setVersions] = useState<ConfigVersionDto[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ConfigSafeRollbackPreviewDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadVersions = useCallback(async () => {
    try {
      const result = await getAdminConfigVersions({
        limit: 8,
        entity_type: 'STREAM_CONFIG',
        entity_id: streamId,
      })
      setVersions([...result.items].sort((a, b) => b.version - a.version))
      setHistoryError(null)
    } catch (cause) {
      setVersions([])
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [streamId])

  useEffect(() => {
    setPreview(null)
    setMessage(null)
    setError(null)
    void loadVersions()
  }, [loadVersions])

  const currentVersion = useMemo(
    () => versions.reduce((max, item) => Math.max(max, item.version), 0),
    [versions],
  )
  const runtimeStopped = runtimeStatus === 'STOPPED' || runtimeStatus === 'IDLE'
  const restoreAllowed =
    canRestore &&
    !restoreBlocked &&
    runtimeStopped &&
    preview != null &&
    preview.product_apply_required &&
    preview.may_submit_to_product_authority &&
    preview.blockers.length === 0

  const review = async (version: ConfigVersionDto) => {
    if (busy || currentVersion <= 0) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setPreview(await getAdminSafeRollbackPreview(version.id, currentVersion, 'after'))
    } catch (cause) {
      setPreview(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!preview || !restoreAllowed || busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await applyAdminConfigSnapshot(preview.source_version_row_id, {
        target: 'after',
        expected_version: preview.current_version,
      })
      setMessage(`Restored as saved revision v${result.new_monotonic_version}. Runtime was not started.`)
      setPreview(null)
      await loadVersions()
      await onRestored()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="stream-configuration-revisions"
      className="rounded-lg border border-slate-200/80 bg-white p-3 text-xs dark:border-gdc-border dark:bg-gdc-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Saved revision history</h3>
          <p className="mt-1 text-slate-600 dark:text-gdc-muted">
            {currentVersion > 0 ? `Current saved revision v${currentVersion}` : 'Saved revision is unavailable.'}
            {' · '}
            {runtimeStatus === 'RUNNING'
              ? 'Exact running revision is not reported by the runtime API.'
              : 'No running revision is active.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadVersions()}
          disabled={busy}
          className="font-semibold text-gdc-primary hover:underline disabled:opacity-60"
        >
          Refresh history
        </button>
      </div>

      {historyError ? (
        <p role="status" className="mt-2 text-amber-700 dark:text-amber-200">
          Revision history unavailable: {historyError}
        </p>
      ) : null}

      {versions.length > 0 ? (
        <div className="mt-3 space-y-1">
          {versions.map((version) => (
            <div
              key={version.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 dark:border-gdc-border/60"
            >
              <span>
                <strong className="font-mono">v{version.version}</strong>
                {' · '}
                {version.summary || 'Saved configuration'}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void review(version)}
                className="font-semibold text-gdc-primary hover:underline disabled:opacity-60"
              >
                Review v{version.version}
              </button>
            </div>
          ))}
        </div>
      ) : !historyError ? (
        <p className="mt-2 text-slate-500 dark:text-gdc-muted">No saved Stream revisions are available yet.</p>
      ) : null}

      {preview ? (
        <div
          data-testid="stream-revision-restore-preview"
          className="mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-gdc-border dark:bg-gdc-card"
        >
          <p className="font-semibold">Review v{preview.source_version} against current v{preview.current_version}</p>
          <p className="text-slate-600 dark:text-gdc-muted">
            Preview or restore never starts the Stream or delivers data.
          </p>
          {preview.changed_fields.map((change) => (
            <p key={change.path} className="font-mono text-[11px]">
              {change.path}: {change.before ?? '—'} → {change.after ?? '—'}
            </p>
          ))}
          {preview.blockers.length > 0 ? (
            <p role="status" className="text-amber-700 dark:text-amber-200">
              Restore blocked: {preview.blockers.join(', ').replaceAll('_', ' ')}
            </p>
          ) : null}
          {!canRestore ? (
            <p className="text-slate-500 dark:text-gdc-muted">Administrator permission is required to restore.</p>
          ) : restoreBlocked ? (
            <p className="text-amber-700 dark:text-amber-200">Save or discard the local draft before restoring.</p>
          ) : !runtimeStopped ? (
            <p className="text-amber-700 dark:text-amber-200">Stop the Stream before restoring.</p>
          ) : !preview.may_submit_to_product_authority ? (
            <p className="text-amber-700 dark:text-amber-200">Current safety review does not authorize this restore.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setPreview(null)
                setError(null)
              }}
              disabled={busy}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 disabled:opacity-50 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
            >
              Cancel review
            </button>
            {canRestore ? (
              <button
                type="button"
                data-testid="stream-revision-restore-confirm"
                disabled={!restoreAllowed || busy}
                onClick={() => void restore()}
                className="rounded-md bg-gdc-primary px-3 py-1.5 font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Restoring…' : 'Restore reviewed revision'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="mt-2 text-red-700 dark:text-red-300">{error}</p> : null}
      {message ? <p role="status" className="mt-2 text-emerald-700 dark:text-emerald-200">{message}</p> : null}
    </section>
  )
}
