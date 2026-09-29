import { AlertTriangle, Bug, ChevronRight, Loader2, Play, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  runEnrichmentTracePreview,
  type EnrichmentTracePreviewResponse,
  type EnrichmentTraceRuleSummary,
} from '../../../api/gdcRuntimePreview'
import { cn } from '../../../lib/utils'
import { enrichmentDictFromRules, type WizardEnrichmentRule } from './enrichment-rules-model'

type OverridePolicy = 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'

type TransformRuleDebuggerProps = {
  loadMappedEvents: () => Promise<Array<Record<string, unknown>>>
  sampleAvailable: boolean
  rules: WizardEnrichmentRule[]
  overridePolicy?: OverridePolicy | null
}

function jsonText(value: unknown): string {
  if (value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function statusTone(summary: EnrichmentTraceRuleSummary): string {
  if (summary.error_count > 0) return 'text-red-700 dark:text-red-300'
  if (summary.warning_count > 0 || summary.blocked_count > 0) return 'text-amber-700 dark:text-amber-300'
  if (summary.changed_count > 0) return 'text-emerald-700 dark:text-emerald-300'
  return 'text-slate-600 dark:text-gdc-mutedStrong'
}

export function TransformRuleDebugger({
  loadMappedEvents,
  sampleAvailable,
  rules,
  overridePolicy = 'KEEP_EXISTING',
}: TransformRuleDebuggerProps) {
  const [loading, setLoading] = useState(false)
  const [throughLoading, setThroughLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EnrichmentTracePreviewResponse | null>(null)
  const [throughResult, setThroughResult] = useState<EnrichmentTracePreviewResponse | null>(null)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)
  const [selectedSample, setSelectedSample] = useState(0)
  const [mappedEvents, setMappedEvents] = useState<Array<Record<string, unknown>>>([])
  const requestGenerationRef = useRef(0)

  const activeRules = useMemo(
    () => rules.filter((rule) => rule.enabled && rule.fieldName.trim()),
    [rules],
  )
  const enrichment = useMemo(() => enrichmentDictFromRules(activeRules), [activeRules])
  const samples = useMemo(() => mappedEvents.slice(0, 20), [mappedEvents])

  useEffect(() => {
    requestGenerationRef.current += 1
    setLoading(false)
    setThroughLoading(false)
    setResult(null)
    setThroughResult(null)
    setSelectedStep(null)
    setSelectedSample(0)
    setMappedEvents([])
    setError(null)
  }, [enrichment, overridePolicy, loadMappedEvents])

  const runAll = useCallback(async () => {
    if (!sampleAvailable || activeRules.length === 0) return
    const generation = ++requestGenerationRef.current
    setLoading(true)
    setThroughLoading(false)
    setError(null)
    try {
      const resolvedSamples = (await loadMappedEvents()).slice(0, 20)
      if (generation !== requestGenerationRef.current) return
      if (resolvedSamples.length === 0) {
        setResult(null)
        setMappedEvents([])
        setError('No runtime-mapped sample events are available. Refresh the source sample and try again.')
        return
      }
      setMappedEvents(resolvedSamples)
      const response = await runEnrichmentTracePreview({
        mapped_events: resolvedSamples,
        enrichment,
        override_policy: overridePolicy ?? 'KEEP_EXISTING',
      })
      if (generation !== requestGenerationRef.current) return
      setResult(response)
      setThroughResult(null)
      setSelectedStep(null)
      setSelectedSample(0)
    } catch (err) {
      if (generation !== requestGenerationRef.current) return
      setResult(null)
      setMappedEvents([])
      setError(err instanceof Error ? err.message : 'Rule preview failed')
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false)
    }
  }, [activeRules.length, enrichment, loadMappedEvents, overridePolicy, sampleAvailable])

  const runThrough = useCallback(
    async (stepIndex: number, sampleIndex = selectedSample) => {
      if (samples.length === 0) return
      const generation = ++requestGenerationRef.current
      setThroughLoading(true)
      setError(null)
      setSelectedStep(stepIndex)
      setSelectedSample(Math.min(sampleIndex, samples.length - 1))
      try {
        const response = await runEnrichmentTracePreview({
          mapped_events: samples,
          enrichment,
          override_policy: overridePolicy ?? 'KEEP_EXISTING',
          through_step: stepIndex,
        })
        if (generation !== requestGenerationRef.current) return
        setThroughResult(response)
      } catch (err) {
        if (generation !== requestGenerationRef.current) return
        setThroughResult(null)
        setError(err instanceof Error ? err.message : 'Rule preview failed')
      } finally {
        if (generation === requestGenerationRef.current) setThroughLoading(false)
      }
    },
    [enrichment, overridePolicy, samples, selectedSample],
  )

  const selectedSummary = result?.rule_summaries.find((summary) => summary.step_index === selectedStep) ?? null
  const selectedTrace = throughResult?.samples[selectedSample] ?? null
  const selectedStepTrace = selectedTrace?.steps.find((step) => step.step_index === selectedStep) ?? null

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white dark:border-gdc-border dark:bg-gdc-card"
      aria-label="Transform rule debugger"
      data-testid="transform-rule-debugger"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-3 py-2.5 dark:border-gdc-border">
        <div className="flex min-w-0 gap-2">
          <Bug className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
          <div>
            <p className="text-[12px] font-semibold text-slate-900 dark:text-gdc-foreground">Rule debugger</p>
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-gdc-muted">
              Runs the same Guided Transform engine as runtime. Static values execute first; other Guided rules
              follow their persisted runtime order.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={loading || activeRules.length === 0 || !sampleAvailable}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-gdc-primary px-3 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          Preview rules
        </button>
      </div>

      <div className="space-y-3 p-3">
        {activeRules.length === 0 ? (
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Add a Guided Transform rule to preview rule-level evidence.</p>
        ) : !sampleAvailable ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-300">Load a source sample before previewing rules.</p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/[0.06] px-2.5 py-2 text-[11px] text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}

        {result ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-slate-600 dark:text-gdc-muted">
                {result.rule_count} runtime step{result.rule_count === 1 ? '' : 's'} · {result.preview_event_count} sample
                {result.preview_event_count === 1 ? '' : 's'}
              </p>
              <button
                type="button"
                onClick={() => void runAll()}
                disabled={loading}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2 text-[10px] font-medium hover:bg-slate-50 dark:border-gdc-border dark:hover:bg-gdc-rowHover"
              >
                <RefreshCw className="h-3 w-3" aria-hidden />
                Refresh
              </button>
            </div>

            <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-gdc-border">
              <table className="w-full min-w-[700px] border-collapse text-left text-[11px]">
                <thead className="bg-slate-50 text-slate-500 dark:bg-gdc-section dark:text-gdc-muted">
                  <tr>
                    <th className="px-2.5 py-2 font-semibold">Runtime order</th>
                    <th className="px-2.5 py-2 font-semibold">Rule</th>
                    <th className="px-2.5 py-2 font-semibold">Executed</th>
                    <th className="px-2.5 py-2 font-semibold">Changed</th>
                    <th className="px-2.5 py-2 font-semibold">Warnings</th>
                    <th className="px-2.5 py-2 font-semibold">Errors</th>
                    <th className="px-2.5 py-2 font-semibold">Blocked</th>
                    <th className="px-2.5 py-2 font-semibold">Evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-gdc-divider">
                  {result.rule_summaries.map((summary) => (
                    <tr key={summary.step_index} className="hover:bg-slate-50 dark:hover:bg-gdc-rowHover">
                      <td className="px-2.5 py-2 tabular-nums text-slate-500 dark:text-gdc-muted">#{summary.step_index + 1}</td>
                      <td className="px-2.5 py-2">
                        <span className="block font-semibold text-slate-900 dark:text-gdc-foreground">{summary.target_field}</span>
                        <span className="block text-[10px] capitalize text-slate-500 dark:text-gdc-muted">{summary.rule_type}</span>
                      </td>
                      <td className="px-2.5 py-2 tabular-nums">{summary.executed_count}/{result.preview_event_count}</td>
                      <td className={cn('px-2.5 py-2 font-semibold tabular-nums', statusTone(summary))}>{summary.changed_count}</td>
                      <td className={cn('px-2.5 py-2 tabular-nums', summary.warning_count > 0 && 'text-amber-700 dark:text-amber-300')}>
                        {summary.warning_count}
                      </td>
                      <td className={cn('px-2.5 py-2 tabular-nums', summary.error_count > 0 && 'text-red-700 dark:text-red-300')}>
                        {summary.error_count}
                      </td>
                      <td className={cn('px-2.5 py-2 tabular-nums', summary.blocked_count > 0 && 'text-amber-700 dark:text-amber-300')}>
                        {summary.blocked_count}
                      </td>
                      <td className="px-2.5 py-2">
                        <button
                          type="button"
                          onClick={() => void runThrough(summary.step_index)}
                          disabled={throughLoading}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-gdc-border dark:text-violet-300 dark:hover:bg-gdc-rowHover"
                        >
                          Preview through
                          <ChevronRight className="h-3 w-3" aria-hidden />
                        </button>
                        {summary.failed_sample_indices.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1" aria-label={`Failed samples for ${summary.target_field}`}>
                            {summary.failed_sample_indices.map((sampleIndex) => (
                              <button
                                key={sampleIndex}
                                type="button"
                                onClick={() => void runThrough(summary.step_index, sampleIndex)}
                                className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-1.5 py-0.5 text-[9px] font-semibold text-red-700 dark:text-red-300"
                              >
                                Sample {sampleIndex + 1}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selectedStep != null ? (
              <div className="rounded-md border border-slate-200 bg-slate-50/60 p-2.5 dark:border-gdc-border dark:bg-gdc-section">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold text-slate-900 dark:text-gdc-foreground">
                      After rule #{selectedStep + 1}
                      {selectedSummary ? ` · ${selectedSummary.target_field}` : ''}
                    </p>
                    <p className="text-[9px] text-slate-500 dark:text-gdc-muted">Runtime output through the selected rule.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {throughResult && throughResult.samples.length > 1 ? (
                      <label className="flex items-center gap-1 text-[9px] text-slate-500 dark:text-gdc-muted">
                        Sample
                        <select
                          aria-label="Debugger sample"
                          value={selectedSample}
                          onChange={(event) => setSelectedSample(Number(event.target.value))}
                          className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[10px] dark:border-gdc-border dark:bg-gdc-card"
                        >
                          {throughResult.samples.map((sample) => (
                            <option key={sample.sample_index} value={sample.sample_index}>
                              {sample.sample_index + 1}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <span className="text-[9px] text-slate-500 dark:text-gdc-muted">Sample {selectedSample + 1}</span>
                    )}
                    {throughLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-600" aria-hidden /> : null}
                  </div>
                </div>
                {selectedStepTrace ? (
                  <>
                    <div className="mb-2 grid gap-2 sm:grid-cols-2">
                      <ValueCell label="Before" present={selectedStepTrace.before_present} value={selectedStepTrace.before_value} />
                      <ValueCell label="After" present={selectedStepTrace.after_present} value={selectedStepTrace.after_value} />
                    </div>
                    {selectedStepTrace.error_message ? (
                      <p className="mb-2 rounded-md border border-red-500/25 bg-red-500/[0.06] px-2 py-1.5 text-[10px] text-red-700 dark:text-red-300">
                        {selectedStepTrace.error_message}
                      </p>
                    ) : null}
                    {selectedStepTrace.warning_messages.length > 0 ? (
                      <ul className="mb-2 space-y-1 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-200">
                        {selectedStepTrace.warning_messages.map((message, index) => (
                          <li key={`${selectedStepTrace.warning_codes[index] ?? 'warning'}:${index}`}>
                            {selectedStepTrace.warning_codes[index] ? `${selectedStepTrace.warning_codes[index]}: ` : ''}
                            {message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
                <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-950 p-2.5 text-[10px] leading-relaxed text-slate-100 dark:border-gdc-border dark:bg-gdc-page">
                  {throughLoading ? 'Loading…' : jsonText(selectedTrace?.output_event)}
                </pre>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}

function ValueCell({ label, present, value }: { label: string; present: boolean; value: unknown }) {
  return (
    <div className="min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1.5 dark:border-gdc-border dark:bg-gdc-card">
      <p className="text-[9px] font-semibold text-slate-500 dark:text-gdc-muted">{label}</p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-slate-800 dark:text-gdc-foreground" title={present ? jsonText(value) : 'Missing'}>
        {present ? jsonText(value) : 'Missing'}
      </p>
    </div>
  )
}
