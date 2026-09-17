import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchAiProvidersList, fetchAiTrafficSummary, type AiProviderRead, type AiTrafficSummary } from '../../api/gdcAiProviders'
import { AiGatewayEmptyState, aiTrafficEmptyState } from './ai-gateway-empty-state'

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500 dark:text-gdc-muted">{hint}</p> : null}
    </div>
  )
}

export function AiTrafficPage() {
  const [summary, setSummary] = useState<AiTrafficSummary | null>(null)
  const [providers, setProviders] = useState<AiProviderRead[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [traffic, providerRows] = await Promise.all([
        fetchAiTrafficSummary({ hours: 24 }),
        fetchAiProvidersList(),
      ])
      setSummary(traffic)
      setProviders(providerRows)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const providerNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const p of providers) m.set(p.id, p.name)
    return m
  }, [providers])

  if (loading) {
    return <p className="text-sm text-slate-600 dark:text-gdc-muted">Loading traffic metrics…</p>
  }

  if (!summary) {
    return <p className="text-sm text-slate-600 dark:text-gdc-muted">Traffic metrics unavailable.</p>
  }

  const hasTraffic = summary.requests > 0 || summary.top_providers.length > 0

  if (!hasTraffic) {
    const empty = aiTrafficEmptyState()
    return (
      <section data-testid="ai-traffic-page">
        <AiGatewayEmptyState testId="ai-traffic-empty-state" {...empty} />
      </section>
    )
  }

  return (
    <section data-testid="ai-traffic-page" className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Requests" value={String(summary.requests)} hint="Last 24 hours" />
        <MetricCard label="Success rate" value={`${summary.success_rate.toFixed(1)}%`} />
        <MetricCard label="Error rate" value={`${summary.error_rate.toFixed(1)}%`} />
        <MetricCard label="Avg latency" value={`${summary.avg_latency_ms} ms`} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Failover count" value={String(summary.failover_count)} />
        <MetricCard label="Replay count" value={String(summary.replay_count)} />
        <MetricCard label="Policy blocks" value={String(summary.policy_blocks)} hint="Blocked requests" />
        <MetricCard label="Prompt masks" value={String(summary.prompt_masks)} hint="Masked prompts" />
        <MetricCard label="Response masks" value={String(summary.response_masks)} hint="Masked responses" />
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-gdc-border">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-gdc-border">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Top providers</h2>
        </div>
        {summary.top_providers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-600 dark:text-gdc-muted">No provider traffic recorded yet.</p>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
              <tr>
                <th className="px-4 py-2">Provider</th>
                <th className="px-4 py-2">Requests</th>
                <th className="px-4 py-2">Success</th>
                <th className="px-4 py-2">Failures</th>
                <th className="px-4 py-2">Avg latency</th>
              </tr>
            </thead>
            <tbody>
              {summary.top_providers.map((row) => (
                <tr key={row.provider_id} className="border-t border-slate-200 dark:border-gdc-border">
                  <td className="px-4 py-2">{providerNameById.get(row.provider_id) ?? `Provider ${row.provider_id}`}</td>
                  <td className="px-4 py-2">{row.request_count}</td>
                  <td className="px-4 py-2">{row.success_count}</td>
                  <td className="px-4 py-2">{row.failure_count}</td>
                  <td className="px-4 py-2">{row.avg_latency_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
