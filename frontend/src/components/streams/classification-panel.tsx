import { Layers, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchStreamClassificationRules,
  fetchStreamClassificationSummary,
  type ClassificationLevel,
  type ClassificationRule,
  type StreamClassificationSummaryResponse,
} from '../../api/gdcClassification'
import {
  fetchRouteClassificationEffective,
  fetchRouteClassificationRules,
  patchRouteClassificationRule,
  type RouteClassificationEffective,
  type RouteClassificationRule,
} from '../../api/gdcRouteClassification'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'

const LEVEL_ORDER: ClassificationLevel[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']

function levelTone(level: string): string {
  switch (level) {
    case 'RESTRICTED':
      return 'text-rose-700 dark:text-rose-300'
    case 'CONFIDENTIAL':
      return 'text-amber-700 dark:text-amber-300'
    case 'PUBLIC':
      return 'text-emerald-700 dark:text-emerald-300'
    default:
      return 'text-slate-700 dark:text-slate-200'
  }
}

function countByLevel(rules: Array<ClassificationRule | RouteClassificationRule>) {
  const enabled = rules.filter((r) => r.enabled)
  return {
    public_count: enabled.filter((r) => r.classification_level === 'PUBLIC').length,
    internal_count: enabled.filter((r) => r.classification_level === 'INTERNAL').length,
    confidential_count: enabled.filter((r) => r.classification_level === 'CONFIDENTIAL').length,
    restricted_count: enabled.filter((r) => r.classification_level === 'RESTRICTED').length,
    total_rules: rules.length,
  }
}

export function ClassificationPanel({
  streamId,
  routeId,
  canOperate,
  onEffectiveChange,
  initialEffective,
}: {
  streamId: number
  routeId?: number
  canOperate?: boolean
  onEffectiveChange?: (effective: RouteClassificationEffective | null) => void
  initialEffective?: RouteClassificationEffective | null
}) {
  const isRouteScope = routeId != null
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
  const [summary, setSummary] = useState<StreamClassificationSummaryResponse | null>(null)
  const [routeEffective, setRouteEffective] = useState<RouteClassificationEffective | null>(effectivePreload ?? null)
  const [rules, setRules] = useState<Array<ClassificationRule | RouteClassificationRule>>([])

  const load = useCallback(async (opts?: { skipEffective?: boolean }) => {
    setLoading(true)
    setError(null)
    try {
      if (isRouteScope) {
        const skipEffective = opts?.skipEffective === true && effectivePreloadRef.current != null
        const [r, effective] = await Promise.all([
          fetchRouteClassificationRules(routeId),
          skipEffective ? Promise.resolve(effectivePreloadRef.current) : fetchRouteClassificationEffective(routeId),
        ])
        onEffectiveChange?.(effective)
        setRouteEffective(effective)
        const routeRules = r?.rules ?? []
        setRules(routeRules)
        const counts = countByLevel(routeRules)
        setSummary({
          stream_id: streamId,
          ...counts,
          last_classified_at: null,
          last_classification_level: null,
        })
        if (r == null) setError('Classification APIs unavailable.')
        return
      }

      const [s, r] = await Promise.all([
        fetchStreamClassificationSummary(streamId),
        fetchStreamClassificationRules(streamId),
      ])
      setSummary(s)
      setRules(r?.rules ?? [])
      if (s == null && r == null) {
        setError('Classification APIs unavailable.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [isRouteScope, onEffectiveChange, routeId, streamId])

  useEffect(() => {
    const skipEffective = isRouteScope && effectivePreloadRef.current != null
    void load({ skipEffective })
  }, [streamId, routeId, isRouteScope, load])

  async function onToggleEnabled(rule: ClassificationRule | RouteClassificationRule) {
    if (!canOperate || !isRouteScope) return
    setActionBusy(true)
    setMessage(null)
    try {
      await patchRouteClassificationRule(routeId, rule.id, { enabled: !rule.enabled })
      setMessage('Rule updated.')
      await load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setActionBusy(false)
    }
  }

  const distribution = LEVEL_ORDER.map((level) => ({
    level,
    count:
      level === 'PUBLIC'
        ? summary?.public_count ?? 0
        : level === 'INTERNAL'
          ? summary?.internal_count ?? 0
          : level === 'CONFIDENTIAL'
            ? summary?.confidential_count ?? 0
            : summary?.restricted_count ?? 0,
  }))

  return (
    <section
      className="rounded-xl border border-slate-200/90 bg-white p-3 dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Classification"
      data-testid="classification-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-slate-100">
          <Layers className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          Classification
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
        <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
      {message ? (
        <p className="mt-2 text-[11px] font-medium text-emerald-800 dark:text-emerald-200" role="status">
          {message}
        </p>
      ) : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-2.5 dark:border-gdc-border dark:bg-gdc-row/40">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Classification distribution
          </p>
          <ul className="mt-2 space-y-1">
            {distribution.map((row) => (
              <li key={row.level} className="flex justify-between text-[12px]">
                <span className={cn('font-medium', levelTone(row.level))}>{row.level}</span>
                <span className="tabular-nums text-slate-600 dark:text-slate-300">{row.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500 dark:text-gdc-muted">
            Total rules: {summary?.total_rules ?? 0}
          </p>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/80 p-2.5 dark:border-gdc-border dark:bg-gdc-row/40">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
            Recent classification
          </p>
          <p className={cn('mt-2 text-[18px] font-bold tabular-nums', levelTone(summary?.last_classification_level ?? 'INTERNAL'))}>
            {summary?.last_classification_level ?? '—'}
          </p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
            {summary?.last_classified_at
              ? `Last run: ${new Date(summary.last_classified_at).toLocaleString()}`
              : isRouteScope
                ? 'Route-scoped rules (stream metrics not shown).'
                : 'No classification runs logged yet'}
          </p>
        </div>
      </div>

      <div className="mt-3 overflow-x-auto" data-testid="classification-rules-table">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={opTh}>Name</th>
              <th className={opTh}>Condition</th>
              <th className={opTh}>Level</th>
              <th className={opTh}>Enabled</th>
              {canOperate && isRouteScope ? <th className={opTh}>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr className={opTr}>
                <td
                  colSpan={canOperate && isRouteScope ? 5 : 4}
                  className={cn(opTd, 'text-slate-500 dark:text-gdc-muted')}
                >
                  {loading
                    ? 'Loading…'
                    : routeEffective && routeEffective.rule_count > 0
                      ? 'No route-local classification rules. Effective ' + routeEffective.processing_status + ' configuration applies from ' + routeEffective.persisted_source + ' scope (' + routeEffective.rule_count + ' rule(s)).'
                      : 'No explicit classification rules (defaults apply from sensitive findings).'}
                </td>
              </tr>
            ) : (
              rules.map((rule) => (
                <tr key={rule.id} className={opTr} data-testid={`classification-rule-row-${rule.id}`}>
                  <td className={opTd}>{rule.name}</td>
                  <td className={cn(opTd, 'font-mono text-[11px]')}>
                    {typeof rule.condition_json?.sensitivity_class === 'string'
                      ? String(rule.condition_json.sensitivity_class)
                      : JSON.stringify(rule.condition_json)}
                  </td>
                  <td className={cn(opTd, 'font-semibold', levelTone(rule.classification_level))}>
                    {rule.classification_level}
                  </td>
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
