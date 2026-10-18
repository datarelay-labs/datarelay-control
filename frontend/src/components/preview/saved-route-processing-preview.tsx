import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { runRouteE2EDraftPreview, type RouteE2EDraftPreviewResponse } from '../../api/gdcRuntimePreview'
import { onSessionChange, readSession } from '../../auth/session'
import { ProcessingPreviewDock, type ProcessingPreviewStage } from './processing-preview-dock'

const STAGES = [
  ['input', 'Input'], ['mapping', 'Mapping'], ['transform', 'Enrichment / Transform'],
  ['protection', 'Data Protection'], ['classification', 'Classification'],
  ['policy', 'Delivery decision'], ['destination', 'Destination Payload'],
] as const

function safePreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('Preview result does not match')) return message
  if (message.includes('[PREVIEW_PERSISTENCE_REQUIRED]')) return 'Tokenization needs persisted token state and is not available in a no-write preview. No token was created and no event was sent.'
  if (message.includes('[PREVIEW_SAMPLE_TOO_LARGE]') || message.includes('[PREVIEW_RESULT_TOO_LARGE]')) return 'Preview limit reached. Select fewer or smaller sample events, then retry.'
  if (message.includes('[ROUTE_PREVIEW_STAGE_FAILED]')) return 'A saved processing rule failed. Correct the rule and refresh preview; no event was sent.'
  if (message.includes('[ROUTE_DISABLED]') || message.includes('[DESTINATION_DISABLED]')) return 'The saved Route or Destination is disabled. No delivery preview is available.'
  return 'The saved Route preview could not be evaluated. Check the sample and processing rules, then retry.'
}

