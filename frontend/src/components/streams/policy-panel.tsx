import { Loader2, RefreshCw, Scale } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchStreamPolicyRules,
  fetchStreamPolicySummary,
  type PolicyRule,
  type StreamPolicySummaryResponse,
} from '../../api/gdcPolicy'
import {
  fetchRoutePolicyEffective,
  fetchRoutePolicyRules,
  patchRoutePolicyRule,
  type RoutePolicyEffective,
  type RoutePolicyRule,
} from '../../api/gdcRoutePolicy'
import { compatibleGovernancePreload } from '../../lib/stream-governance-snapshot'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

function countPolicyMetrics(rules: Array<PolicyRule | RoutePolicyRule>) {
  const enabled = rules.filter((r) => r.enabled)
  return {
    total_policies: rules.length,
    matched_policies: 0,
    audit_events: 0,
    enabled_policy_count: enabled.length,
    disabled_policy_count: rules.length - enabled.length,
  }
}

export function PolicyPanel({
  streamId,
  routeId,
  canOperate,
  onEffectiveChange,
  initialSummary,
  initialEffective,
}: {
  streamId: number
  routeId?: number
  canOperate?: boolean
  onEffectiveChange?: (effective: RoutePolicyEffective | null) => void
  initialSummary?: StreamPolicySummaryResponse | null
  initialEffective?: RoutePolicyEffective | null
}) {
  const isRouteScope = routeId != null
  const preload = !isRouteScope ? compatibleGovernancePreload(streamId, initialSummary) : undefined
  const preloadRef = useRef(preload)
  preloadRef.current = preload
  const effectivePreload =
    isRouteScope && routeId != null && initialEffective != null && initialEffective.route_id === routeId
      ? initialEffective
      : undefined
  const effectivePreloadRef = useRef(effectivePreload)
  effectivePreloadRef.current = effectivePreload
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [summary, setSummary] = useState<StreamPolicySummaryResponse | null>(preload ?? null)
  const [routeEffective, setRouteEffective] = useState<RoutePolicyEffective | null>(effectivePreload ?? null)
  const [rules, setRules] = useState<Array<PolicyRule | RoutePolicyRule>>([])

  useEffect(() => {
    if (preload != null) setSummary(preload)
  }, [preload])

  const load = useCallback(async (opts?: { skipSummary?: boolean; skipEffective?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      if (isRouteScope) {
        const skipEffective = opts?.skipEffective === true && effectivePreloadRef.current != null
        const [r, effective] = await Promise.all([
          fetchRoutePolicyRules(routeId),
          skipEffective ? Promise.resolve(effectivePreloadRef.current) : fetchRoutePolicyEffective(routeId),
        ])
        onEffectiveChange?.(effective)
        setRouteEffective(effective)
        const routeRules = r?.rules ?? []
        setRules(routeRules)
        const counts = countPolicyMetrics(routeRules)
        setSummary({
          stream_id: streamId,
          ...counts,
          last_evaluated_at: null,
        })
        if (r == null) setError('Policy APIs unavailable.')
        return
      }

      const skipSummary = opts?.skipSummary === true
      if (skipSummary) {
        const r = await fetchStreamPolicyRules(streamId)
        setRules(r?.rules ?? [])
        if (preloadRef.current == null && r == null) {
          setError('Policy APIs unavailable.')
        }
        return
      }

      const [s, r] = await Promise.all([
        fetchStreamPolicySummary(streamId),
        fetchStreamPolicyRules(streamId),
      ])
      setSummary(s)
      setRules(r?.rules ?? [])
      if (s == null && r == null) {
        setError('Policy APIs unavailable.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [isRouteScope, onEffectiveChange, routeId, streamId])

  useEffect(() => {
    const skipSummary = !isRouteScope && preloadRef.current != null
    const skipEffective = isRouteScope && effectivePreloadRef.current != null
    void load({ skipSummary, skipEffective })
  }, [streamId, routeId, isRouteScope, load])

  async function onToggleEnabled(rule: PolicyRule | RoutePolicyRule) {
    if (!canOperate || !isRouteScope) return
    setActionBusy(true)
    setMessage(null)
    try {
      await patchRoutePolicyRule(routeId, rule.id, { enabled: !rule.enabled })
      setMessage('Rule updated.')
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <section
      className="rounded-xl border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Policy"
      data-testid="policy-summary"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          <Scale className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          Policy
        </p>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200/90 px-2 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:text-slate-200 dark:hover:bg-gdc-rowHover"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          Refresh
        </button>
      </div>

      {error ? (
        <p className="mt-2 text-[11px] text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-2 text-[11px] font-medium text-emerald-800 dark:text-emerald-200" role="status">
          {message}
        </p>
      ) : null}

      <p className="mt-3 text-[11px] font-semibold text-slate-700 dark:text-slate-200">Policy metrics</p>
      <dl className="mt-1 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3" data-testid="policy-metrics">
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Total policies</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {summary?.total_policies ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Matched policies</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {isRouteScope ? '—' : (summary?.matched_policies ?? '—')}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-gdc-muted">Audit events</dt>
          <dd className="font-semibold text-slate-900 dark:text-slate-100">
            {isRouteScope ? '—' : (summary?.audit_events ?? '—')}
          </dd>
        </div>
      </dl>

      <div className="mt-3 overflow-x-auto" data-testid="policy-rules-table">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Name</th>
              <th className={opTh}>Condition</th>
              <th className={opTh}>Action</th>
              <th className={opTh}>Enabled</th>
              {canOperate && isRouteScope ? <th className={opTh}>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr className={opTr}>
                <td
                  className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')}
                  colSpan={canOperate && isRouteScope ? 5 : 4}
                >
                  {loading ? 'Loading…' : routeEffective && routeEffective.rule_count > 0 ? 'No route-local policy rules. Effective ' + routeEffective.processing_status + ' configuration applies from ' + routeEffective.persisted_source + ' scope (' + routeEffective.rule_count + ' rule(s)).' : 'No policy rules.'}
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr key={rule.id} className={opTr} data-testid={`policy-rule-row-${rule.id}`}>
                  <td className={opTd}>{rule.name}</td>
                  <td className={cn(opTd, 'font-mono text-[10px]')}>
                    {rule.condition_json?.sensitivity_class ?? '—'}
                  </td>
                  <td className={opTd}>{rule.action_type}</td>
                  <td className={opTd}>{rule.enabled ? 'Yes' : 'No'}</td>
                  {canOperate && isRouteScope ? (
                    <td className={opTd}>
                      <button
                        type="button"
                        disabled={actionBusy}
                        onClick={() => void onToggleEnabled(rule)}
                        className="rounded border border-slate-200/90 px-2 py-0.5 text-[10px] font-semibold hover:bg-slate-50 disabled:opacity-50 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
                      >
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
