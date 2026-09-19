import fs from 'node:fs'
import path from 'node:path'
import { redactValue } from './redact.js'
import type { EvidenceLevel, ScenarioStatus } from './types.js'

export type LedgerRow = {
  RUN_ID: string
  RESOURCE_TYPE: string
  RESOURCE_ID: string
  RESOURCE_NAME: string
  PARENT: string
  CREATED_AT: string
  CLEANUP_STATUS: string
}

export type IssueRow = {
  ISSUE_ID: string
  SEVERITY: string
  SCENARIO: string
  USER_ACTION: string
  PAGE: string
  EXPECTED: string
  ACTUAL: string
  USER_VISIBLE_SYMPTOM: string
  BROWSER_EVIDENCE: string
  API_EVIDENCE: string
  RUNTIME_EVIDENCE: string
  DESTINATION_EVIDENCE: string
  ROOT_CAUSE: string
  FIX_DIRECTION: string
  REPRODUCIBLE: string
  BLOCKED_BY?: string
}

export class ArtifactStore {
  readonly dir: string
  readonly screenshots: string
  readonly failures: string
  private issueSeq = 0
  ledger: LedgerRow[] = []
  issues: IssueRow[] = []
  scenarios: Array<{
    id: string
    status: ScenarioStatus
    note: string
    evidence: EvidenceLevel[]
    startedAt: string
    finishedAt: string
  }> = []
  browserActions: string[] = ['ts\taction\tpage\tdetail']
  networkRows: string[] = ['ts\taction\tmethod\tpath\tstatus']
  deliveryRows: string[] = ['ts\tscenario\tmarker\tpath\tfound']
  statusRows: string[] = ['ts\tresource\tui_status\tapi_status\tnote']
  checkpointRows: string[] = ['ts\tstream\tevent\tcheckpoint\tnote']
  cleanupRows: string[] = ['ts\ttype\tid\tstatus\tnote']
  flags: Record<string, string> = {}
  counts: Record<string, number> = {}

  constructor(
    readonly runId: string,
    baseDir = process.env.ULC_ARTIFACT_DIR || '/tmp/data-relay-real-browser-e2e',
  ) {
    this.dir = path.join(baseDir, runId)
    this.screenshots = path.join(this.dir, 'screenshots')
    this.failures = path.join(this.dir, 'failures')
    fs.mkdirSync(this.screenshots, { recursive: true })
    fs.mkdirSync(this.failures, { recursive: true })
  }

  statePath(): string {
    return path.join(this.dir, 'state.json')
  }

  loadState(): Record<string, unknown> | null {
    const p = this.statePath()
    if (!fs.existsSync(p)) return null
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }

  saveState(extra: Record<string, unknown> = {}): void {
    const payload = {
      run_id: this.runId,
      updated_at: new Date().toISOString(),
      scenarios: this.scenarios,
      ledger: this.ledger,
      flags: this.flags,
      counts: this.counts,
      issue_ids: this.issues.map((i) => i.ISSUE_ID),
      ...extra,
    }
    fs.writeFileSync(this.statePath(), JSON.stringify(payload, null, 2))
  }

  track(type: string, id: string | number, name: string, parent = ''): void {
    this.ledger.push({
      RUN_ID: this.runId,
      RESOURCE_TYPE: type,
      RESOURCE_ID: String(id),
      RESOURCE_NAME: name,
      PARENT: parent,
      CREATED_AT: new Date().toISOString(),
      CLEANUP_STATUS: 'OPEN',
    })
    this.saveState()
  }

  markCleanup(type: string, id: string | number, status: string, note = ''): void {
    const row = this.ledger.find((r) => r.RESOURCE_TYPE === type && r.RESOURCE_ID === String(id))
    if (row) row.CLEANUP_STATUS = status
    this.cleanupRows.push(`${new Date().toISOString()}\t${type}\t${id}\t${status}\t${note.replace(/\t/g, ' ')}`)
    this.saveState()
  }

  action(action: string, page: string, detail = ''): void {
    this.browserActions.push(
      `${new Date().toISOString()}\t${action}\t${page}\t${String(detail).replace(/\t|\n/g, ' ').slice(0, 400)}`,
    )
  }

  network(action: string, method: string, pathName: string, status: number): void {
    this.networkRows.push(`${new Date().toISOString()}\t${action}\t${method}\t${pathName}\t${status}`)
  }

  delivery(scenario: string, marker: string, pathName: string, found: boolean): void {
    this.deliveryRows.push(`${new Date().toISOString()}\t${scenario}\t${marker}\t${pathName}\t${found ? 'YES' : 'NO'}`)
  }

