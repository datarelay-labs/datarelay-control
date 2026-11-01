import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchGovernanceViolations,
  type GovernanceViolationEntry,
} from '../../api/gdcGovernanceViolations'
import { searchRuntimeDeliveryLogs } from '../../api/gdcRuntime'
import { logsExplorerPath, NAV_PATH } from '../../config/nav-paths'
import { useGovernanceCapabilities } from '../../lib/governance-rbac'
import type { StreamGovernanceSnapshot } from '../../lib/stream-governance-snapshot'
import { SensitiveFindingsPanel } from './sensitive-findings-panel'

const BLOCK_LOG_LIMIT = 100

type BlockedState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; count: number; capped: boolean }

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; total: number; violations: GovernanceViolationEntry[] }

function statusText(status: GovernanceViolationEntry['status']): string {
  return status.charAt(0) + status.slice(1).toLowerCase()
}

/**
 * Violations tab body for one Stream: the governance violations recorded for it and the sensitive
 * findings browser, so a "Review protection findings" link lands on evidence and actions instead of
 * a summary card (F-184).
 */
export function StreamViolationsDrilldown({
  streamId,
  canOperate,
  governanceSnapshot,
}: {
  streamId: number
  canOperate: boolean
  governanceSnapshot?: StreamGovernanceSnapshot | null
}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [blocked, setBlocked] = useState<BlockedState>({ kind: 'loading' })
  const canOpenViolationCenter = useGovernanceCapabilities().governance_read === true

  useEffect(() => {
    let cancelled = false
    setBlocked({ kind: 'loading' })
    void searchRuntimeDeliveryLogs({
      stream_id: streamId,
      stage: 'policy_blocked',
      window: '24h',
      limit: BLOCK_LOG_LIMIT,
    })
      .then((resp) => {
        if (cancelled) return
        setBlocked(
          resp == null
            ? { kind: 'unavailable' }
            : { kind: 'ready', count: resp.total_returned, capped: resp.total_returned >= BLOCK_LOG_LIMIT },
        )
      })
      .catch(() => {
        if (!cancelled) setBlocked({ kind: 'unavailable' })
      })
    return () => {
      cancelled = true
    }
  }, [streamId])

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    void fetchGovernanceViolations({ stream_id: streamId, window: '30d', limit: 20 })
      .then((resp) => {
        if (cancelled) return
        setState(resp == null ? { kind: 'error' } : { kind: 'ready', total: resp.total, violations: resp.violations })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [streamId])

  return (
    <section className="space-y-3" data-testid="stream-violations-drilldown" aria-label="Stream violations">
      <div className="rounded-lg border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card">
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          Governance violations (last 30 days)
        </h3>
        {state.kind === 'loading' ? (
          <p className="mt-2 text-xs text-slate-500" data-testid="stream-violations-loading">
            Loading violations...
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" data-testid="stream-violations-error">
            Governance violations are unavailable right now. This is not evidence that the stream has none.
          </p>
        ) : null}
        {state.kind === 'ready' && state.violations.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600 dark:text-gdc-muted" data-testid="stream-violations-empty">
            No governance violations were recorded for this stream in the last 30 days.
          </p>
        ) : null}
        {state.kind === 'ready' && state.violations.length > 0 ? (
          <>
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-gdc-border" data-testid="stream-violations-list">
              {state.violations.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="min-w-0 text-slate-800 dark:text-slate-100">
                    <span className="font-semibold">{v.policy_name}</span> - {v.reason}
                  </span>
                  <span className="flex items-center gap-2 text-slate-600 dark:text-gdc-muted">
                    <span>{statusText(v.status)}</span>
                    <span>{v.severity.charAt(0) + v.severity.slice(1).toLowerCase()}</span>
                    {canOpenViolationCenter ? (
                      <Link
                        to={`${NAV_PATH.governanceViolations}?id=${encodeURIComponent(v.id)}`}
                        className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                        data-testid={`stream-violation-open-${v.id}`}
                      >
                        Investigate
                      </Link>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {state.total > state.violations.length ? (
              <p className="mt-2 text-[11px] text-slate-500">
                Showing {state.violations.length} of {state.total}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      <div
        className="rounded-lg border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
        data-testid="stream-policy-blocked"
      >
        <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          Blocked by policy (last 24 hours)
        </h3>
        <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
          Policy Block drops the whole event batch for a route. Blocked events do not create violations or
          quarantine items, so this count comes from the runtime log.
        </p>
        {blocked.kind === 'loading' ? <p className="mt-2 text-xs text-slate-500">Loading...</p> : null}
        {blocked.kind === 'unavailable' ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" data-testid="stream-policy-blocked-unavailable">
            Policy block evidence is unavailable. Absence of a count does not prove nothing was blocked.
          </p>
        ) : null}
        {blocked.kind === 'ready' ? (
          <p className="mt-2 text-xs text-slate-800 dark:text-slate-100" data-testid="stream-policy-blocked-count">
            {blocked.count === 0
              ? 'No policy blocks were logged for this stream in the last 24 hours.'
              : `${blocked.count}${blocked.capped ? '+' : ''} policy block${blocked.count === 1 ? '' : 's'} logged.`}{' '}
            {blocked.count > 0 ? (
              <Link
                to={logsExplorerPath({ stream_id: streamId, stage: 'policy_blocked' })}
                className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                data-testid="stream-policy-blocked-logs"
              >
                View blocked events in Logs
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>
      <SensitiveFindingsPanel
        streamId={streamId}
        canOperate={canOperate}
        initialSummary={governanceSnapshot?.sensitive}
      />
    </section>
  )
}
