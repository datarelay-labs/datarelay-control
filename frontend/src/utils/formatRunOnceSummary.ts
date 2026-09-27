import type { RuntimeStreamRunOnceResponse } from '../api/types/gdcApi'

export type OutboundSnapshot = {
  method?: string
  url?: string
  query_params?: Record<string, unknown>
  json_body_masked?: unknown
  timeout_seconds?: number
} | null

/** Parse FastAPI error JSON from `requestJson` (`prettyJson` of full body) for run-once / runtime failures. */
export function formatRunOnceErrorLines(err: unknown, opts?: { compareTestOutbound?: OutboundSnapshot }): string[] {
  const msg = err instanceof Error ? err.message : String(err)
  let detail: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(msg) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rawDetail = (parsed as Record<string, unknown>).detail
      if (rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail)) {
        detail = rawDetail as Record<string, unknown>
      }
    }
  } catch {
    return [msg]
  }
  if (!detail) return [msg]

  const lines: string[] = []
  const code = detail.error_code
  if (typeof code === 'string') lines.push(`error_code: ${code}`)
  const m = detail.message
  if (typeof m === 'string') lines.push(m)

  if (typeof detail.outbound_method === 'string') lines.push(`outbound_method: ${detail.outbound_method}`)
  if (typeof detail.outbound_final_url === 'string') lines.push(`outbound_final_url: ${detail.outbound_final_url}`)
  else if (typeof detail.outbound_url === 'string') lines.push(`outbound_url: ${detail.outbound_url}`)
  if (detail.outbound_query_params && typeof detail.outbound_query_params === 'object') {
    lines.push(`outbound_query_params: ${JSON.stringify(detail.outbound_query_params)}`)
  }
  if (detail.has_json_body === true && typeof detail.body_preview === 'string') {
    lines.push(`body_preview (masked): ${detail.body_preview.slice(0, 2000)}`)
  }
  if (typeof detail.response_status === 'number') lines.push(`response_status: ${detail.response_status}`)
  if (typeof detail.response_body === 'string') {
    lines.push(`response_body (masked): ${detail.response_body.slice(0, 4000)}`)
  }

  const cmp = opts?.compareTestOutbound
  if (cmp?.method && cmp?.url) {
    lines.push('--- vs last Test Connection (draft) ---')
    lines.push(`test_connection_method: ${cmp.method}`)
    lines.push(`test_connection_url: ${cmp.url}`)
    if (cmp.query_params && typeof cmp.query_params === 'object') {
      lines.push(`test_connection_query_params: ${JSON.stringify(cmp.query_params)}`)
    }
    if (cmp.json_body_masked != null) {
      lines.push(`test_connection_body_masked: ${JSON.stringify(cmp.json_body_masked).slice(0, 2000)}`)
    }
  }

  return lines.length ? lines : [msg]
}

/** Human-readable lines from run-once API (actual fields only). */
export function formatRunOnceSummaryLines(r: RuntimeStreamRunOnceResponse): string[] {
  const lines: string[] = []
  if (r.outcome === 'no_events') {
    lines.push(r.message ?? 'No new events extracted')
  }
  if (r.runtime_run_id) lines.push(`Run id: ${r.runtime_run_id}`)
  lines.push(`Extracted: ${r.extracted_event_count ?? '—'}`)
  lines.push(`Delivered (batch events): ${r.delivered_batch_event_count ?? '—'}`)
  if (r.route_delivery_success_count != null || r.route_delivery_failure_count != null) {
    lines.push(
      `Route delivery: ${r.route_delivery_success_count ?? 0} succeeded · ${r.route_delivery_failure_count ?? 0} failed`,
    )
  }
  if (r.mapped_event_count != null || r.enriched_event_count != null) {
    lines.push(`Mapped: ${r.mapped_event_count ?? '—'} · Enriched: ${r.enriched_event_count ?? '—'}`)
  }
  lines.push(`Checkpoint updated: ${r.checkpoint_updated ? 'yes' : 'no'}`)
  lines.push(`Transaction committed: ${r.transaction_committed ? 'yes' : 'no'}`)
  if (r.message && r.outcome !== 'no_events') {
    lines.push(`Note: ${r.message}`)
  }
  return lines
}
