import { useCallback, useEffect, useState } from 'react'
import {
  acknowledgeAiPolicyViolation,
  fetchAiGovernanceDashboard,
  fetchAiPolicyViolations,
  resolveAiPolicyViolation,
  type AiGovernanceDashboardSummary,
  type AiPolicyViolationRead,
} from '../../api/gdcAiGovernance'
import { useSessionCapabilities } from '../../lib/rbac'

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">{hint}</p> : null}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'OPEN'
      ? 'bg-gdc-warningSubtle text-gdc-warningFg dark:bg-gdc-warningSubtle dark:text-gdc-warningFg'
      : status === 'ACKNOWLEDGED'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
        : 'bg-gdc-successSubtle text-gdc-successFg dark:bg-gdc-successSubtle dark:text-gdc-successFg'
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>
  )
}

export function AiGovernancePage() {
  const capabilities = useSessionCapabilities()
  const canOperate = capabilities.ai_governance_operate === true
  const [summary, setSummary] = useState<AiGovernanceDashboardSummary | null>(null)
  const [violations, setViolations] = useState<AiPolicyViolationRead[]>([])
  const [statusFilter, setStatusFilter] = useState<'open' | 'acknowledged' | 'resolved' | 'all'>('open')
  const [loading, setLoading] = useState(true)
  const [actionId, setActionId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [dash, list] = await Promise.all([
        fetchAiGovernanceDashboard({ hours: 24 }),
        fetchAiPolicyViolations({ status: statusFilter, limit: 50 }),
      ])
      setSummary(dash)
      setViolations(list.violations)
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const handleAcknowledge = async (id: number) => {
    if (!canOperate) return
    setActionId(id)
    try {
      await acknowledgeAiPolicyViolation(id)
      await load()
    } finally {
      setActionId(null)
    }
  }

  const handleResolve = async (id: number) => {
    if (!canOperate) return
    setActionId(id)
    try {
      await resolveAiPolicyViolation(id)
      await load()
    } finally {
      setActionId(null)
    }
  }

  if (loading && !summary) {
    return <p className="text-sm text-slate-600 dark:text-gdc-muted">Loading AI governance metrics…</p>
  }

  if (!summary) {
    return <p className="text-sm text-slate-600 dark:text-gdc-muted">AI governance metrics unavailable.</p>
  }

  return (
    <section data-testid="ai-governance-page" className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Total requests" value={String(summary.total_requests)} hint="Last 24 hours" />
        <MetricCard label="Policy blocks" value={String(summary.policy_blocks)} />
        <MetricCard label="Policy violations" value={String(summary.policy_violations)} />
        <MetricCard label="Mask events" value={String(summary.mask_events)} />
        <MetricCard label="Redact events" value={String(summary.redact_events)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Top violated policies</h2>
          </div>
          {summary.top_violated_policies.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No policy violations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-gdc-border">
              {summary.top_violated_policies.map((row) => (
                <li key={row.key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-slate-800 dark:text-slate-200">{row.label}</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Top providers</h2>
          </div>
          {summary.top_providers.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No provider violations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-gdc-border">
              {summary.top_providers.map((row) => (
                <li key={row.key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-slate-800 dark:text-slate-200">{row.label}</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Top AI streams</h2>
          </div>
          {summary.top_ai_streams.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No stream violations yet.</p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-gdc-border">
              {summary.top_ai_streams.map((row) => (
                <li key={row.key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-slate-800 dark:text-slate-200">{row.label}</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">{row.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Policy impact analysis</h2>
        </div>
        {summary.policy_impact.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No policy impact data yet.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
              <tr>
                <th className="px-4 py-2">Policy</th>
                <th className="px-4 py-2">Blocks</th>
                <th className="px-4 py-2">Masks</th>
                <th className="px-4 py-2">Redacts</th>
                <th className="px-4 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {summary.policy_impact.map((row) => (
                <tr
                  key={String(row.policy_rule_id ?? row.rule_id ?? 'unknown')}
                  className="border-t border-slate-200 dark:border-gdc-border"
                >
                  <td className="px-4 py-2">{row.rule_id ?? row.policy_rule_id ?? '—'}</td>
                  <td className="px-4 py-2">{row.block_count}</td>
                  <td className="px-4 py-2">{row.mask_count}</td>
                  <td className="px-4 py-2">{row.redact_count}</td>
                  <td className="px-4 py-2">{row.total_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Violations</h2>
          <div className="flex flex-wrap gap-1">
            {(['open', 'acknowledged', 'resolved', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-testid={`ai-governance-filter-${value}`}
                onClick={() => setStatusFilter(value)}
                className={
                  statusFilter === value
                    ? 'rounded-md bg-gdc-buttonPrimary px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-gdc-mutedStrong dark:hover:bg-gdc-rowHover'
                }
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        {violations.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No violations for this filter.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
              <tr>
                <th className="px-4 py-2">Request</th>
                <th className="px-4 py-2">Provider</th>
                <th className="px-4 py-2">AI stream</th>
                <th className="px-4 py-2">Rule</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Severity</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {violations.map((row) => (
                <tr key={row.id} className="border-t border-slate-200 dark:border-gdc-border">
                  <td className="px-4 py-2 font-mono text-xs">{row.request_id}</td>
                  <td className="px-4 py-2">{row.provider ?? '—'}</td>
                  <td className="px-4 py-2">{row.ai_stream ?? '—'}</td>
                  <td className="px-4 py-2">{row.rule_id ?? '—'}</td>
                  <td className="px-4 py-2">{row.action}</td>
                  <td className="px-4 py-2">{row.severity}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2">
                    {canOperate && row.status === 'OPEN' ? (
                      <button
                        type="button"
                        disabled={actionId === row.id}
                        onClick={() => void handleAcknowledge(row.id)}
                        className="mr-2 text-xs font-medium text-green-600 hover:underline disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    ) : null}
                    {canOperate && (row.status === 'OPEN' || row.status === 'ACKNOWLEDGED') ? (
                      <button
                        type="button"
                        disabled={actionId === row.id}
                        onClick={() => void handleResolve(row.id)}
                        className="text-xs font-medium text-gdc-successFg hover:underline disabled:opacity-50"
                      >
                        Resolve
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
