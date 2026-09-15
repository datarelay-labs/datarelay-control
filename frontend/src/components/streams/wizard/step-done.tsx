import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCopy,
  Cpu,
  Loader2,
  PauseCircle,
  Play,
  Radio,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchDestinationsList, type DestinationListItem } from '../../../api/gdcDestinations'
import { runStreamOnce } from '../../../api/gdcRuntime'
import { isDestinationConnectivityVerified } from '../../../utils/destination-connectivity-health'
import { runEnrichmentExecPreview } from '../../../api/gdcRuntimePreview'
import { enrichmentDictFromRules } from './enrichment-rules-model'
import type { RuntimeStreamRunOnceResponse } from '../../../api/types/gdcApi'
import {
  connectorDetailPath,
  logsExplorerPath,
  NAV_PATH,
  runtimeOverviewPath,
  streamEditPath,
  streamRuntimePath,
} from '../../../config/nav-paths'
import { cn } from '../../../lib/utils'
import { buildMappedBaseFromState, countDuplicateEnrichmentKeys } from './wizard-review-preview'
import {
  deliveryModeFromFailurePolicy,
  failurePolicyBehaviorLabel,
  formatWizardRateLimitDraft,
  formatWizardSyslogLabel,
} from './wizard-delivery-helpers'
import { computeLegacySubstepCompletion, type WizardCreateOutcome, type WizardLegacySubstepKey, type WizardState } from './wizard-state'
import {
  wizardCreateIsConfigurationIncomplete,
  wizardCreateIsStartEligible,
} from './wizard-create-fail-closed'

type StepDoneProps = {
  state: WizardState
  isStarting: boolean
  onStart: () => void
  onNavigateToStep: (key: WizardLegacySubstepKey) => void
}

function formatScheduleHuman(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec % 3600 === 0) return `Every ${sec / 3600} hour${sec === 3600 ? '' : 's'}`
  if (sec % 60 === 0) {
    const m = sec / 60
    return `Every ${m} minute${m === 1 ? '' : 's'}`
  }
  return `Every ${sec} seconds`
}

function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
  } catch {
    return '—'
  }
}

function formatStreamDisplayId(id: number, createdIso?: string | null): string {
  let y = new Date().getFullYear()
  if (createdIso) {
    try {
      y = new Date(createdIso).getFullYear()
    } catch {
      /* keep current year */
    }
  }
  return `STR-${y}-${String(id).padStart(6, '0')}`
}

