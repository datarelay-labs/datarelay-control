import { Database, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  runDatabaseDiscovery,
  type DatabaseDiscoveryResponse,
  type DatabaseDiscoveryTable,
} from '../../../api/gdcRuntimePreview'
import {
  buildDatabaseSelectionQuery,
  parseDatabaseSelectionQuery,
  type DatabaseFilterOperator,
} from './database-query-builder'

type Props = {
  connectorId: number
  connectorName: string
  sqlQuery: string
  queryParams: Record<string, string | number | boolean | null>
  checkpointColumn: string
  onApplySelection: (patch: {
    sqlQuery: string
    dbQueryParams: Record<string, string | number | boolean | null>
    dbCheckpointColumn: string
    dbCheckpointMode: 'NONE' | 'SINGLE_COLUMN'
  }) => void
}

const selectCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-900 dark:border-gdc-border dark:bg-gdc-card dark:text-slate-100'

function tableKey(table: DatabaseDiscoveryTable): string {
  return `${table.schema_name}.${table.table_name}`
}

export function DatabaseDiscoveryPanel({
  connectorId,
  connectorName,
  sqlQuery,
  queryParams,
  checkpointColumn,
  onApplySelection,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DatabaseDiscoveryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [schema, setSchema] = useState('')
  const [selectedTableKey, setSelectedTableKey] = useState('')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [filterColumn, setFilterColumn] = useState('')
  const [filterOperator, setFilterOperator] = useState<DatabaseFilterOperator>('=')
  const [filterValue, setFilterValue] = useState('')
  const [syncMode, setSyncMode] = useState<'full' | 'incremental'>('full')
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('')
  const [builderError, setBuilderError] = useState<string | null>(null)

  useEffect(() => {
    setResult(null)
    setError(null)
    setSchema('')
    setSelectedTableKey('')
    setSelectedColumns([])
    setFilterColumn('')
    setFilterValue('')
    setSyncMode('full')
    setSelectedCheckpoint('')
    setBuilderError(null)
  }, [connectorId])

  const visibleTables = useMemo(() => {
    if (!result) return []
    if (!schema) return result.tables
    return result.tables.filter((table) => table.schema_name === schema)
  }, [result, schema])

  const selectedTable = useMemo(
    () => result?.tables.find((table) => tableKey(table) === selectedTableKey) ?? null,
    [result, selectedTableKey],
  )

  useEffect(() => {
    if (!result) return
    const parsed = parseDatabaseSelectionQuery(sqlQuery, queryParams, checkpointColumn)
    if (!parsed) return
    const matched = result.tables.find(
      (table) => table.schema_name === parsed.schemaName && table.table_name === parsed.tableName,
    )
    if (!matched) return
    const available = new Set(matched.columns.map((column) => column.name))
    if (parsed.columns.some((column) => !available.has(column))) return
    setSchema(matched.schema_name)
    setSelectedTableKey(tableKey(matched))
    setSelectedColumns(parsed.columns)
    setFilterColumn(parsed.filterColumn && available.has(parsed.filterColumn) ? parsed.filterColumn : '')
    setFilterOperator(parsed.filterOperator ?? '=')
    setFilterValue(parsed.filterValue ?? '')
    setSyncMode(parsed.syncMode)
    setSelectedCheckpoint(
      parsed.checkpointColumn && available.has(parsed.checkpointColumn) ? parsed.checkpointColumn : '',
    )
  }, [checkpointColumn, queryParams, result, sqlQuery])

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

  const chooseTable = (table: DatabaseDiscoveryTable) => {
    setSchema(table.schema_name)
    setSelectedTableKey(tableKey(table))
    setSelectedColumns(table.columns.map((column) => column.name))
    setFilterColumn('')
    setFilterValue('')
    setSyncMode('full')
    setSelectedCheckpoint('')
    setBuilderError(null)
  }

  const toggleColumn = (name: string) => {
    setSelectedColumns((current) =>
      current.includes(name) ? current.filter((column) => column !== name) : [...current, name],
    )
  }

  const applySelection = () => {
    if (!selectedTable) {
      setBuilderError('Select a discovered table first.')
      return
    }
    try {
      const built = buildDatabaseSelectionQuery({
        schemaName: selectedTable.schema_name,
        tableName: selectedTable.table_name,
        columns: selectedColumns,
        filterColumn: filterColumn || undefined,
        filterOperator,
        filterValue,
        syncMode,
        checkpointColumn: selectedCheckpoint || undefined,
      })
      onApplySelection({
        sqlQuery: built.sqlQuery,
        dbQueryParams: built.queryParams,
        dbCheckpointColumn: built.dbCheckpointColumn,
        dbCheckpointMode: built.dbCheckpointMode,
      })
      setBuilderError(null)
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : 'Could not build the SELECT query.')
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
            Read-only metadata from {connectorName || `Connector #${connectorId}`}. Choose discovered fields to generate a safe SELECT, or keep using Custom SQL below.
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
                className={`mt-1 ${selectCls}`}
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
            ) : visibleTables.map((table) => {
              const selected = tableKey(table) === selectedTableKey
              return (
                <article
                  key={tableKey(table)}
                  className={`rounded-md border bg-white p-2 dark:bg-gdc-card ${selected ? 'border-violet-400 dark:border-violet-400' : 'border-slate-200 dark:border-gdc-border'}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">
                      {table.schema_name}.{table.table_name}
                    </code>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-gdc-muted">
                        {table.table_type}
                      </span>
                      <button
                        type="button"
                        onClick={() => chooseTable(table)}
                        className="rounded border border-violet-200 px-2 py-1 text-[10px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-200"
                        data-testid={`wizard-database-use-table-${table.schema_name}-${table.table_name}`}
                      >
                        {selected ? 'Selected' : 'Use table'}
                      </button>
                    </div>
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
              )
            })}
          </div>

          {selectedTable ? (
            <div className="rounded-md border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-500/30 dark:bg-violet-500/10" data-testid="wizard-database-query-builder">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Basic SELECT builder</p>
                  <p className="text-[10px] text-slate-600 dark:text-gdc-muted">
                    Values are bound separately from SQL. Custom joins/conditions stay editable in the SQL box below.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={applySelection}
                  className="h-8 rounded-md bg-violet-600 px-3 text-[11px] font-semibold text-white hover:bg-violet-700"
                  data-testid="wizard-database-apply-selection"
                >
                  Apply to SQL
                </button>
              </div>

              <fieldset className="mt-3">
                <legend className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Columns</legend>
                <div className="mt-1 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {selectedTable.columns.map((column) => (
                    <label key={column.name} className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={selectedColumns.includes(column.name)}
                        onChange={() => toggleColumn(column.name)}
                      />
                      <span className="font-mono">{column.name}</span>
                      <span className="text-[9px] text-slate-400">{column.data_type}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  Filter column
                  <select value={filterColumn} onChange={(event) => setFilterColumn(event.target.value)} className={`mt-1 ${selectCls}`}>
                    <option value="">No filter</option>
                    {selectedTable.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  Operator
                  <select value={filterOperator} onChange={(event) => setFilterOperator(event.target.value as DatabaseFilterOperator)} className={`mt-1 ${selectCls}`} disabled={!filterColumn}>
                    {['=', '!=', '>', '>=', '<', '<=', 'LIKE'].map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  Filter value
                  <input
                    value={filterValue}
                    onChange={(event) => setFilterValue(event.target.value)}
                    disabled={!filterColumn}
                    className={`mt-1 ${selectCls}`}
                    data-testid="wizard-database-filter-value"
                  />
                </label>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  Sync
                  <select
                    value={syncMode}
                    onChange={(event) => {
                      const next = event.target.value as 'full' | 'incremental'
                      setSyncMode(next)
                      if (next === 'full') setSelectedCheckpoint('')
                    }}
                    className={`mt-1 ${selectCls}`}
                    data-testid="wizard-database-sync-mode"
                  >
                    <option value="full">Full query each poll</option>
                    <option value="incremental">Incremental by checkpoint</option>
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  Checkpoint column
                  <select
                    value={selectedCheckpoint}
                    onChange={(event) => setSelectedCheckpoint(event.target.value)}
                    disabled={syncMode !== 'incremental'}
                    className={`mt-1 ${selectCls}`}
                    data-testid="wizard-database-builder-checkpoint"
                  >
                    <option value="">Select column</option>
                    {selectedTable.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                  </select>
                </label>
              </div>

              {builderError ? <p role="alert" className="mt-2 text-[11px] text-red-700 dark:text-red-300">{builderError}</p> : null}
            </div>
          ) : null}

          <p className="text-[10px] text-slate-500 dark:text-gdc-muted">{result.message}</p>
        </div>
      ) : null}
    </section>
  )
}
