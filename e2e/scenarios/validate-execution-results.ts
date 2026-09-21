#!/usr/bin/env npx tsx
/**
 * Validate that Full Matrix execution results are complete and justified.
 *
 * Checks:
 * 1. All generated scenarios have a result
 * 2. All browser scenarios have a browser execution result
 * 3. Route-ON completeness (Route-OFF is not a supported product path)
 * 4. SUPPORTED capabilities have ≥1 executed scenario
 * 5. BLOCKED / KNOWN_PRODUCT_GAP / NOT_IMPLEMENTED have required evidence
 * 6. Missing results fail the validation
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Manifest, MatrixBundle } from './scenario-types.js'

type MergedScenarioResult = {
  scenario_id: string
  suite: string
  execution_mode: string
  route_processing: string
  result: string
  attempt_count: number
  last_attempt: string
  evidence_path: string
  failure_classification?: string
  reason?: string
  capabilities?: string[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const MANIFEST = path.join(root, 'capabilities', 'data-relay-capabilities.yaml')

type Issue = { code: string; detail: string }

function loadManifest(): Manifest {
  const py = `
import json, yaml, sys
with open(sys.argv[1]) as f:
    print(json.dumps(yaml.safe_load(f)))
`
  const raw = execFileSync('python3', ['-c', py, MANIFEST], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  })
  return JSON.parse(raw) as Manifest
}

function allCapabilities(m: Manifest): Array<{ id: string; status: string }> {
  const sections = [
    m.authentication,
    m.sources,
    m.destinations,
    m.wizard,
    m.processing,
    m.routes,
    m.governance,
    m.runtime,
    m.feature_flags,
    m.test_infrastructure,
  ]
  const out: Array<{ id: string; status: string }> = []
  for (const sec of sections) {
    for (const c of sec || []) {
      if (c?.id) out.push({ id: c.id, status: String(c.status || '') })
    }
  }
  return out
}

function parseArgs(): { runId: string; resultsPath: string } {
  const args = process.argv.slice(2)
  let runId = process.env.GDC_E2E_RUN_ID || ''
  let resultsPath = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id') runId = args[++i] || runId
    else if (args[i] === '--results') resultsPath = args[++i] || ''
    else if (!args[i].startsWith('-') && !runId) runId = args[i]
  }
  if (!runId) runId = 'merged-local'
  if (!resultsPath) {
    resultsPath = path.join(root, 'reports', runId, 'final', 'scenario-results.json')
  }
  return { runId, resultsPath }
}

function evidenceHas(file: string, names: string[]): boolean {
  if (!fs.existsSync(file) && !fs.existsSync(path.dirname(file))) {
    // evidence_path may be a directory
  }
  const dir = fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file)
  if (!fs.existsSync(dir)) return false
  const listing = fs.readdirSync(dir)
  return names.some((n) => listing.includes(n) || listing.some((x) => x.includes(n)))
}

function main(): void {
  const { runId, resultsPath } = parseArgs()
  const matrixPath = path.join(root, 'scenarios', 'generated', 'full-matrix.json')
  const issues: Issue[] = []

  if (!fs.existsSync(matrixPath)) {
    console.error('Missing full-matrix.json')
    process.exit(2)
  }
  if (!fs.existsSync(resultsPath)) {
    console.error(`Missing scenario results: ${resultsPath}`)
    console.error('Run merge-results first.')
    process.exit(2)
  }

  const bundle = JSON.parse(fs.readFileSync(matrixPath, 'utf-8')) as MatrixBundle
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as MergedScenarioResult[]
  const byId = new Map(results.map((r) => [r.scenario_id, r]))

  // 1. All scenarios have results
  const missingScenarios: string[] = []
  for (const s of bundle.scenarios) {
    if (!byId.has(s.id)) missingScenarios.push(s.id)
  }
  if (missingScenarios.length) {
    issues.push({
      code: 'MISSING_SCENARIO_RESULT',
      detail: `${missingScenarios.length} scenarios without results (sample: ${missingScenarios.slice(0, 5).join(', ')})`,
    })
  }

  // 2. Browser 116 all have browser results
  const browserScenarios = bundle.scenarios.filter((s) => s.executionMode === 'browser')
  const missingBrowser: string[] = []
  for (const s of browserScenarios) {
    const r = byId.get(s.id)
    if (!r || r.execution_mode !== 'browser') missingBrowser.push(s.id)
  }
  if (missingBrowser.length) {
    issues.push({
      code: 'MISSING_BROWSER_RESULT',
      detail: `${missingBrowser.length} browser scenarios missing browser results (sample: ${missingBrowser.slice(0, 5).join(', ')})`,
    })
  }

  // 3–5. route-on completeness (Route-OFF retired)
  const routeOnNeeded = bundle.scenarios.filter((s) => s.routeProcessing === 'on' || s.id.includes('__route-on'))
  const routeOnMissing = routeOnNeeded.filter((s) => !byId.has(s.id)).map((s) => s.id)
  if (routeOnMissing.length) {
    issues.push({
      code: 'MISSING_ROUTE_ON',
      detail: `${routeOnMissing.length} route-on scenarios missing results`,
    })
  }

  // Reject accidental revival of Route-OFF executable results in current product evidence.
  const routeOffPresent = results.filter(
    (r) => r.route_processing === 'off' || r.scenario_id?.includes('__route-off'),
  )
  if (routeOffPresent.length) {
    issues.push({
      code: 'ROUTE_OFF_NOT_SUPPORTED',
      detail: `${routeOffPresent.length} route-off results present; Route Processing ON is the only supported path`,
    })
  }

  // 6. SUPPORTED capabilities executed ≥1
  const manifest = loadManifest()
  const supported = allCapabilities(manifest).filter((c) => c.status === 'SUPPORTED')
  const executedCaps = new Set<string>()
  for (const r of results) {
    for (const c of r.capabilities || []) executedCaps.add(c)
  }
  // Also pull from scenario definitions for executed scenarios
  for (const s of bundle.scenarios) {
    if (byId.has(s.id)) {
      for (const c of s.capabilities) executedCaps.add(c)
    }
  }
  const unsupportedMissing: string[] = []
  for (const c of supported) {
    // Only require caps that appear in generated scenarios
    const linked = bundle.scenarios.some((s) => s.capabilities.includes(c.id))
    if (!linked) continue
    if (!executedCaps.has(c.id)) unsupportedMissing.push(c.id)
  }
  if (unsupportedMissing.length) {
    issues.push({
      code: 'SUPPORTED_CAPABILITY_UNEXECUTED',
      detail: `${unsupportedMissing.length} SUPPORTED caps unexecuted: ${unsupportedMissing.slice(0, 10).join(', ')}`,
    })
  }

  // 7–9. Evidence rules
  for (const r of results) {
    if (r.result === 'BLOCKED') {
      if (!r.reason) {
        issues.push({ code: 'BLOCKED_WITHOUT_REASON', detail: r.scenario_id })
      }
      if (!r.evidence_path || !fs.existsSync(r.evidence_path)) {
        issues.push({ code: 'BLOCKED_WITHOUT_EVIDENCE', detail: r.scenario_id })
      } else if (!evidenceHas(r.evidence_path, ['result.json', 'failure-classification.json'])) {
        issues.push({ code: 'BLOCKED_WITHOUT_EVIDENCE', detail: r.scenario_id })
      }
    }
    if (r.result === 'KNOWN_PRODUCT_GAP') {
      if (!r.reason) {
        issues.push({ code: 'GAP_WITHOUT_REASON', detail: r.scenario_id })
      }
      if (!r.evidence_path || !fs.existsSync(r.evidence_path)) {
        issues.push({ code: 'GAP_WITHOUT_EVIDENCE', detail: r.scenario_id })
      } else {
        const required = ['scenario.json', 'result.json', 'failure-classification.json']
        const ok = evidenceHas(r.evidence_path, required)
        if (!ok) {
          issues.push({ code: 'GAP_WITHOUT_EVIDENCE', detail: `${r.scenario_id} incomplete evidence bundle` })
        }
      }
    }
    if (r.result === 'NOT_IMPLEMENTED') {
      const scenario = bundle.scenarios.find((s) => s.id === r.scenario_id)
      if (!r.reason && !scenario?.reason) {
        issues.push({ code: 'NOT_IMPLEMENTED_WITHOUT_MANIFEST_REASON', detail: r.scenario_id })
      }
    }
  }

  const byStatus: Record<string, number> = {}
  for (const r of results) byStatus[r.result] = (byStatus[r.result] || 0) + 1

  const report = {
    ok: issues.length === 0,
    run_id: runId,
    generated_at: new Date().toISOString(),
    totals: {
      Total: bundle.counts.total,
      Executed: results.length,
      PASS: byStatus.PASS || 0,
      FAIL: byStatus.FAIL || 0,
      BLOCKED: byStatus.BLOCKED || 0,
      KNOWN_PRODUCT_GAP: byStatus.KNOWN_PRODUCT_GAP || 0,
      NOT_IMPLEMENTED: byStatus.NOT_IMPLEMENTED || 0,
      NOT_APPLICABLE: byStatus.NOT_APPLICABLE || 0,
      Missing: missingScenarios.length,
    },
    browser: {
      total: browserScenarios.length,
      executed: browserScenarios.length - missingBrowser.length,
      missing: missingBrowser.length,
    },
    route: {
      off_needed: routeOffNeeded.length,
      off_missing: routeOffMissing.length,
      on_needed: routeOnNeeded.length,
      on_missing: routeOnMissing.length,
    },
    supported_capability_unexecuted: unsupportedMissing,
    scenario_result_missing: missingScenarios,
    browser_result_missing: missingBrowser,
    issues,
  }

  const outDir = path.dirname(resultsPath)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'execution-validation.json'), `${JSON.stringify(report, null, 2)}\n`)

  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) {
    console.error(`\nresults:validate FAILED with ${issues.length} issue(s)`)
    process.exit(1)
  }
  console.log('\nresults:validate PASS')
}

main()
