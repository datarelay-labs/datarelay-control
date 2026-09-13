import { useEffect, useId, useRef } from 'react'
import { cn } from '../../lib/utils'

export type DangerousActionRisk = 'medium' | 'high' | 'critical'

export type DangerousActionConfirmMode = 'click' | 'type-name'

export type DangerousActionDependency = {
  label: string
  count?: number
  detail?: string
}

export type DangerousActionOptionalNote = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export type DangerousActionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  targetName?: string
  impactBullets?: string[]
  dependencies?: DangerousActionDependency[]
  reversibility?: string
  risk?: DangerousActionRisk
  confirmMode?: DangerousActionConfirmMode
  typeNameValue?: string
  onTypeNameChange?: (value: string) => void
  expectedTypeName?: string
  primaryLabel: string
  cancelLabel?: string
  onConfirm: () => void | Promise<void>
  busy?: boolean
  error?: string | null
  blockReason?: string | null
  optionalNote?: DangerousActionOptionalNote
  dataTestId?: string
}

function formatDependency(dep: DangerousActionDependency): string {
  if (dep.count != null) {
    const suffix = dep.count === 1 ? '' : 's'
    return `${dep.label}: ${dep.count}${suffix}${dep.detail ? ` (${dep.detail})` : ''}`
  }
  return dep.detail ? `${dep.label} (${dep.detail})` : dep.label
}

export function DangerousActionDialog({
  open,
  onOpenChange,
  title,
  targetName,
  impactBullets = [],
  dependencies = [],
  reversibility,
  risk = 'high',
  confirmMode = 'click',
  typeNameValue = '',
  onTypeNameChange,
  expectedTypeName = '',
  primaryLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  busy = false,
  error = null,
  blockReason = null,
  optionalNote,
  dataTestId = 'dangerous-action-dialog',
}: DangerousActionDialogProps) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const typedMatch =
    confirmMode !== 'type-name' || typeNameValue.trim() === expectedTypeName.trim()
  const confirmDisabled = busy || Boolean(blockReason) || !typedMatch

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={dataTestId}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onOpenChange(false)
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-gdc-border dark:bg-gdc-card">
        <h3 id={titleId} className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </h3>

        {targetName ? (
          <p className="mt-2 text-[12px] text-slate-600 dark:text-gdc-muted">
            Target: <span className="font-semibold text-slate-900 dark:text-slate-100">{targetName}</span>
          </p>
        ) : null}

        {impactBullets.length > 0 ? (
          <ul
            className="mt-2 list-inside list-disc space-y-1 text-[12px] text-slate-600 dark:text-gdc-muted"
            data-testid={`${dataTestId}-impact`}
          >
            {impactBullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
        ) : null}

        {dependencies.length > 0 ? (
          <div
            className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-100"
            data-testid={`${dataTestId}-dependencies`}
          >
            <p className="font-semibold uppercase tracking-wide text-[10px]">Impact</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {dependencies.map((dep) => (
                <li key={`${dep.label}-${dep.count ?? dep.detail ?? 'x'}`}>{formatDependency(dep)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {reversibility ? (
          <p className="mt-3 text-[11px] text-slate-500 dark:text-gdc-muted" data-testid={`${dataTestId}-reversibility`}>
            {reversibility}
          </p>
        ) : null}

        {confirmMode === 'type-name' ? (
          <div className="mt-3">
            <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
              Type{' '}
              <span className="font-semibold text-slate-800 dark:text-slate-200">{expectedTypeName}</span> to confirm.
            </p>
            <input
              value={typeNameValue}
              onChange={(event) => onTypeNameChange?.(event.target.value)}
              placeholder={expectedTypeName}
              autoComplete="off"
              className="mt-2 h-9 w-full rounded-md border border-slate-200 px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
              data-testid={`${dataTestId}-type-name`}
            />
          </div>
        ) : null}

        {optionalNote ? (
          <div className="mt-3">
            <label className="text-[11px] font-medium text-slate-600 dark:text-gdc-muted" htmlFor={`${dataTestId}-note`}>
              {optionalNote.label}
            </label>
            <input
              id={`${dataTestId}-note`}
              value={optionalNote.value}
              onChange={(event) => optionalNote.onChange(event.target.value)}
              placeholder={optionalNote.placeholder}
              className="mt-1 h-9 w-full rounded-md border border-slate-200 px-2 text-[12px] dark:border-gdc-border dark:bg-gdc-section"
              data-testid={`${dataTestId}-optional-note`}
            />
          </div>
        ) : null}

        {blockReason ? (
          <p className="mt-2 text-[11px] font-medium text-amber-700 dark:text-amber-200" data-testid={`${dataTestId}-block`}>
            {blockReason}
          </p>
        ) : null}

        {error ? (
          <p className="mt-2 text-[11px] font-medium text-gdc-criticalFg" data-testid={`${dataTestId}-error`}>
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200"
            data-testid={`${dataTestId}-cancel`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => void onConfirm()}
            className={cn(
              'rounded-md px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50',
              risk === 'medium'
                ? 'bg-amber-600 hover:bg-amber-500'
                : 'bg-gdc-critical hover:bg-gdc-critical/90',
            )}
            data-testid={`${dataTestId}-confirm`}
          >
            {busy ? 'Working…' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
