export type DatabaseFilterOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE'

export type DatabaseQuerySelection = {
  schemaName: string
  tableName: string
  columns: string[]
  filterColumn?: string
  filterOperator?: DatabaseFilterOperator
  filterValue?: string
  syncMode: 'full' | 'incremental'
  checkpointColumn?: string
}

export type BuiltDatabaseQuery = {
  sqlQuery: string
  queryParams: Record<string, string>
  dbCheckpointColumn: string
  dbCheckpointMode: 'NONE' | 'SINGLE_COLUMN'
}

const FILTER_PARAM = 'ui_filter_1'
const FILTER_OPERATORS = new Set<DatabaseFilterOperator>(['=', '!=', '>', '>=', '<', '<=', 'LIKE'])

export function quotePostgresIdentifier(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

export function unquotePostgresIdentifier(token: string): string | null {
  const text = token.trim()
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return null
  const inner = text.slice(1, -1)
  if (/(^|[^"])"(?:[^"]|$)/.test(inner)) return null
  return inner.replace(/""/g, '"')
}

export function buildDatabaseSelectionQuery(selection: DatabaseQuerySelection): BuiltDatabaseQuery {
  if (!selection.schemaName || !selection.tableName) throw new Error('Select a discovered table first.')
  if (selection.columns.length === 0) throw new Error('Select at least one discovered column.')

  const uniqueColumns = [...new Set(selection.columns)]
  const columnsSql = uniqueColumns.map(quotePostgresIdentifier).join(', ')
  let sqlQuery = `SELECT ${columnsSql} FROM ${quotePostgresIdentifier(selection.schemaName)}.${quotePostgresIdentifier(selection.tableName)}`
  const queryParams: Record<string, string> = {}

  const filterColumn = selection.filterColumn?.trim() ?? ''
  const filterValue = selection.filterValue ?? ''
  if (filterColumn && filterValue !== '') {
    const operator = selection.filterOperator ?? '='
    if (!FILTER_OPERATORS.has(operator)) throw new Error('Unsupported filter operator.')
    sqlQuery += ` WHERE ${quotePostgresIdentifier(filterColumn)} ${operator} %(${FILTER_PARAM})s`
    queryParams[FILTER_PARAM] = filterValue
  }

  const checkpointColumn = selection.syncMode === 'incremental'
    ? String(selection.checkpointColumn ?? '').trim()
    : ''
  if (selection.syncMode === 'incremental' && !checkpointColumn) {
    throw new Error('Select a checkpoint column for incremental sync.')
  }

  return {
    sqlQuery,
    queryParams,
    dbCheckpointColumn: checkpointColumn,
    dbCheckpointMode: checkpointColumn ? 'SINGLE_COLUMN' : 'NONE',
  }
}

type ParsedDatabaseSelection = DatabaseQuerySelection & {
  queryParams: Record<string, string>
}

const QUOTED_IDENTIFIER = '"(?:[^"]|"")*"'

export function parseDatabaseSelectionQuery(
  sqlQuery: string,
  queryParams: Record<string, unknown> | null | undefined,
  checkpointColumn: string,
): ParsedDatabaseSelection | null {
  const sql = sqlQuery.trim()
  const re = new RegExp(
    `^SELECT\\s+(.+?)\\s+FROM\\s+(${QUOTED_IDENTIFIER})\\.(${QUOTED_IDENTIFIER})(?:\\s+WHERE\\s+(${QUOTED_IDENTIFIER})\\s*(=|!=|>=|<=|>|<|LIKE)\\s*%\\(${FILTER_PARAM}\\)s)?$`,
    'i',
  )
  const match = re.exec(sql)
  if (!match) return null

  const schemaName = unquotePostgresIdentifier(match[2] ?? '')
  const tableName = unquotePostgresIdentifier(match[3] ?? '')
  if (schemaName == null || tableName == null) return null

  const columnTokens = (match[1] ?? '').split(',').map((part) => part.trim())
  const columns = columnTokens.map(unquotePostgresIdentifier)
  if (columns.length === 0 || columns.some((value) => value == null)) return null

  const rawParams = queryParams && typeof queryParams === 'object' ? queryParams : {}
  const filterColumn = match[4] ? unquotePostgresIdentifier(match[4]) : null
  const filterOperator = match[5]?.toUpperCase() as DatabaseFilterOperator | undefined
  if (match[4] && (filterColumn == null || !filterOperator || !FILTER_OPERATORS.has(filterOperator))) return null

  const checkpoint = checkpointColumn.trim()
  return {
    schemaName,
    tableName,
    columns: columns as string[],
    filterColumn: filterColumn ?? undefined,
    filterOperator,
    filterValue: filterColumn ? String(rawParams[FILTER_PARAM] ?? '') : undefined,
    syncMode: checkpoint ? 'incremental' : 'full',
    checkpointColumn: checkpoint || undefined,
    queryParams: Object.fromEntries(
      Object.entries(rawParams).map(([key, value]) => [key, String(value ?? '')]),
    ),
  }
}
