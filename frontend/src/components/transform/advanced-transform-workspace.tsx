import { AlertTriangle, Eye, Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { runTransformPreview, type TransformPreviewResponse } from '../../api/gdcRuntimePreview'
import { cn } from '../../lib/utils'
import {
  defaultAdvancedRule,
  newAdvancedTransformRuleId,
  type AdvancedTransformRuleDraft,
  type AdvancedTransformUiMode,
  type TransformPreviewStage,
} from '../../types/advancedTransform'
import {
  buildEnrichmentWithAdvancedFields,
  buildFieldMappingsWithTransformRules,
  collectSourcePathOptions,
  ruleDraftToApiPayload,
  rulesToAdvancedFieldsApi,
  rulesToTransformRulesApi,
} from '../../utils/advancedTransformConfig'
import { PanelChrome } from '../streams/mapping-json-tree'
import { TimestampUtcTransformGuide } from './timestamp-utc-transform-guide'

const GUIDANCE_LINES = [
  '외부 도구에서 작성한 JSONata/Regex를 붙여넣고 Preview로 검증할 수 있습니다.',
  '제품 내부에서는 AI 호출을 수행하지 않습니다.',
] as const

export type AdvancedTransformWorkspaceProps = {
  stage: TransformPreviewStage
  sampleEvent: Record<string, unknown> | null
  rules: AdvancedTransformRuleDraft[]
  onRulesChange: (rules: AdvancedTransformRuleDraft[]) => void
  /** Mapping: simple JSONPath map merged into preview/save. */
  simpleFieldMappings?: Record<string, string>
  /** Enrichment: static keys merged into preview/save. */
  enrichmentStatic?: Record<string, unknown>
  overridePolicy?: 'KEEP_EXISTING' | 'OVERRIDE' | 'ERROR_ON_CONFLICT'
  /** When set, only show rules matching this UI mode tab (advanced vs expert). */
  filterUiMode?: AdvancedTransformUiMode
  /** User-facing context label (avoids Mapping/Enrichment stage terminology). */
  contextLabel?: string
  /** Block rule edits while leaving Preview usable. */
  readOnly?: boolean
}

function issueLabel(item: { code?: string | null; message?: string; error_message?: string }): string {
  return item.message || item.error_message || item.code || 'Unknown issue'
}

export function AdvancedTransformWorkspace({
  stage,
  sampleEvent,
  rules,
  onRulesChange,
  simpleFieldMappings = {},
  enrichmentStatic = {},
  overridePolicy = 'KEEP_EXISTING',
  filterUiMode,
  contextLabel = 'Transform',
  readOnly = false,
}: AdvancedTransformWorkspaceProps) {
  const [preview, setPreview] = useState<TransformPreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const visibleRules = useMemo(
    () => (filterUiMode ? rules.filter((r) => r.uiMode === filterUiMode) : rules),
    [rules, filterUiMode],
  )

  const sourcePathOptions = useMemo(() => collectSourcePathOptions(sampleEvent), [sampleEvent])

  const updateRule = useCallback(
    (id: string, patch: Partial<AdvancedTransformRuleDraft>) => {
      if (readOnly) return
      onRulesChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    },
    [readOnly, rules, onRulesChange],
  )

  const removeRule = useCallback(
    (id: string) => {
      if (readOnly) return
      onRulesChange(rules.filter((r) => r.id !== id))
    },
    [readOnly, rules, onRulesChange],
  )

  const addRule = useCallback(
    (uiMode: AdvancedTransformUiMode) => {
      if (readOnly) return
      onRulesChange([...rules, defaultAdvancedRule(uiMode)])
    },
    [readOnly, rules, onRulesChange],
  )

  const insertTimestampUtcJsonataRule = useCallback(
    (expression: string) => {
      if (readOnly) return
      const rule = defaultAdvancedRule('advanced')
      onRulesChange([
        ...rules,
        {
          ...rule,
          id: newAdvancedTransformRuleId(),
          outputField: 'timestamp',
          expression,
          ruleId: 'timestamp-utc',
        },
      ])
    },
    [readOnly, rules, onRulesChange],
  )

  const runPreview = useCallback(async () => {
    if (!sampleEvent) {
      setPreviewError('샘플 이벤트가 없습니다. 소스 샘플을 먼저 불러오세요.')
      return
    }
    const apiRules = filterUiMode
      ? rules.filter((r) => r.uiMode === filterUiMode).map(ruleDraftToApiPayload)
      : rules.map(ruleDraftToApiPayload)
    if (apiRules.length === 0) {
      setPreviewError('Preview할 규칙이 없습니다. 출력 필드와 표현식을 입력하세요.')
      return
    }

    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const body =
        stage === 'mapping'
          ? {
              stage: 'mapping' as const,
              sample_event: sampleEvent,
              rules: apiRules,
              field_mappings: buildFieldMappingsWithTransformRules(simpleFieldMappings, rules),
            }
          : {
              stage: 'enrichment' as const,
              sample_event: sampleEvent,
              enrichment: buildEnrichmentWithAdvancedFields(enrichmentStatic, rules),
              override_policy: overridePolicy,
            }
      const res = await runTransformPreview(body)
      setPreview(res)
    } catch (e) {
      setPreview(null)
      setPreviewError(e instanceof Error ? e.message : 'Preview request failed')
    } finally {
      setPreviewLoading(false)
    }
  }, [sampleEvent, rules, filterUiMode, stage, simpleFieldMappings, enrichmentStatic, overridePolicy])

  const previewJson = useMemo(
    () => (preview ? JSON.stringify(preview.transformed_result, null, 2) : ''),
    [preview],
  )

  const timestampUtcMode: 'jsonata' | 'regex' = filterUiMode === 'expert' ? 'regex' : 'jsonata'

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 px-3 py-2.5 dark:border-gdc-border dark:bg-gdc-section">
        <div className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
          <div className="space-y-1 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">
            {GUIDANCE_LINES.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </div>

      <TimestampUtcTransformGuide
        mode={timestampUtcMode}
        variant="field_rule"
        sampleEvent={sampleEvent}
        onInsertExpression={readOnly || timestampUtcMode === 'regex' ? undefined : insertTimestampUtcJsonataRule}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-slate-600 dark:text-gdc-muted">
          {contextLabel} · Safe Expression Engine ·{' '}
          <span className="font-semibold">{visibleRules.length}</span> rule(s)
        </p>
        <div className="flex flex-wrap gap-2">
          {!filterUiMode ? (
            <>
              <button
                type="button"
                onClick={() => addRule('advanced')}
                disabled={readOnly}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-violet-500/35 bg-violet-500/[0.06] px-2.5 text-[11px] font-semibold text-violet-800 disabled:opacity-50 dark:text-violet-200"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                JSONata rule
              </button>
              <button
                type="button"
                onClick={() => addRule('expert')}
                disabled={readOnly}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-200/90 px-2.5 text-[11px] font-semibold text-slate-700 disabled:opacity-50 dark:border-gdc-border dark:text-slate-200"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Regex extract rule
              </button>
            </>
          ) : filterUiMode === 'advanced' ? (
            <button
              type="button"
              onClick={() => addRule('advanced')}
              disabled={readOnly}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add JSONata rule
            </button>
          ) : (
            <button
              type="button"
              onClick={() => addRule('expert')}
              disabled={readOnly}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-slate-800 px-2.5 text-[11px] font-semibold text-white disabled:opacity-50 dark:bg-slate-600"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add Regex extract rule
            </button>
          )}
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={previewLoading || !sampleEvent}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-500/40 bg-white px-3 text-[11px] font-semibold text-violet-700 shadow-sm hover:bg-violet-500/[0.06] disabled:opacity-50 dark:border-violet-500/35 dark:bg-gdc-card dark:text-violet-300"
          >
            {previewLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
            Preview
          </button>
        </div>
      </div>

      {visibleRules.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200/90 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-gdc-border">
          {filterUiMode === 'expert'
            ? 'Regex extract 규칙을 추가하세요. message 등 문자열 필드에서 값을 추출합니다.'
            : filterUiMode === 'advanced'
              ? 'JSONata 표현식으로 필드를 조합하거나 조건식을 적용하세요.'
              : 'Advanced 또는 Expert 규칙을 추가하세요.'}
        </p>
      ) : (
        <div className="space-y-2">
          {visibleRules.map((rule) => (
            <div
              key={rule.id}
              className="rounded-lg border border-slate-200/80 bg-white p-3 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span
                  className={cn(
                    'inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    rule.uiMode === 'expert'
                      ? 'bg-slate-200/80 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
                      : 'bg-violet-500/15 text-violet-800 dark:text-violet-200',
                  )}
                >
                  {rule.uiMode === 'expert' ? 'Expert · Regex' : 'Advanced · JSONata'}
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(rule.id)}
                  disabled={readOnly}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                  aria-label="Remove rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[11px]">
                  <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Output field</span>
                  <input
                    value={rule.outputField}
                    disabled={readOnly}
                    onChange={(e) => updateRule(rule.id, { outputField: e.target.value })}
                    placeholder="event_source"
                    className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
                  />
                </label>
                <label className="block text-[11px]">
                  <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Rule id (optional)</span>
                  <input
                    value={rule.ruleId}
                    disabled={readOnly}
                    onChange={(e) => updateRule(rule.id, { ruleId: e.target.value })}
                    placeholder="rule-1"
                    className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
                  />
                </label>
              </div>

              {rule.mode === 'jsonata' ? (
                <label className="mt-2 block text-[11px]">
                  <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">JSONata expression</span>
                  <textarea
                    value={rule.expression}
                    disabled={readOnly}
                    onChange={(e) => updateRule(rule.id, { expression: e.target.value })}
                    rows={3}
                    placeholder="vendor & '_' & product & '_' & log_type"
                    className="mt-0.5 w-full resize-y rounded-md border border-slate-200/90 bg-slate-50/50 px-2 py-1.5 font-mono text-[12px] leading-relaxed dark:border-gdc-border dark:bg-gdc-section"
                  />
                </label>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="block text-[11px]">
                    <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Source field</span>
                    <select
                      value={rule.sourcePath}
                      disabled={readOnly}
                      onChange={(e) => updateRule(rule.id, { sourcePath: e.target.value })}
                      className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
                    >
                      {sourcePathOptions.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-[11px]">
                    <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Capture group</span>
                    <input
                      type="number"
                      min={1}
                      value={rule.group}
                      disabled={readOnly}
                      onChange={(e) => updateRule(rule.id, { group: Number(e.target.value) || 1 })}
                      className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
                    />
                  </label>
                  <label className="block text-[11px] sm:col-span-2">
                    <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Pattern</span>
                    <input
                      value={rule.pattern}
                      disabled={readOnly}
                      onChange={(e) => updateRule(rule.id, { pattern: e.target.value })}
                      placeholder="src=(\\d+\\.\\d+\\.\\d+\\.\\d+)"
                      className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
                    />
                  </label>
                </div>
              )}

              <label className="mt-2 block text-[11px]">
                <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Default / fallback</span>
                <input
                  value={rule.defaultValue}
                  disabled={readOnly}
                  onChange={(e) => updateRule(rule.id, { defaultValue: e.target.value })}
                  placeholder='unknown_source or null'
                  className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-slate-50/50 px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
                />
              </label>
            </div>
          ))}
        </div>
      )}

      {previewError ? (
        <p className="flex items-start gap-2 rounded-md border border-red-200/80 bg-red-500/[0.06] px-2.5 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {previewError}
        </p>
      ) : null}

      {preview ? (
        <PanelChrome
          title="Transform Preview"
          right={
            preview.save_blocked ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-red-800 dark:text-red-200">
                Save blocked
              </span>
            ) : preview.warnings.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-900 dark:text-amber-100">
                Warnings
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800 dark:text-emerald-200">
                OK
              </span>
            )
          }
        >
          <div className="space-y-3 p-3">
            <p className="text-[11px] text-slate-600 dark:text-gdc-muted">{preview.message}</p>

            {preview.save_blocked ? (
              <p className="rounded-md border border-red-200/80 bg-red-500/[0.06] px-2 py-1.5 text-[11px] font-medium text-red-800 dark:border-red-500/30 dark:text-red-200">
                저장이 차단되었습니다. 설정 오류를 수정한 뒤 다시 Preview 하세요.
              </p>
            ) : null}

            {(preview.errors.length > 0 || preview.warnings.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {preview.errors.length > 0 ? (
                  <div className="rounded-md border border-red-200/70 bg-red-500/[0.04] p-2 dark:border-red-500/25">
                    <p className="text-[10px] font-bold uppercase text-red-800 dark:text-red-200">Errors</p>
                    <ul className="mt-1 space-y-1 text-[11px] text-red-900 dark:text-red-100">
                      {preview.errors.map((e, i) => (
                        <li key={`e-${i}`}>
                          <span className="font-mono font-semibold">{e.output_field || e.level}</span>: {issueLabel(e)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {preview.warnings.length > 0 ? (
                  <div className="rounded-md border border-amber-200/70 bg-amber-500/[0.05] p-2 dark:border-amber-500/25">
                    <p className="text-[10px] font-bold uppercase text-amber-900 dark:text-amber-100">Warnings</p>
                    <ul className="mt-1 space-y-1 text-[11px] text-amber-950 dark:text-amber-100/90">
                      {preview.warnings.map((w, i) => (
                        <li key={`w-${i}`}>
                          <span className="font-mono font-semibold">{w.output_field || '—'}</span>: {issueLabel(w)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}

            {preview.field_results.length > 0 ? (
              <div className="overflow-x-auto rounded-md border border-slate-200/70 dark:border-gdc-border">
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-200/80 bg-slate-50/80 text-left dark:border-gdc-border dark:bg-gdc-section">
                      <th className="px-2 py-1 font-semibold">Field</th>
                      <th className="px-2 py-1 font-semibold">Mode</th>
                      <th className="px-2 py-1 font-semibold">Value</th>
                      <th className="px-2 py-1 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.field_results.map((fr) => (
                      <tr key={fr.output_field} className="border-b border-slate-100 last:border-0 dark:border-gdc-border">
                        <td className="px-2 py-1 font-mono font-semibold">{fr.output_field}</td>
                        <td className="px-2 py-1">{fr.mode}</td>
                        <td className="max-w-[140px] truncate px-2 py-1 font-mono">{JSON.stringify(fr.value)}</td>
                        <td className="px-2 py-1">
                          {fr.success ? (
                            fr.recovered_via_default ? (
                              <span className="text-amber-700 dark:text-amber-300">default</span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-300">ok</span>
                            )
                          ) : (
                            <span className="text-red-700 dark:text-red-300">{fr.error_code}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Transformed result</p>
              <pre className="mt-1 max-h-[200px] overflow-auto rounded-md border border-slate-200/70 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100">
                {previewJson || '{}'}
              </pre>
            </div>
          </div>
        </PanelChrome>
      ) : null}
    </div>
  )
}

/** Export helpers for save handlers. */
export { rulesToTransformRulesApi, rulesToAdvancedFieldsApi, buildFieldMappingsWithTransformRules, buildEnrichmentWithAdvancedFields }