  rec(
    id: string,
    status: ScenarioStatus,
    note = '',
    evidence: EvidenceLevel[] = ['BROWSER_E2E'],
  ): void {
    const now = new Date().toISOString()
    this.scenarios.push({
      id,
      status,
      note: note.replace(/\n/g, ' ').slice(0, 800),
      evidence,
      startedAt: now,
      finishedAt: now,
    })
    this.counts[status] = (this.counts[status] || 0) + 1
    const line = status === 'PASS' ? `${id} PASS` : `${id} ${status} ${note.slice(0, 120)}`
    console.log(line)
    this.saveState({ last_scenario: id })
  }

  issue( partial: Omit<IssueRow, 'ISSUE_ID'> & { ISSUE_ID?: string }): string {
    this.issueSeq += 1
    const id = partial.ISSUE_ID || `RUE2E-${String(this.issueSeq).padStart(3, '0')}`
    const row: IssueRow = {
      ISSUE_ID: id,
      SEVERITY: partial.SEVERITY,
      SCENARIO: partial.SCENARIO,
      USER_ACTION: partial.USER_ACTION,
      PAGE: partial.PAGE,
      EXPECTED: partial.EXPECTED,
      ACTUAL: String(partial.ACTUAL).slice(0, 1500),
      USER_VISIBLE_SYMPTOM: partial.USER_VISIBLE_SYMPTOM,
      BROWSER_EVIDENCE: partial.BROWSER_EVIDENCE || '',
      API_EVIDENCE: partial.API_EVIDENCE || '',
      RUNTIME_EVIDENCE: partial.RUNTIME_EVIDENCE || '',
      DESTINATION_EVIDENCE: partial.DESTINATION_EVIDENCE || '',
      ROOT_CAUSE: partial.ROOT_CAUSE || '',
      FIX_DIRECTION: partial.FIX_DIRECTION || '',
      REPRODUCIBLE: partial.REPRODUCIBLE || 'YES',
      BLOCKED_BY: partial.BLOCKED_BY,
    }
    this.issues.push(row)
    fs.writeFileSync(
      path.join(this.failures, `${id}.txt`),
      Object.entries(row)
        .map(([k, v]) => `${k}=${v ?? ''}`)
        .join('\n'),
    )
    console.log(`  ISSUE ${id} | ${row.SEVERITY} | ${row.SCENARIO} | ${row.USER_VISIBLE_SYMPTOM.slice(0, 100)}`)
    this.saveState()
    return id
  }

  setFlag(key: string, value: string): void {
    this.flags[key] = value
    this.saveState()
  }

  writeJson(name: string, data: unknown): void {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(redactValue(data), null, 2))
  }

  flush(): void {
    const tsv = (rows: string[]) => rows.join('\n') + '\n'
    fs.writeFileSync(path.join(this.dir, 'resource-ledger.tsv'), this.ledgerToTsv())
    fs.writeFileSync(path.join(this.dir, 'issues.tsv'), this.issuesToTsv())
    fs.writeFileSync(
      path.join(this.dir, 'scenario-results.tsv'),
      ['id\tstatus\tnote\tevidence', ...this.scenarios.map((s) => `${s.id}\t${s.status}\t${s.note}\t${s.evidence.join(',')}`)].join(
        '\n',
      ) + '\n',
    )
    fs.writeFileSync(path.join(this.dir, 'browser-actions.tsv'), tsv(this.browserActions))
    fs.writeFileSync(path.join(this.dir, 'network-evidence.tsv'), tsv(this.networkRows))
    fs.writeFileSync(path.join(this.dir, 'delivery-evidence.tsv'), tsv(this.deliveryRows))
    fs.writeFileSync(path.join(this.dir, 'status-evidence.tsv'), tsv(this.statusRows))
    fs.writeFileSync(path.join(this.dir, 'checkpoint-evidence.tsv'), tsv(this.checkpointRows))
    fs.writeFileSync(path.join(this.dir, 'cleanup-results.tsv'), tsv(this.cleanupRows))
    this.saveState({ flushed_at: new Date().toISOString() })
  }

  private ledgerToTsv(): string {
    const headers = [
      'RUN_ID',
      'RESOURCE_TYPE',
      'RESOURCE_ID',
      'RESOURCE_NAME',
      'PARENT',
      'CREATED_AT',
      'CLEANUP_STATUS',
    ]
    const lines = [headers.join('\t')]
    for (const r of this.ledger) {
      lines.push(headers.map((h) => String((r as Record<string, string>)[h] ?? '')).join('\t'))
    }
    return lines.join('\n') + '\n'
  }

  private issuesToTsv(): string {
    if (!this.issues.length) return 'ISSUE_ID\tSEVERITY\tSCENARIO\tUSER_VISIBLE_SYMPTOM\n'
    const headers = Object.keys(this.issues[0]) as (keyof IssueRow)[]
    const lines = [headers.join('\t')]
    for (const r of this.issues) {
      lines.push(headers.map((h) => String(r[h] ?? '').replace(/\t|\n/g, ' ')).join('\t'))
    }
    return lines.join('\n') + '\n'
  }
}
