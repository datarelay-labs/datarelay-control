import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { opTable, opTd, opTh, opThRow, opTr } from '../dashboard/widgets/operational-table-styles'
import type { MappingFieldType, MappingRowModel } from '../streams/stream-mapping-model'
import type { MappingRowIssue } from '../../utils/mappingValidation'

const inputCls =
  'w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-gdc-border dark:bg-gdc-section'

type MappingBuilderTableProps = {
  rows: MappingRowModel[]
  filteredRows: MappingRowModel[]
  rowIssues: Map<string, MappingRowIssue>
  inlineSamples: Map<string, unknown>
  editingId: string | null
  onEditId: (id: string | null) => void
  onUpdateRow: (id: string, patch: Partial<MappingRowModel>) => void
  onDeleteRow: (id: string) => void
  onReorder: (fromIndex: number, toIndex: number) => void
  onAddBlank: () => void
  search: string
  onSearchChange: (q: string) => void
  /** Hide row edits while leaving mapping search usable. */
  readOnly?: boolean
}

function inferType(value: unknown): MappingFieldType {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value)) return 'datetime'
  return 'string'
}

function truncate(v: unknown, max = 48): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v
  try {
    const s = JSON.stringify(v)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return String(v)
  }
}

export function MappingBuilderTable({
  rows,
  filteredRows,
  rowIssues,
  inlineSamples,
  editingId,
  onEditId,
  onUpdateRow,
  onDeleteRow,
  onReorder,
  onAddBlank,
  search,
  onSearchChange,
  readOnly = false,
}: MappingBuilderTableProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search mappings…"
          className="h-7 min-w-[140px] flex-1 rounded-md border border-slate-200/90 bg-slate-50/80 px-2 text-[11px] dark:border-gdc-border dark:bg-gdc-section"
          aria-label="Search mapping rows"
        />
        <button
          type="button"
          onClick={onAddBlank}
          disabled={readOnly}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add row
        </button>
      </div>
      <div className="overflow-x-auto px-2 pb-2">
        <table className={opTable}>
          <thead>
            <tr className={opThRow}>
              <th className={cn(opTh, 'w-14')} scope="col">
                Order
              </th>
              <th className={opTh} scope="col">
                Source JSONPath
              </th>
              <th className={cn(opTh, 'w-8 px-0 text-center')} scope="col" aria-label="Map to">
                →
              </th>
              <th className={opTh} scope="col">
                Destination field
              </th>
              <th className={cn(opTh, 'w-20')} scope="col">
                Sample
              </th>
              <th className={cn(opTh, 'w-[88px] text-right')} scope="col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr className={opTr}>
                <td colSpan={6} className={cn(opTd, 'text-center text-slate-500')}>
                  {rows.length === 0 ? 'No mappings yet. Click a field in the source tree to add one.' : 'No rows match search.'}
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const globalIdx = rows.findIndex((r) => r.id === row.id)
                const editing = !readOnly && editingId === row.id
                const issues = rowIssues.get(row.id)
                const sample = inlineSamples.get(row.id)
                return (
                  <tr key={row.id} className={opTr}>
                    <td className={cn(opTd, 'whitespace-nowrap')}>
                      <div className="flex items-center gap-0.5">
                        <GripVertical className="h-3 w-3 text-slate-300" aria-hidden />
                        <button
                          type="button"
                          disabled={readOnly || globalIdx <= 0}
                          onClick={() => onReorder(globalIdx, globalIdx - 1)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-gdc-rowHover"
                          aria-label="Move up"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly || globalIdx < 0 || globalIdx >= rows.length - 1}
                          onClick={() => onReorder(globalIdx, globalIdx + 1)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-gdc-rowHover"
                          aria-label="Move down"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                    <td className={cn(opTd, 'max-w-[200px] font-mono text-[10px]')}>
                      {editing ? (
                        <input
                          value={row.sourceJsonPath}
                          onChange={(e) => onUpdateRow(row.id, { sourceJsonPath: e.target.value })}
                          className={cn(inputCls, issues?.emptySource && 'border-amber-400')}
                          aria-label="Source JSONPath"
                        />
                      ) : (
                        <span className="break-all text-violet-800 dark:text-violet-200">{row.sourceJsonPath || '—'}</span>
                      )}
                    </td>
                    <td className={cn(opTd, 'px-0 text-center text-slate-400')}>
                      <ArrowRight className="inline h-3.5 w-3.5" aria-hidden />
                    </td>
                    <td className={opTd}>
                      {editing ? (
                        <input
                          value={row.outputField}
                          onChange={(e) => onUpdateRow(row.id, { outputField: e.target.value })}
                          className={cn(inputCls, issues?.duplicateOutput && 'border-amber-400')}
                        />
                      ) : (
                        <span className="font-medium text-slate-800 dark:text-slate-100">{row.outputField || '—'}</span>
                      )}
                    </td>
                    <td
                      className={cn(
                        opTd,
                        'max-w-[120px] truncate font-mono text-[10px]',
                        (issues?.emptyExtraction || sample === null) && 'text-amber-700 dark:text-amber-300',
                      )}
                      title={truncate(sample, 200)}
                    >
                      {truncate(sample)}
                    </td>
                    <td className={cn(opTd, 'text-right')}>
                      <button
                        type="button"
                        className="mr-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-gdc-rowHover"
                        aria-label="Edit row"
                        disabled={readOnly}
                        onClick={() => onEditId(editing ? null : row.id)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-red-500/10 hover:text-red-700 disabled:opacity-40"
                        aria-label="Delete row"
                        disabled={readOnly}
                        onClick={() => onDeleteRow(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function applyInlineSamplesFromMapped(
  rows: MappingRowModel[],
  mappedEvent: Record<string, unknown> | null | undefined,
): Map<string, unknown> {
  const map = new Map<string, unknown>()
  if (!mappedEvent) return map
  for (const row of rows) {
    const key = row.outputField.trim()
    if (key && key in mappedEvent) map.set(row.id, mappedEvent[key])
  }
  return map
}

export function syncRowTypesFromSamples(rows: MappingRowModel[], samples: Map<string, unknown>): MappingRowModel[] {
  return rows.map((r) => {
    const v = samples.get(r.id)
    if (v === undefined) return r
    return { ...r, type: inferType(v) }
  })
}
