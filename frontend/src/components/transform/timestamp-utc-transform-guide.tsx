import { AlertTriangle, Clock3, Copy, FileInput } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import { copyTextToClipboard } from '../../utils/clipboard'
import { collectSourcePathOptions } from '../../utils/advancedTransformConfig'
import {
  TIMESTAMP_UTC_AFFORDANCE_LABEL,
  TIMESTAMP_UTC_JSONATA_GUIDANCE,
  TIMESTAMP_UTC_REGEX_LIMITATION_GUIDANCE,
  buildTimestampUtcFieldJsonataExpression,
  buildTimestampUtcFullEventJsonataTemplate,
  suggestTimestampSourcePath,
} from '../../utils/timestampUtcTransformTemplate'

export type TimestampUtcTransformGuideProps = {
  mode: 'jsonata' | 'regex'
  /** full_event inserts a $merge template; field_rule inserts a per-field expression. */
  variant: 'full_event' | 'field_rule'
  sampleEvent?: Record<string, unknown> | null
  onInsertExpression?: (expression: string) => void
  className?: string
}

export function TimestampUtcTransformGuide({
  mode,
  variant,
  sampleEvent = null,
  onInsertExpression,
  className,
}: TimestampUtcTransformGuideProps) {
  const pathOptions = useMemo(() => collectSourcePathOptions(sampleEvent), [sampleEvent])
  const [sourcePath, setSourcePath] = useState(() => suggestTimestampSourcePath(pathOptions))
  const [outputField, setOutputField] = useState('timestamp')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    setSourcePath((prev) => (pathOptions.includes(prev) ? prev : suggestTimestampSourcePath(pathOptions)))
  }, [pathOptions])

  const template = useMemo(() => {
    if (variant === 'full_event') {
      return buildTimestampUtcFullEventJsonataTemplate(sourcePath, outputField)
    }
    return buildTimestampUtcFieldJsonataExpression(sourcePath)
  }, [variant, sourcePath, outputField])

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(template)
    setCopyStatus(ok ? 'copied' : 'failed')
    window.setTimeout(() => setCopyStatus('idle'), 1800)
  }

  if (mode === 'regex') {
    return (
      <div
        className={cn(
          'rounded-lg border border-amber-200/80 bg-amber-500/[0.06] px-3 py-2.5 dark:border-amber-500/35 dark:bg-amber-500/10',
          className,
        )}
        data-testid="timestamp-utc-transform-guide"
        data-mode="regex"
      >
        <div className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <div className="space-y-1 text-[12px] leading-relaxed text-amber-950 dark:text-amber-100">
            <p className="font-semibold">{TIMESTAMP_UTC_AFFORDANCE_LABEL}</p>
            {TIMESTAMP_UTC_REGEX_LIMITATION_GUIDANCE.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-violet-200/80 bg-violet-500/[0.04] px-3 py-2.5 dark:border-violet-500/30 dark:bg-violet-500/10',
        className,
      )}
      data-testid="timestamp-utc-transform-guide"
      data-mode="jsonata"
      data-variant={variant}
    >
      <div className="flex gap-2">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-1 text-[12px] leading-relaxed text-slate-700 dark:text-slate-200">
            <p className="font-semibold text-violet-900 dark:text-violet-100">{TIMESTAMP_UTC_AFFORDANCE_LABEL}</p>
            {TIMESTAMP_UTC_JSONATA_GUIDANCE.map((line) => (
              <p key={line} className="text-slate-600 dark:text-gdc-muted">
                {line}
              </p>
            ))}
          </div>

          <div className={cn('grid gap-2', variant === 'full_event' ? 'sm:grid-cols-2' : 'sm:grid-cols-1')}>
            <label className="block text-[11px]">
              <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Source timestamp field</span>
              <select
                value={pathOptions.includes(sourcePath) ? sourcePath : pathOptions[0] || sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                aria-label="Source timestamp field"
                data-testid="timestamp-utc-source-field"
                className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
              >
                {!pathOptions.includes(sourcePath) && sourcePath ? (
                  <option value={sourcePath}>{sourcePath}</option>
                ) : null}
                {pathOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            {variant === 'full_event' ? (
              <label className="block text-[11px]">
                <span className="font-semibold text-slate-600 dark:text-gdc-mutedStrong">Output field</span>
                <input
                  value={outputField}
                  onChange={(e) => setOutputField(e.target.value)}
                  aria-label="Timestamp output field"
                  data-testid="timestamp-utc-output-field"
                  placeholder="timestamp"
                  className="mt-0.5 h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 font-mono text-[11px] dark:border-gdc-border dark:bg-gdc-section"
                />
              </label>
            ) : null}
          </div>

          <pre
            className="max-h-[140px] overflow-auto rounded-md border border-slate-200/70 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100"
            data-testid="timestamp-utc-template-preview"
          >
            {template}
          </pre>

          <div className="flex flex-wrap items-center gap-2">
            {onInsertExpression ? (
              <button
                type="button"
                onClick={() => onInsertExpression(template)}
                data-testid="timestamp-utc-insert-template"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-2.5 text-[11px] font-semibold text-white"
              >
                <FileInput className="h-3.5 w-3.5" aria-hidden />
                Insert template
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void handleCopy()}
              data-testid="timestamp-utc-copy-template"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-500/40 bg-white px-2.5 text-[11px] font-semibold text-violet-700 shadow-sm hover:bg-violet-500/[0.06] dark:border-violet-500/35 dark:bg-gdc-card dark:text-violet-300"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy template
            </button>
            {copyStatus === 'copied' ? (
              <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Copied</span>
            ) : null}
            {copyStatus === 'failed' ? (
              <span className="text-[11px] font-medium text-red-700 dark:text-red-300">Copy failed</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
