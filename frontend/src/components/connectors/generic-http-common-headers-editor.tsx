import { Plus, Trash2 } from 'lucide-react'

const rowCls =
  'h-9 w-full rounded border border-slate-200 px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

type Props = {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

function rowsFromRecord(rec: Record<string, string>): Array<{ id: string; key: string; value: string }> {
  const entries = Object.entries(rec || {})
  return entries.map(([key, v], idx) => ({
    id: `h-${idx}-${key}`,
    key,
    value: String(v ?? ''),
  }))
}

export function GenericHttpCommonHeadersEditor({ value, onChange }: Props) {
  const rows = rowsFromRecord(value)

  function push(nextRows: Array<{ id: string; key: string; value: string }>) {
    const out: Record<string, string> = {}
    for (const r of nextRows) {
      const k = r.key.trim()
      if (!k) continue
      out[k] = r.value
    }
    onChange(out)
  }

  function update(idx: number, patch: Partial<{ key: string; value: string }>) {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    push(next)
  }

  function remove(idx: number) {
    push(rows.filter((_, i) => i !== idx))
  }

  function add() {
    push([...rows, { id: `h-${Date.now()}`, key: '', value: '' }])
  }

  return (
    <div className="w-full min-w-0 max-w-full rounded-lg border border-slate-200 p-3 dark:border-gdc-border">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-semibold text-slate-900 dark:text-slate-50">Common Headers</h4>
          <p className="text-[11px] text-slate-500 dark:text-gdc-muted">Inherited by every stream using this connector.</p>
        </div>
        <button
          type="button"
          onClick={add}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-violet-300/60 bg-white px-2 text-[11px] font-semibold text-violet-700 hover:bg-violet-500/[0.08] dark:border-violet-500/40 dark:bg-gdc-card dark:text-violet-300"
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add header
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-[11px] italic text-slate-500 dark:text-gdc-muted">No headers. Defaults may apply on create until you add rows.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row, idx) => (
            <li key={row.id} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input className={rowCls} value={row.key} placeholder="Header name" aria-label={`Header ${idx + 1} name`} onChange={(e) => update(idx, { key: e.target.value })} />
              <input className={rowCls} value={row.value} placeholder="Value" aria-label={`Header ${idx + 1} value`} onChange={(e) => update(idx, { value: e.target.value })} />
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600 dark:border-gdc-border dark:bg-gdc-section"
                aria-label={`Remove header ${idx + 1}`}
                onClick={() => remove(idx)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
