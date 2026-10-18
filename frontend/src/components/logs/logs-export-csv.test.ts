import { describe, expect, it } from 'vitest'
import type { LogExplorerRow } from './logs-types'
import { serializeLoadedLogsCsv } from './logs-export-csv'

function sample(overrides: Partial<LogExplorerRow> = {}): LogExplorerRow {
  return {
    id: '72',
    eventId: 'evt_72',
    timeIso: '2026-10-10T09:00:00Z',
    level: 'ERROR',
    connector: 'Payment API',
    stream: 'Payments Stream',
    route: 'Payment Route → SIEM receiver',
    message: 'Delivery attempt failed',
    durationMs: 32,
    contextJson: {
      stage: 'syslog_send',
      status: 'FAILED',
      run_id: 'run-72',
      secret_token: 'NEVER_EXPORT_INTERNAL_TOKEN',
    },
    relatedEventId: null,
    eventPreview: { password: 'NEVER_EXPORT_RAW_EVENT' },
    ...overrides,
  }
}

describe('Log Explorer CSV export of loaded matching rows', () => {
  it('exports only an explicit set of visible fields and not nested event secrets', () => {
    const csv = serializeLoadedLogsCsv([sample()])
    expect(csv.startsWith(
      '"timestamp","level","stage","status","connector","stream","route","destination","latency_ms","message","request_id"\r\n',
    )).toBe(true)
    expect(csv).toContain(
      '"2026-10-10T09:00:00Z","ERROR","SYSLOG_SEND","FAILED","Payment API","Payments Stream","Payment Route → SIEM receiver","SIEM receiver","32","Delivery attempt failed","run-72"',
    )
    expect(csv).not.toContain('NEVER_EXPORT_INTERNAL_TOKEN')
    expect(csv).not.toContain('NEVER_EXPORT_RAW_EVENT')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('quotes commas, multiline text and doubled quotes without splitting a log record', () => {
    const csv = serializeLoadedLogsCsv([
      sample({ stream: 'Same, "quoted"\nstream', message: 'retry, "again"\nplease' }),
    ])
    expect(csv).toContain('"Same, ""quoted""\nstream"')
    expect(csv).toContain('"retry, ""again""\nplease"')
    expect(csv.match(/"2026-10-10T09:00:00Z"/gu)?.length).toBe(1)
  })

  it('treats untrusted spreadsheet formula text as literal data, including whitespace and quotes', () => {
    const csv = serializeLoadedLogsCsv([sample({
      connector: '=HYPERLINK("https://example.invalid","click")',
      stream: ' \t+SUM(1,2)',
      route: '@malicious → SIEM receiver',
      message: '\n-CMD("unsafe")',
      contextJson: { stage: '=STAGE', status: '@OPEN', run_id: '=RUN_ID' },
    })])
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"",""click"")"')
    expect(csv).toContain('"\' \t+SUM(1,2)"')
    expect(csv).toContain('"\'@malicious → SIEM receiver"')
    expect(csv).toContain('"\'\n-CMD(""unsafe"")"')
    expect(csv).toContain('"\'@OPEN"')
    expect(csv).toContain('"\'=RUN_ID"')
    expect(csv).toContain('"\'=STAGE"')
  })

  it('exports a header only for an empty loaded filter and never renders non-finite duration', () => {
    const empty = serializeLoadedLogsCsv([])
    expect(empty.split('\r\n')).toHaveLength(2)
    expect(serializeLoadedLogsCsv([sample({ durationMs: Number.NaN })])).toContain(',"","Delivery attempt failed",')
  })
})
