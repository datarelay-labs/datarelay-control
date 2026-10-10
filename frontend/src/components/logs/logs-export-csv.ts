/** Export only the already-loaded, operator-filtered log rows (never fetch hidden rows).
 *
 * Keep untrusted event/sample JSON out of the tabular projection, and guard
 * spreadsheet programs against formula injection in every text cell.
 */
import { destinationFromRouteLabel, stageChipText } from './logs-console-helpers'
import { getRequestId, type LogExplorerRow } from './logs-types'

const CSV_COLUMNS = [
  'timestamp',
  'level',
  'stage',
  'status',
  'connector',
  'stream',
  'route',
  'destination',
  'latency_ms',
  'message',
  'request_id',
] as const

function csvCell(value: string | number | null): string {
  if (value == null) return '""'
  const raw = String(value)
  // Excel/Sheets can evaluate formulas even in CSV quoted text. Prefix with
  // apostrophe if the first non-whitespace character is a formula operator.
  const leading = typeof value === 'string' && /^[\s\uFEFF\u200B]*[=+\-@]/u.test(raw)
  const safe = leading ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}

export function serializeLoadedLogsCsv(rows: readonly LogExplorerRow[]): string {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const row of rows) {
    const status = typeof row.contextJson.status === 'string' ? row.contextJson.status : ''
    lines.push([
      row.timeIso,
      row.level,
      stageChipText(row),
      status,
      row.connector,
      row.stream,
      row.route,
      destinationFromRouteLabel(row.route),
      Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
      row.message,
      getRequestId(row),
    ].map(csvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