/** Reads the existing no-send API; never evaluates rules or simulates results. */
export function SavedRouteProcessingPreview({ routeId, streamId, events, revision, ready, dirty }: {
  routeId: number
  streamId: number | null
  events: Array<Record<string, unknown>>
  revision: string
  ready: boolean
  dirty: boolean
}) {
  const sessionKey = useSyncExternalStore(onSessionChange, () => readSession()?.access_token ?? '', () => '')
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{
    identity: string; sessionKey: string; refresh: number
    result?: RouteE2EDraftPreviewResponse; error?: string
  } | null>(null)
  const sampleJson = useMemo(() => {
    try { return JSON.stringify(events.slice(0, 3)) } catch { return null }
  }, [events])
  const sampleTooLarge = sampleJson != null && new TextEncoder().encode(sampleJson).length > 1_048_576
  const identity = `${routeId}\0${streamId}\0${revision}\0${sampleJson}`
  const eligible = ready && !dirty && streamId != null && events.length > 0 && sampleJson != null && !sampleTooLarge
  const current = eligible && state?.identity === identity && state.sessionKey === sessionKey && state.refresh === refresh ? state : null
  const result = current?.result

  useEffect(() => {
    if (!eligible || streamId == null || sampleJson == null) return
    let cancelled = false
    setState(null)
    void runRouteE2EDraftPreview({ route_id: routeId, stream_id: streamId, payload: JSON.parse(sampleJson),
      field_mappings: {}, enrichment: {}, max_events: 3 })
      .then((response) => {
        if (cancelled) return
        if (response.route_id !== routeId || response.stream_id !== streamId || response.configuration_state !== 'saved') {
          throw new Error('Preview result does not match the selected saved Route and Stream.')
        }
        setState({ identity, sessionKey, refresh, result: response })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ identity, sessionKey, refresh,
          error: safePreviewError(error) })
      })
    return () => { cancelled = true }
  }, [eligible, identity, refresh, routeId, sampleJson, sessionKey, streamId])

  const issues = result?.preview_issues?.slice(0, 100) ?? []
  const issueCount = result?.preview_issue_count ?? issues.length
  const issuesLimited = result?.preview_issues_truncated === true

  const stageRows: ProcessingPreviewStage[] = STAGES.map(([id, label], index) => {
    const output = result?.stage_previews?.[id]
    const previous = index === 0 ? output : result?.stage_previews?.[STAGES[index - 1][0]]
    const blocked = result?.delivery_allowed === false && (id === 'policy' || id === 'destination')
    const timeline = result?.route_stage_timeline.findLast((item) => item.stage === id)
    const reason = typeof timeline?.decision_reason === 'string' ? timeline.decision_reason : null
    const stageIssues = issues.filter((issue) => issue.stage === (id === 'transform' ? 'enrichment' : id))
    const warningText = stageIssues.slice(0, 5).map((issue) =>
      `${issue.output_field.slice(0, 240)} · ${(issue.rule_id ?? 'Unnamed rule').slice(0, 240)} · ${issue.error_code.slice(0, 240)}`,
    ).join('; ')
    const warningSummary = stageIssues.length > 0 ? `${stageIssues.length}${issuesLimited ? '+' : ''} field warning${stageIssues.length === 1 ? '' : 's'}` : null
    const baseMessage = blocked ? `Delivery withheld by ${result.policy_action ?? 'policy'}. No destination payload was sent.${reason ? ` ${reason}` : ''}`
      : id === 'destination' ? 'Formatted with the saved destination settings. No events sent.' : reason
    return {
      id, label, truth: 'Preview',
      status: warningSummary ?? (blocked ? `${result.policy_action ?? 'Blocked'} · 0 events` : output ? `${output.length} sample event${output.length === 1 ? '' : 's'}` : 'Not evaluated'),
      before: previous ? previous[0] ?? [] : null,
      after: output ? output[0] ?? [] : null,
      message: [baseMessage, warningText,
        stageIssues.length > 5 ? `Showing 5 of ${stageIssues.length} recorded field warnings for this stage. Use a smaller sample to inspect the remaining warnings.` : null,
      ].filter(Boolean).join(' ') || null,
    }
  })

  return <div data-testid="saved-route-processing-preview" className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="text-slate-700 dark:text-gdc-mutedStrong">
        <span className="font-semibold">Saved configuration</span><span> · No events sent</span>
        {result ? <p className="mt-1">{result.destination_type} · Destination #{result.destination_id}</p> : null}
      </div>
      <button type="button" disabled={!eligible || !current} onClick={() => setRefresh((value) => value + 1)}
        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 disabled:opacity-50 dark:border-gdc-border dark:text-gdc-mutedStrong">
        <RefreshCw className="h-4 w-4" aria-hidden />Refresh preview
      </button>
    </div>
    {dirty ? <p className="text-sm text-amber-900 dark:text-amber-200">Save Transform to preview the complete Route. Unsaved edits are not evidence for the saved protection or delivery result.</p>
      : !ready ? <p className="text-sm text-slate-600 dark:text-gdc-muted">Loading the selected Route sample…</p>
        : sampleTooLarge ? <p role="alert" className="text-sm text-rose-700 dark:text-rose-200">Sample exceeds 1 MiB. Select fewer or smaller events.</p>
          : events.length === 0 || sampleJson == null ? <p className="text-sm text-slate-600 dark:text-gdc-muted">Load a source sample to preview the saved Route.</p>
            : current?.error ? <p role="alert" className="text-sm text-rose-700 dark:text-rose-200">{current.error}</p>
              : !result ? <p role="status" className="text-sm text-slate-600 dark:text-gdc-muted">Evaluating the saved Route…</p> : null}
    {result?.display_redacted ? <p className="text-sm text-amber-900 dark:text-amber-200">Secret-bearing values are redacted in this display. The formatted preview contains those display redactions.</p> : null}
    {issueCount > 0 ? <p role="status" className="text-sm text-amber-900 dark:text-amber-200">
      {issueCount} field warning{issueCount === 1 ? '' : 's'}. Select the affected processing stage to inspect its field, rule and error code.
      {issuesLimited ? ` Showing ${issues.length} of ${issueCount}; some warning details are omitted or shortened. Preview fewer events to inspect the remaining warnings.` : ''}
    </p> : null}
    <ProcessingPreviewDock stages={stageRows} />
  </div>
}
