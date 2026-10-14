import { Database, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  runDatabaseDiscovery,
  type DatabaseDiscoveryResponse,
} from '../../../api/gdcRuntimePreview'

type Props = {
  connectorId: number
  connectorName: string
}

export function DatabaseDiscoveryPanel({ connectorId, connectorName }: Props) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DatabaseDiscoveryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [schema, setSchema] = useState('')

  useEffect(() => {
    setResult(null)
    setError(null)
    setSchema('')
  }, [connectorId])

  const visibleTables = useMemo(() => {
    if (!result) return []
    if (!schema) return result.tables
    return result.tables.filter((table) => table.schema_name === schema)
  }, [result, schema])

  const discover = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await runDatabaseDiscovery(connectorId)
      setResult(next)
      setSchema(next.schemas.includes('public') ? 'public' : next.schemas[0] ?? '')
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'Database discovery failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-slate-200/90 bg-slate-50/70 p-3 dark:border-gdc-border dark:bg-gdc-section"
      data-testid="wizard-database-discovery"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <Database className="h-4 w-4 text-violet-600 dark:text-violet-300" aria-hidden />
            <h4 className="text-[12px] font-semibold text-slate-800 dark:text-slate-100">Database discovery</h4>
          </div>
          <p className="mt-1 text-[11px] text-slate-600 dark:text-gdc-muted">
            Read-only metadata from {connectorName || `Connector #${connectorId}`}. No query or checkpoint is changed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-200"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
          {busy ? 'Discovering…' : result ? 'Refresh metadata' : 'Discover database'}
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-gdc-mutedStrong">
            <span className="font-semibold text-slate-700 dark:text-slate-200">{result.database}</span>
            <span>{result.schemas.length} schemas</span>
            <span>{result.tables.length} relations</span>
            {result.truncated ? <span className="font-semibold text-amber-700 dark:text-amber-300">bounded result</span> : null}
          </div>

          {result.schemas.length > 0 ? (
            <label className="block text-[11px] font-semibold text-slate-700 dark:text-slate-200">
              Schema
              <select
                value={schema}
                onChange={(event) => setSchema(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100"
                data-testid="wizard-database-discovery-schema"
              >
                {result.schemas.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          ) : null}

          <div className="max-h-64 space-y-2 overflow-auto pr-1" data-testid="wizard-database-discovery-relations">
            {visibleTables.length === 0 ? (
              <p className="rounded-md border border-slate-200 bg-white p-2 text-[11px] text-slate-500 dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted">
                No visible tables or views in this schema for the saved database user.
              </p>
            ) : visibleTables.map((table) => (
              <article
                key={`${table.schema_name}.${table.table_name}`}
                className="rounded-md border border-slate-200 bg-white p-2 dark:border-gdc-border dark:bg-gdc-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                    {table.schema_name}.{table.table_name}
                  </code>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                    {table.table_type}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {table.columns.map((column) => (
                    <span
                      key={column.name}
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:border-gdc-border dark:bg-gdc-section dark:text-slate-200"
                      title={`${column.data_type}${column.nullable ? ' · nullable' : ' · required'}`}
                    >
                      {column.name} <span className="text-slate-400">{column.data_type}</span>
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">{result.message}</p>
        </div>
      ) : null}
    </section>
  )
}