function destinationEndpointShort(dest: DestinationListItem | undefined): string {
  if (!dest) return '—'
  const cfg = dest.config_json ?? {}
  if (dest.destination_type === 'WEBHOOK_POST') {
    const u = typeof cfg.url === 'string' ? cfg.url.trim() : ''
    return u || '—'
  }
  const host = typeof cfg.host === 'string' ? cfg.host : '—'
  const port = cfg.port != null ? String(cfg.port) : '514'
  return `${host}:${port}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fallback */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function describeBanner(outcome: WizardCreateOutcome | null): {
  title: string
  subtitle: string
  tone: 'success' | 'warning'
} {
  if (!outcome) {
    return {
      title: 'Stream not created yet',
      subtitle: 'Go back to Review & Create and click “Create Stream”.',
      tone: 'warning',
    }
  }
  if (outcome.streamId == null) {
    return {
      title: 'Stream creation failed',
      subtitle: outcome.errors[0] ?? 'See errors below for details.',
      tone: 'warning',
    }
  }
  if (wizardCreateIsConfigurationIncomplete(outcome)) {
    return {
      title: 'Stream configuration incomplete',
      subtitle:
        'The stream row was created, but required follow-up saves failed. Start is blocked until you repair the errors below. Your local draft was kept.',
      tone: 'warning',
    }
  }
  if (outcome.dataProtectionWarnings.length > 0) {
    return {
      title: 'Stream created with warnings',
      subtitle: 'Some protection rules were skipped — see warnings below.',
      tone: 'warning',
    }
  }
  if (outcome.schemaDriftPolicyWarnings.length > 0) {
    return {
      title: 'Stream created with warnings',
      subtitle: 'Schema drift policy has Phase 1 limitations — see warnings below.',
      tone: 'warning',
    }
  }
  return {
    title: 'Stream created successfully!',
    subtitle: 'Your stream is ready to start collecting events.',
    tone: 'success',
  }
}

export function StepDone({
  state,
  isStarting,
  onStart,
  onNavigateToStep,
}: StepDoneProps) {
  const navigate = useNavigate()
  const outcome = state.outcome
  const banner = describeBanner(outcome)
  const streamNumericId = outcome?.streamId ?? null
  const streamSlug = streamNumericId != null ? String(streamNumericId) : 'new'
  const displayId =
    streamNumericId != null ? formatStreamDisplayId(streamNumericId, outcome?.createdAt ?? null) : '—'

  const [copyFlash, setCopyFlash] = useState(false)
  const [startMode, setStartMode] = useState<'now' | 'disabled'>('now')
  const [runBusy, setRunBusy] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<{
    at: number
    res: RuntimeStreamRunOnceResponse
    durationMs: number
  } | null>(null)

  const completion = useMemo(() => computeLegacySubstepCompletion(state), [state])
  const routeDrafts = state.destinations.routeDrafts
  const mappedRows = useMemo(
    () => state.mapping.filter((m) => m.outputField.trim() && m.sourceJsonPath.trim()),
    [state.mapping],
  )
  const mappedCount = mappedRows.length
  const enrichmentRows = useMemo(
    () => state.enrichment.filter((e) => e.fieldName.trim()),
    [state.enrichment],
  )
  const enrichmentDupes = useMemo(() => countDuplicateEnrichmentKeys(state.enrichment), [state.enrichment])
  const sampleEvent = state.apiTest.extractedEvents[0] ?? null
  const mappedBase = useMemo(() => buildMappedBaseFromState(sampleEvent, state.mapping), [sampleEvent, state.mapping])
  const enrichmentPayload = useMemo(
    () => enrichmentDictFromRules(state.enrichment),
    [state.enrichment],
  )
  const [finalEvent, setFinalEvent] = useState<Record<string, unknown>>(() => ({ ...mappedBase }))
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await runEnrichmentExecPreview({
          mapped_event: mappedBase,
          enrichment: enrichmentPayload,
          override_policy: 'KEEP_EXISTING',
        })
        if (!cancelled) setFinalEvent(res.final_event)
      } catch {
        if (!cancelled) setFinalEvent({ ...mappedBase })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mappedBase, enrichmentPayload])
  const totalOutputKeys = useMemo(() => Object.keys(finalEvent).length, [finalEvent])

  const uniqueDestinations = useMemo(
    () => new Set(routeDrafts.map((r) => r.destinationId)).size,
    [routeDrafts],
  )

  const [destinations, setDestinations] = useState<DestinationListItem[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const rows = await fetchDestinationsList()
      if (!cancelled) {
        // Failure != empty catalog: keep prior rows (initially []).
        if (rows !== null) setDestinations(rows)
      }    })()
    return () => {
      cancelled = true
    }
  }, [])

  const destById = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations])

  const connectivityForRoutes = useMemo(() => {
    if (routeDrafts.length === 0) return { ok: true, failed: false, unknown: false }
    let failed = false
    let unknown = false
    for (const r of routeDrafts) {
      const meta = destById.get(r.destinationId)
      if (!meta) {
        unknown = true
        continue
      }
      if (meta.last_connectivity_test_success === false) failed = true
      else if (!isDestinationConnectivityVerified(meta)) unknown = true
    }
    const ok = !failed && !unknown
    return { ok, failed, unknown }
  }, [routeDrafts, destById])

  const previewErr = state.apiTest.analysis?.previewError
  const eventPathOk =
    completion.preview === 'complete' &&
    !previewErr &&
    (state.stream.useWholeResponseAsEvent || state.stream.eventArrayPath.trim().length > 0)

  const enrichmentValid =
    state.enrichment.length === 0 || state.enrichment.every((e) => e.fieldName.trim().length > 0)
  const enrichmentOk = enrichmentValid && enrichmentDupes === 0

  const checklist = useMemo(
    () => [
      {
        id: 'connector_auth',
        label: 'Source connection authentication',
        stepKey: 'connector' as WizardLegacySubstepKey,
        ok: completion.connector === 'complete' && completion.api_test === 'complete',
        warn: false,
        detail: undefined as string | undefined,
      },
      {
        id: 'http',
        label: 'HTTP request configuration',
        stepKey: 'stream' as WizardLegacySubstepKey,
        ok: completion.stream === 'complete',
        warn: false,
      },
      {
        id: 'path',
        label: 'Event array path',
        stepKey: 'preview' as WizardLegacySubstepKey,
        ok: eventPathOk,
        warn: previewErr != null && previewErr.length > 0,
        detail: previewErr ?? undefined,
      },
      {
        id: 'mapping',
        label: 'Mapping configuration',
        stepKey: 'mapping' as WizardLegacySubstepKey,
        ok: mappedCount > 0,
        warn: false,
      },
      {
        id: 'enrichment',
        label: 'Enrichment configuration',
        stepKey: 'enrichment' as WizardLegacySubstepKey,
        ok: enrichmentOk,
        warn: enrichmentDupes > 0,
        detail: enrichmentDupes > 0 ? 'Duplicate enrichment field names' : undefined,
      },
      {
        id: 'routes',
        label: 'Delivery paths configuration',
        stepKey: 'destinations' as WizardLegacySubstepKey,
        ok: routeDrafts.length > 0 && routeDrafts.some((r) => r.enabled),
        warn: routeDrafts.length > 0 && !routeDrafts.some((r) => r.enabled),
      },
      {
        id: 'dest_test',
        label: 'Destination connectivity',
        stepKey: 'destinations' as WizardLegacySubstepKey,
        ok: connectivityForRoutes.ok,
        warn: connectivityForRoutes.unknown && !connectivityForRoutes.failed,
        detail: connectivityForRoutes.failed
          ? 'One or more destinations reported a failed connectivity test.'
          : connectivityForRoutes.unknown
            ? 'Run Test from the Destinations step to verify connectivity.'
            : undefined,
      },
      {
        id: 'checkpoint',
        label: 'Sync position configuration',
        stepKey: 'preview' as WizardLegacySubstepKey,
        ok:
          (state.stream.checkpointFieldType === '' && !state.stream.checkpointSourcePath.trim()) ||
          (state.stream.checkpointFieldType !== '' && state.stream.checkpointSourcePath.trim().length > 0),
        warn: false,
      },
    ],
    [
      completion.api_test,
      completion.connector,
      completion.stream,
      completion.preview,
      connectivityForRoutes.failed,
      connectivityForRoutes.ok,
      connectivityForRoutes.unknown,
      enrichmentDupes,
      enrichmentOk,
      eventPathOk,
      mappedCount,
      previewErr,
      routeDrafts,
      state.stream.checkpointFieldType,
      state.stream.checkpointSourcePath,
    ],
  )

  const allChecksPassed = checklist.every((c) => c.ok && !c.warn)

  const pollingSec = state.stream.pollingIntervalSec
  const nextRunPreview = useMemo(
    () => new Date(Date.now() + Math.max(1, pollingSec) * 1000),
    [pollingSec, startMode],
  )

  const handleCopyId = useCallback(async () => {
    const ok = await copyText(displayId)
    if (ok) {
      setCopyFlash(true)
      window.setTimeout(() => setCopyFlash(false), 1600)
    }
  }, [displayId])

  const handleRunOnce = useCallback(async () => {
    if (streamNumericId == null || runBusy) return
    setRunBusy(true)
    setRunError(null)
    const t0 = Date.now()
    try {
      const res = await runStreamOnce(streamNumericId)
      setLastRun({ at: Date.now(), res, durationMs: Date.now() - t0 })
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
      setLastRun(null)
    } finally {
      setRunBusy(false)
    }
  }, [runBusy, streamNumericId])

  const handlePrimaryStart = useCallback(() => {
    if (!wizardCreateIsStartEligible(outcome)) return
    if (startMode === 'now') {
      onStart()
      return
    }
    navigate(streamRuntimePath(streamSlug))
  }, [navigate, onStart, outcome, startMode, streamSlug])

  const startEligible = wizardCreateIsStartEligible(outcome)
  const primaryLabel =
    startMode === 'now'
      ? isStarting
        ? 'Starting…'
        : startEligible
          ? 'Start Stream Now'
          : 'Start Blocked'
      : 'Continue Without Starting'

  const checkpointFieldDisplay = state.stream.checkpointSourcePath.trim()
    ? state.stream.checkpointSourcePath.trim()
    : 'Not set'

  const routesLink =
    streamNumericId != null ? runtimeOverviewPath({ stream_id: streamNumericId }) : NAV_PATH.routes

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-[2] space-y-4">
          {/* Success banner */}
          <section
            className={cn(
              'rounded-xl border p-4 shadow-sm',
              banner.tone === 'success'
                ? 'border-emerald-200/90 bg-white dark:border-emerald-500/25 dark:bg-gdc-card'
                : 'border-amber-200/90 bg-white dark:border-amber-500/25 dark:bg-gdc-card',
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                  banner.tone === 'success'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-200',
                )}
                aria-hidden
              >
                {banner.tone === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                ) : (
                  <AlertTriangle className="h-5 w-5" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{banner.title}</h3>
                  <p className="mt-0.5 text-[13px] text-slate-600 dark:text-gdc-muted">{banner.subtitle}</p>
                </div>
                {streamNumericId != null ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
                    <div>
                      <span className="font-medium text-slate-500 dark:text-gdc-muted">Stream ID</span>{' '}
                      <span className="font-mono font-semibold text-slate-800 dark:text-slate-100">{displayId}</span>
                      <button
                        type="button"
                        onClick={() => void handleCopyId()}
                        className="ml-2 inline-flex items-center gap-1 rounded-md border border-slate-200/90 bg-white px-2 py-0.5 text-[11px] font-semibold text-violet-700 hover:bg-slate-50 dark:border-gdc-borderStrong dark:bg-gdc-elevated dark:text-violet-300 dark:hover:bg-gdc-rowHover"
                      >
                        <ClipboardCopy className="h-3 w-3" aria-hidden />
                        {copyFlash ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div>
                      <span className="font-medium text-slate-500 dark:text-gdc-muted">Created At</span>{' '}
                      <span className="text-slate-800 dark:text-slate-100">
                        {formatIsoDate(outcome?.createdAt ?? null)}
                      </span>
                    </div>
                  </div>
                ) : null}
                {state.startMessage ? (
                  <p className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{state.startMessage}</p>
                ) : null}
              </div>
            </div>
          </section>

          {/* Stream overview */}
          <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3 dark:border-gdc-border">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
                  <Radio className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Stream Overview</p>
                  <p className="truncate text-[14px] font-semibold text-slate-900 dark:text-slate-50">
                    {state.stream.name.trim() || 'Untitled Stream'}
                  </p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:border-emerald-500/35 dark:text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                Enabled
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <OverviewItem label="Source Type" value="HTTP API Polling" />
              <OverviewItem label="Schedule" value={formatScheduleHuman(state.stream.pollingIntervalSec)} />
              <OverviewItem label="Status" value={<StatusReady />} />
              <OverviewItem
                label="Next Run"
                value={
                  streamNumericId != null
                    ? nextRunPreview.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                    : '—'
                }
              />
              <OverviewItem
                label="Source connection"
                value={
                  state.connector.connectorId != null ? (
                    <Link
                      to={connectorDetailPath(String(state.connector.connectorId))}
                      className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {state.connector.connectorName.trim() || `Source connection #${state.connector.connectorId}`}
                    </Link>
                  ) : (
                    '—'
                  )
                }
              />
              <OverviewItem label="Delivery paths" value={String(routeDrafts.length)} accent />
              <OverviewItem label="Destinations" value={String(uniqueDestinations)} accent />
              <OverviewItem label="Mapped Fields" value={String(mappedCount)} accent />
              <OverviewItem label="Enrichment Fields" value={String(enrichmentRows.length)} accent />
              <OverviewItem label="Total Output Fields" value={String(totalOutputKeys)} accent />
            </div>
          </section>

          {/* Routes summary */}
          <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Delivery paths summary</h3>
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200/80 dark:border-gdc-border">
              <table className="w-full min-w-[720px] border-collapse text-left text-[11px]">
                <thead className="bg-slate-50/90 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-gdc-tableHeader dark:text-gdc-muted">
                  <tr>
                    <th className="px-2 py-2">#</th>
                    <th className="px-2 py-2">Destination</th>
                    <th className="px-2 py-2">Protocol</th>
                    <th className="px-2 py-2">Delivery Mode</th>
                    <th className="px-2 py-2">Failure Policy</th>
                    <th className="px-2 py-2">Rate Limit</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {routeDrafts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-2 py-6 text-center text-slate-500">
                        No delivery paths configured.
                      </td>
                    </tr>
                  ) : (
                    routeDrafts.map((r, idx) => {
                      const dest = destById.get(r.destinationId)
                      const dt = dest?.destination_type ?? state.destinations.destinationKindsById[r.destinationId] ?? ''
                      const mode = deliveryModeFromFailurePolicy(r.failurePolicy)
                      return (
                        <tr key={r.key} className="border-t border-slate-100 dark:border-gdc-border">
                          <td className="px-2 py-2 text-slate-600 dark:text-gdc-muted">{idx + 1}</td>
                          <td className="px-2 py-2 font-medium text-slate-800 dark:text-slate-100">
                            {dest?.name?.trim() || `Destination #${r.destinationId}`}
                            <div className="font-mono text-[10px] font-normal text-slate-500">{destinationEndpointShort(dest)}</div>
                          </td>
                          <td className="px-2 py-2 text-slate-700 dark:text-gdc-mutedStrong">{formatWizardSyslogLabel(dt)}</td>
                          <td className="px-2 py-2">
                            <span
                              className={cn(
                                'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                mode === 'Reliable'
                                  ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                                  : 'bg-sky-500/15 text-sky-800 dark:text-sky-200',
                              )}
                            >
                              {mode}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-slate-700 dark:text-gdc-mutedStrong">{failurePolicyBehaviorLabel(r.failurePolicy)}</td>
                          <td className="px-2 py-2 font-mono text-[10px] text-slate-600 dark:text-gdc-muted">
                            {formatWizardRateLimitDraft(r.rateLimitJson)}
                          </td>
                          <td className="px-2 py-2">
                            {r.enabled ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:border-emerald-500/35 dark:text-emerald-200">
                                <Play className="h-3 w-3" aria-hidden />
                                Enabled
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-gdc-border dark:bg-gdc-elevated dark:text-gdc-mutedStrong">
                                Disabled
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-right">
              <Link
                to={routesLink}
                className="inline-flex items-center gap-1 text-[12px] font-semibold text-violet-600 hover:underline dark:text-violet-400"
              >
                View all routes
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Checkpoint */}
            <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">Sync Position Configuration</h3>
              <dl className="mt-3 space-y-2 text-[12px]">
                <CheckpointRow label="Sync position field" value={checkpointFieldDisplay} mono />
                <CheckpointRow label="Sync position type" value={state.stream.checkpointFieldType ? state.stream.checkpointFieldType : '—'} />
                <CheckpointRow label="Initial state" value="Latest successful fetch sample (wizard)" />
                <CheckpointRow label="On start" value="Use configured sync position template / latest sample where applicable" />
                <CheckpointRow label="On error" value="Keep last committed sync position (no advance)" />
                <CheckpointRow label="On success" value="Update after all delivery paths succeed (platform default)" />
                <CheckpointRow label="State storage" value="Platform-managed sync position (PostgreSQL)" />
              </dl>
            </section>

            {/* First run / test */}
            <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">First Run (Test)</h3>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-gdc-muted">
                Runs one delivery cycle for this stream to verify end-to-end delivery.
              </p>
              {lastRun ? (
                <div
                  className={cn(
                    'mt-3 rounded-lg border p-3',
                    lastRun.res.outcome === 'completed' || lastRun.res.outcome === 'no_events'
                      ? 'border-emerald-200/80 bg-emerald-500/[0.06] dark:border-emerald-500/30'
                      : 'border-amber-200/80 bg-amber-500/[0.06] dark:border-amber-500/30',
                  )}
                >
                  <p className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">
                    Last test:{' '}
                    {lastRun.res.outcome === 'completed'
                      ? 'Completed'
                      : lastRun.res.outcome === 'no_events'
                        ? 'No events'
                        : lastRun.res.outcome === 'skipped_lock'
                          ? 'Skipped (scheduler lock)'
                          : lastRun.res.outcome}
                  </p>
                  <p className="text-[10px] text-slate-600 dark:text-gdc-muted">
                    {new Date(lastRun.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <dt className="text-slate-500">Events fetched</dt>
                      <dd className="font-semibold text-slate-900 dark:text-slate-50">
                        {lastRun.res.extracted_event_count ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Events sent</dt>
                      <dd className="font-semibold text-slate-900 dark:text-slate-50">
                        {lastRun.res.delivered_batch_event_count ?? '—'}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-slate-500">Duration</dt>
                      <dd className="font-semibold text-slate-900 dark:text-slate-50">{lastRun.durationMs} ms</dd>
                    </div>
                  </dl>
                  {lastRun.res.message ? (
                    <p className="mt-2 text-[10px] text-slate-600 dark:text-gdc-muted">{lastRun.res.message}</p>
                  ) : null}
                </div>
              ) : null}
              {runError ? (
                <div className="mt-3 rounded-lg border border-red-200/80 bg-red-500/[0.06] p-3 text-[11px] text-red-800 dark:border-red-500/35 dark:text-red-200">
                  <p className="font-semibold">Last test failed</p>
                  <p className="mt-1 break-words">{runError}</p>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void handleRunOnce()}
                disabled={streamNumericId == null || runBusy}
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 text-[13px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {runBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                {runBusy ? 'Running…' : 'Run Once Now'}
              </button>
              {streamNumericId == null ? (
                <p className="mt-2 text-[10px] text-slate-500">Create the stream first to enable a test run.</p>
              ) : null}
            </section>
          </div>

          {outcome?.errors?.length ? (
            <div className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] p-3 text-[12px] dark:border-amber-500/35 dark:bg-amber-500/10">
              <p className="font-semibold text-amber-900 dark:text-amber-100">Warnings</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-100">
                {outcome.errors.map((e, idx) => (
                  <li key={idx} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {outcome?.dataProtectionWarnings?.length ? (
            <div
              className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] p-3 text-[12px] dark:border-amber-500/35 dark:bg-amber-500/10"
              data-testid="done-data-protection-warnings"
            >
              <p className="font-semibold text-amber-900 dark:text-amber-100">Data protection</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-100">
                {outcome.dataProtectionWarnings.map((warning, idx) => (
                  <li key={idx} className="break-words">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {outcome?.schemaDriftPolicyWarnings?.length ? (
            <div
              className="rounded-lg border border-amber-200/80 bg-amber-500/[0.06] p-3 text-[12px] dark:border-amber-500/35 dark:bg-amber-500/10"
              data-testid="done-schema-drift-policy-warnings"
            >
              <p className="font-semibold text-amber-900 dark:text-amber-100">Schema drift policy</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-100">
                {outcome.schemaDriftPolicyWarnings.map((warning, idx) => (
                  <li key={idx} className="break-words">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Right column */}
        <aside className="w-full shrink-0 space-y-4 lg:sticky lg:top-4 lg:w-[min(100%,380px)] lg:self-start">
          <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Start this stream</h3>
            <div className="mt-3 space-y-2">
              <label
                className={cn(
                  'flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                  startMode === 'now'
                    ? 'border-violet-400/70 bg-violet-500/[0.06] dark:border-violet-500/50'
                    : 'border-slate-200/90 hover:bg-slate-50/80 dark:border-gdc-border dark:hover:bg-gdc-rowHover',
                )}
              >
                <input
                  type="radio"
                  name="start-mode"
                  className="mt-1"
                  checked={startMode === 'now'}
                  onChange={() => setStartMode('now')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    <span className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Start Now (Recommended)</span>
                  </div>
                  {startMode === 'now' ? (
                    <div className="mt-2 rounded-lg border border-emerald-200/80 bg-emerald-500/[0.06] px-2.5 py-2 text-[11px] text-emerald-900 dark:border-emerald-500/35 dark:text-emerald-100">
                      <span className="font-medium text-emerald-800 dark:text-emerald-200">Next run</span>{' '}
                      {nextRunPreview.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  ) : null}
                </div>
              </label>

              <label
                className={cn(
                  'flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                  startMode === 'disabled'
                    ? 'border-violet-400/70 bg-violet-500/[0.06] dark:border-violet-500/50'
                    : 'border-slate-200/90 hover:bg-slate-50/80 dark:border-gdc-border dark:hover:bg-gdc-rowHover',
                )}
              >
                <input
                  type="radio"
                  name="start-mode"
                  className="mt-1"
                  checked={startMode === 'disabled'}
                  onChange={() => setStartMode('disabled')}
                />
                <div className="flex items-center gap-2">
                  <PauseCircle className="h-4 w-4 text-slate-400" aria-hidden />
                  <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200">Keep Disabled</span>
                </div>
              </label>
            </div>

            <button
              type="button"
              onClick={() => void handlePrimaryStart()}
              disabled={
                startMode === 'now'
                  ? !startEligible || isStarting
                  : streamNumericId == null
              }
              className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 text-[13px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {startMode === 'now' && isStarting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {primaryLabel}
            </button>
          </section>

          <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Pre-run Checklist</h3>
            <ul className="mt-3 space-y-2">
              {checklist.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-2 rounded-lg border border-slate-100/90 px-2 py-2 text-[11px] dark:border-gdc-border"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-100">
                      {row.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                      ) : row.warn ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" aria-hidden />
                      )}
                      <span>{row.label}</span>
                    </div>
                    {row.detail ? <p className="mt-0.5 pl-5 text-[10px] text-slate-500">{row.detail}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <span
                      className={cn(
                        'text-[10px] font-semibold',
                        row.ok ? 'text-emerald-700 dark:text-emerald-300' : row.warn ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300',
                      )}
                    >
                      {row.ok ? 'Valid' : row.warn ? 'Review' : 'Incomplete'}
                    </span>
                    <button
                      type="button"
                      onClick={() => onNavigateToStep(row.stepKey)}
                      className="text-[10px] font-semibold text-violet-600 hover:underline dark:text-violet-400"
                    >
                      View
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div
              className={cn(
                'mt-3 rounded-lg border px-3 py-2 text-[11px] font-medium',
                allChecksPassed
                  ? 'border-emerald-200 bg-emerald-500/[0.06] text-emerald-900 dark:border-emerald-500/35 dark:text-emerald-100'
                  : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-gdc-border dark:bg-gdc-elevated dark:text-slate-200',
              )}
            >
              {allChecksPassed ? 'All checks passed! Your stream is ready.' : 'Some items need attention before production traffic.'}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card">
            <h3 className="text-[12px] font-semibold text-slate-900 dark:text-slate-100">Next Steps</h3>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
              <Link
                to={streamNumericId != null ? runtimeOverviewPath({ stream_id: streamNumericId }) : NAV_PATH.runtime}
                className="flex items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 text-center text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                <Cpu className="mr-2 h-4 w-4 text-violet-600" aria-hidden />
                Go to Operations
              </Link>
              <Link
                to={streamNumericId != null ? logsExplorerPath({ stream_id: streamNumericId }) : NAV_PATH.logs}
                className="flex items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 text-center text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                View Logs
              </Link>
              <Link
                to={streamNumericId != null ? streamEditPath(streamSlug) : NAV_PATH.streams}
                className="flex items-center justify-center rounded-lg border border-slate-200/90 bg-white px-3 py-2.5 text-center text-[12px] font-semibold text-slate-800 hover:bg-slate-50 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100 dark:hover:bg-gdc-rowHover"
              >
                Stream Settings
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

function OverviewItem({
  label,
  value,
  accent,
}: {
  label: string
  value: ReactNode
  accent?: boolean
}) {
  return (
    <div className={cn('rounded-lg border border-slate-100/90 bg-slate-50/80 px-3 py-2 dark:border-gdc-border dark:bg-gdc-card', accent && 'border-violet-200/50 bg-violet-500/[0.04] dark:border-violet-500/20')}>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-[12px] font-semibold text-slate-900 dark:text-slate-50">{value}</dd>
    </div>
  )
}

function StatusReady() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-800 dark:text-slate-100">
      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
      Ready
    </span>
  )
}

function CheckpointRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={cn('text-slate-800 dark:text-slate-100', mono && 'break-all font-mono text-[11px]')}>{value}</dd>
    </div>
  )
}
