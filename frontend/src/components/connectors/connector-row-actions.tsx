import { Loader2, MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { connectorStreamsFilterPath, type ConnectorDashboardRow } from '../../lib/connector-operational-health'
import { connectorDetailPath } from '../../config/nav-paths'
import { runConnectorAuthCheck, runConnectorQueryTest } from '../../api/gdcConnectorsOperations'

type ConnectorRowActionsProps = {
  row: ConnectorDashboardRow
  onAuthCheckStart?: () => void
  onAuthCheckEnd?: () => void
  onAuthCheckComplete: (connectorId: number, patch: { last_auth_check_at: string; last_auth_check_status: 'success' | 'failed'; last_auth_error: string | null }) => void
  onDelete: () => void
  onViewStreams?: () => void
}

export function ConnectorRowActions({ row, onAuthCheckStart, onAuthCheckEnd, onAuthCheckComplete, onDelete, onViewStreams }: ConnectorRowActionsProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'auth' | 'query' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  async function onTestAuth() {
    setBusy('auth')
    setOpen(false)
    onAuthCheckStart?.()
    try {
      const res = await runConnectorAuthCheck(row.id)
      onAuthCheckComplete(row.id, {
        last_auth_check_at: res.last_auth_check_at,
        last_auth_check_status: res.last_auth_check_status,
        last_auth_error: res.last_auth_error,
      })
      setToast(res.success ? 'Auth test succeeded' : res.last_auth_error ?? 'Auth test failed')
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      onAuthCheckEnd?.()
    }
  }

  async function onTestQuery() {
    setBusy('query')
    setOpen(false)
    try {
      const res = await runConnectorQueryTest(row.id)
      setToast(res.message)
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  function onViewStreamsClick() {
    setOpen(false)
    if (onViewStreams) {
      onViewStreams()
      return
    }
    navigate(connectorStreamsFilterPath(row.id, row.name))
  }

  return (
    <div ref={rootRef} className="relative flex items-center justify-end gap-1">
      {toast ? (
        <span
          role="status"
          data-testid="connector-row-auth-result"
          title={toast}
          className={
            /succeed|success/i.test(toast)
              ? 'max-w-[240px] truncate rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/40 dark:text-emerald-100'
              : /fail|error|invalid|denied|unauthor/i.test(toast)
                ? 'max-w-[240px] truncate rounded border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-100'
                : 'max-w-[240px] truncate rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-800 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'
          }
        >
          {toast}
        </span>
      ) : null}
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" aria-hidden /> : null}
      <Link
        to={connectorDetailPath(String(row.id))}
        className="inline-flex h-7 items-center rounded px-2 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
      >
        Edit
      </Link>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover"
        aria-label="Connector actions"
        data-testid="connector-row-actions-trigger"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-gdc-border dark:bg-gdc-card"
          role="menu"
          data-testid="connector-row-actions-menu"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover disabled:opacity-50"
            disabled={busy === 'auth'}
            onClick={() => void onTestAuth()}
          >
            {busy === 'auth' ? 'Testing…' : 'Test Auth'}
          </button>
          <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover" onClick={() => void onTestQuery()}>
            Test Query
          </button>
          <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-gdc-rowHover" onClick={onViewStreamsClick}>
            View Streams
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}
