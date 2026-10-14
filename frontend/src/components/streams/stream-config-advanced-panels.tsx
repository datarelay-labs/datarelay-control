import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { HelpTooltip } from '../ui/help-tooltip'
import { HELP_COPY } from '../ui/help-tooltip-copy'
import { NoCheckpointWarning } from './no-checkpoint-warning'
import {
  formatMappingPathForDisplay,
  formatPersistedCursorPathForDisplay,
} from './wizard/wizard-stream-config-sync'
import type { WizardConfigState } from './wizard/wizard-state'

const inputCls =
  'h-8 w-full rounded-md border border-slate-200/90 bg-white px-2 text-[12px] text-slate-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400/30 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

const readonlyCls =
  'min-h-[2rem] rounded-md border border-slate-200/90 bg-slate-50/80 px-2 py-1.5 font-mono text-[11px] text-slate-800 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-100'

const CHECKPOINT_MODES = ['Cursor (composite)', 'Cursor', 'Timestamp', 'Event ID'] as const

function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: { content: string; example?: string }
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] font-semibold text-slate-600 dark:text-gdc-mutedStrong">{label}</label>
        {help ? <HelpTooltip content={help.content} example={help.example} ariaLabel={`${label} help`} /> : null}
      </div>
      {children}
    </div>
  )
}

export function StreamConfigAdvancedPanels({
  stream,
  onChange,
}: {
  stream: WizardConfigState
  onChange: (patch: Partial<WizardConfigState>) => void
}) {
  const primaryDisplay = formatPersistedCursorPathForDisplay(stream.checkpointSourcePath, stream.eventArrayPath)
  const secondaryDisplay = formatPersistedCursorPathForDisplay(
    stream.checkpointSecondaryPath,
    stream.eventArrayPath,
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <section
          className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/40"
          data-testid="stream-config-checkpoint-panel"
        >
          <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Checkpoint</h4>
          <div className="mt-3 space-y-3">
            <Field
              label="Mode"
              help={{ content: HELP_COPY.checkpointVariable.content, example: HELP_COPY.checkpointVariable.example }}
            >
              <select
                value={stream.checkpointMode}
                onChange={(e) => onChange({ checkpointMode: e.target.value })}
                className={inputCls}
              >
                {CHECKPOINT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Primary sort field"
              help={{ content: HELP_COPY.checkpointPrimary.content, example: HELP_COPY.checkpointPrimary.example }}
            >
              <input
                value={stream.checkpointSourcePath}
                onChange={(e) => onChange({ checkpointSourcePath: e.target.value })}
                className={`${inputCls} font-mono text-[11px]`}
                placeholder="e.g. $.creationTime"
              />
              {primaryDisplay !== '—' ? (
                <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
                  Persisted path: <span className="font-mono">{primaryDisplay}</span>
                </p>
              ) : null}
            </Field>
            <Field
              label="Secondary sort field (optional)"
              help={{ content: HELP_COPY.checkpointSecondary.content, example: HELP_COPY.checkpointSecondary.example }}
            >
              <input
                value={stream.checkpointSecondaryPath}
                onChange={(e) => onChange({ checkpointSecondaryPath: e.target.value })}
                className={`${inputCls} font-mono text-[11px]`}
                placeholder="e.g. $.id"
              />
              {secondaryDisplay !== '—' ? (
                <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
                  Persisted path: <span className="font-mono">{secondaryDisplay}</span>
                </p>
              ) : null}
            </Field>
            <NoCheckpointWarning
              checkpointPath={stream.checkpointSourcePath}
              secondaryPath={stream.checkpointSecondaryPath}
            />
            <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
              Composite checkpoints are saved as ordered cursor fields and can be compared lexicographically by runtime
              logic.
            </p>
          </div>
        </section>

        <section
          className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/40"
          data-testid="stream-config-schema-detection-panel"
          id="schema-detection-section"
        >
          <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Schema Detection</h4>
          <div className="mt-3 space-y-3">
            <Field label="Event array path (from Mapping)">
              <div className={readonlyCls} data-testid="schema-detection-event-array-path">
                {formatMappingPathForDisplay(stream.eventArrayPath, stream.useWholeResponseAsEvent)}
              </div>
            </Field>
            <Field label="Event root path (from Mapping)">
              <div className={readonlyCls} data-testid="schema-detection-event-root-path">
                {formatMappingPathForDisplay(stream.eventRootPath, false)}
              </div>
            </Field>
            <Field label="Schema root path (optional)">
              <input
                value={stream.schemaRootPath}
                onChange={(e) => onChange({ schemaRootPath: e.target.value })}
                className={`${inputCls} font-mono text-[11px]`}
                placeholder="Optional schema root"
              />
            </Field>
            <button
              type="button"
              disabled
              title="Schema preview opens from Sample & Record Selection after API test"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/[0.08] px-3 text-[11px] font-semibold text-violet-700 opacity-70 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-300"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Preview Schema
            </button>
            <p className="text-[10px] text-slate-500 dark:text-gdc-muted">
              Record path and event root are configured in Sample &amp; Record Selection. Values above reflect saved
              mapping configuration.
            </p>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-slate-200/90 bg-slate-50/50 p-3 dark:border-gdc-border dark:bg-gdc-section/40">
        <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Pagination</h4>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Pagination type">
            <select
              value={stream.paginationType}
              onChange={(e) => onChange({ paginationType: e.target.value })}
              className={inputCls}
            >
              {['None', 'Cursor based', 'Page based', 'Offset based'].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pagination query parameter">
            <input
              value={stream.paginationCursorParam}
              onChange={(e) => onChange({ paginationCursorParam: e.target.value })}
              className={inputCls}
              placeholder="e.g. cursor, page, or offset"
              disabled={stream.paginationType === 'None'}
            />
          </Field>
          <p className="text-[11px] leading-5 text-slate-500 dark:text-gdc-muted md:col-span-2">
            Pagination is checkpoint-driven: the selected query parameter is sent as{' '}
            <code className="font-mono">{'{{checkpoint.next_cursor}}'}</code> on Run Test and runtime requests.
            The current runtime performs one request per poll cycle; page-size and max-page batching are not exposed here.
          </p>
        </div>
      </section>
    </div>
  )
}
