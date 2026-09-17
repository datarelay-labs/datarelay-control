import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchAiTrafficSummary } from '../../api/gdcAiProviders'
import { fetchAiStreamsList, type AiStreamRead } from '../../api/gdcAiStreams'
import { fetchStreamsList } from '../../api/gdcStreams'
import type { StreamRead } from '../../api/types/gdcApi'
import { streamRuntimePath } from '../../config/nav-paths'
import { AiGatewayEmptyState, aiStreamsEmptyState } from './ai-gateway-empty-state'

function issueLabel(row: AiStreamRead, failureCount: number): string {
  if (!row.enabled) return 'Disabled'
  if (failureCount > 0) return `${failureCount} failure${failureCount === 1 ? '' : 's'}`
  return 'No issues'
}

function formatAiStreamDisplayName(slug: string, streamName: string | undefined): string {
  const name = (streamName ?? '').trim()
  if (name) return name
  return slug.trim() || 'AI stream'
}

export function AiStreamsPage() {
  const [rows, setRows] = useState<AiStreamRead[]>([])
  const [streams, setStreams] = useState<StreamRead[]>([])
  const [requestsByStreamId, setRequestsByStreamId] = useState<Map<number, { requests: number; failures: number }>>(
    new Map(),
  )
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [aiRows, streamRows] = await Promise.all([fetchAiStreamsList(), fetchStreamsList()])
      setRows(aiRows)
      setStreams(streamRows ?? [])

      const trafficEntries = await Promise.all(
        aiRows.map(async (row) => {
          try {
            const traffic = await fetchAiTrafficSummary({ hours: 24, stream_id: row.stream_id })
            return [row.stream_id, { requests: traffic.requests, failures: traffic.failure_count }] as const
          } catch {
            return [row.stream_id, { requests: 0, failures: 0 }] as const
          }
        }),
      )
      setRequestsByStreamId(new Map(trafficEntries))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const streamNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of streams) {
      if (typeof s.id === 'number') m.set(s.id, s.name)
    }
    return m
  }, [streams])

  const empty = aiStreamsEmptyState()

  return (
    <section data-testid="ai-streams-page" className="space-y-4">
      {loading ? (
        <p className="text-sm text-slate-600 dark:text-gdc-muted">Loading AI streams…</p>
      ) : rows.length === 0 ? (
        <AiGatewayEmptyState testId="ai-streams-empty-state" {...empty} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-gdc-border">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-gdc-card dark:text-gdc-muted">
              <tr>
                <th className="px-3 py-2">AI stream</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Requests</th>
                <th className="px-3 py-2">Issues</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const streamName = streamNameById.get(row.stream_id)
                const aiStreamName = formatAiStreamDisplayName(row.slug, streamName)
                const traffic = requestsByStreamId.get(row.stream_id)
                const requests = traffic?.requests ?? 0
                const failures = traffic?.failures ?? 0
                const issues = issueLabel(row, failures)

                return (
                  <tr key={row.id} className="border-t border-slate-200 dark:border-gdc-border" data-testid={`ai-stream-row-${row.id}`}>
                    <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{aiStreamName}</td>
                    <td className="px-3 py-2">{row.enabled ? 'Active' : 'Disabled'}</td>
                    <td className="px-3 py-2 tabular-nums">{requests}</td>
                    <td className="px-3 py-2">{issues}</td>
                    <td className="px-3 py-2">
                      <Link
                        to={streamRuntimePath(String(row.stream_id))}
                        className="text-xs font-semibold text-green-700 hover:underline dark:text-green-300"
                      >
                        Open stream
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
