#!/usr/bin/env npx tsx
/**
 * Compare current Capability Manifest + generated Matrix against committed baselines.
 * Detects structural regressions (not PASS/FAIL snapshot locking).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  BASELINE_DIR,
  allCapabilities,
  evidenceFiles,
  finalDir,
  loadBaselines,
  loadConfig,
  loadManifest,
  loadMatrix,
  loadMatrixCounts,
  readJson,
  writeGithubSummary,
  writeJson,
} from './lib.js'
import type { BaselineComparison, ReleaseGateIssue, ReleaseGateStatus } from './release-gate-types.js'

function parseArgs(): { runId?: string; writeReport: boolean } {
  const args = process.argv.slice(2)
  let runId: string | undefined
  let writeReport = true
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id') runId = args[++i]
    else if (args[i] === '--no-write') writeReport = false
  }
  return { runId, writeReport }
}

function main(): void {
  const { runId, writeReport } = parseArgs()
  const config = loadConfig()
  const baselines = loadBaselines()
  if (!baselines.capability || !baselines.scenario || !baselines.notImplemented) {
    console.error('Missing baseline files under e2e/release-gate/baseline/')
    process.exit(2)
  }

  const manifest = loadManifest()
  const matrix = loadMatrix()
  const caps = allCapabilities(manifest)
  const supported = caps.filter((c) => c.status === 'SUPPORTED')
  const issues: ReleaseGateIssue[] = []
  const warnings: ReleaseGateIssue[] = []
  const deltas: BaselineComparison['deltas'] = {}

  const curCapabilityCount = caps.length
  const curSupported = supported.length
  const curScenario = matrix.counts.total
  const curBrowser = matrix.counts.browser
  const curRouteOff = matrix.counts.route_off
  const curRouteOn = matrix.counts.route_on
  const curNi = matrix.counts.by_expected_status?.NOT_IMPLEMENTED ?? 0

  const setDelta = (key: string, baseline: number, current: number) => {
    deltas[key] = { baseline, current, delta: current - baseline }
  }
  setDelta('capability_count', baselines.capability.capability_count, curCapabilityCount)
  setDelta('supported_count', baselines.capability.supported_count, curSupported)
  setDelta('scenario_count', baselines.scenario.scenario_count, curScenario)
  setDelta('browser_count', baselines.scenario.browser_count, curBrowser)
  setDelta('route_off_count', baselines.scenario.route_off_count, curRouteOff)
  setDelta('route_on_count', baselines.scenario.route_on_count, curRouteOn)
  setDelta('not_implemented_count', baselines.notImplemented.count, curNi)

  if (curSupported < baselines.capability.supported_count) {
    issues.push({
      code: 'SUPPORTED_DECREASED',
      severity: 'error',
      detail: `SUPPORTED ${curSupported} < baseline ${baselines.capability.supported_count}`,
    })
  }
  if (curScenario < baselines.scenario.scenario_count) {
    issues.push({
      code: 'SCENARIO_DECREASED',
      severity: 'error',
      detail: `Scenarios ${curScenario} < baseline ${baselines.scenario.scenario_count}`,
    })
  }
  if (curBrowser < baselines.scenario.browser_count) {
    issues.push({
      code: 'BROWSER_DECREASED',
      severity: 'error',
      detail: `Browser scenarios ${curBrowser} < baseline ${baselines.scenario.browser_count}`,
    })
  }
  // Route-OFF is retired; a decrease (including to zero) is expected and not a regression.
  if (curRouteOff > baselines.scenario.route_off_count) {
    warnings.push({
      code: 'ROUTE_OFF_INCREASED',
      severity: 'warning',
      detail: `route-off ${curRouteOff} > baseline ${baselines.scenario.route_off_count} (retired path should not grow)`,
    })
  }
  if (curRouteOn < baselines.scenario.route_on_count) {
    issues.push({
      code: 'ROUTE_ON_DECREASED',
      severity: 'error',
      detail: `route-on ${curRouteOn} < baseline ${baselines.scenario.route_on_count}`,
    })
  }
  if (config.not_implemented.fail_on_increase && curNi > baselines.notImplemented.count) {
    issues.push({
      code: 'NOT_IMPLEMENTED_INCREASED',
      severity: 'error',
      detail: `NOT_IMPLEMENTED ${curNi} > baseline ${baselines.notImplemented.count}`,
    })
  }

  // Suite coverage
  for (const [suite, count] of Object.entries(baselines.scenario.by_suite || {})) {
    const cur = matrix.counts.by_suite?.[suite] ?? 0
    if (cur === 0 && count > 0) {
      issues.push({
        code: 'SUITE_MISSING',
        severity: 'error',
        detail: `Suite ${suite} missing (baseline had ${count})`,
      })
    } else if (cur < count) {
      warnings.push({
        code: 'SUITE_DECREASED',
        severity: 'warning',
        detail: `Suite ${suite}: ${cur} < baseline ${count}`,
      })
    }
  }

  // New capabilities should have scenarios
  const baselineCapIds = new Set(baselines.capability.capability_ids)
  const newCaps = caps.filter((c) => !baselineCapIds.has(c.id))
  for (const c of newCaps) {
    const linked = matrix.scenarios.some((s) => s.capabilities.includes(c.id))
    if (!linked && ['SUPPORTED', 'PARTIAL', 'UI_ONLY', 'RUNTIME_ONLY'].includes(c.status)) {
      issues.push({
        code: 'NEW_CAPABILITY_WITHOUT_SCENARIO',
        severity: 'error',
        detail: `New capability ${c.id} (${c.status}) has no generated scenario`,
      })
    }
  }

  // Previously supported executed capabilities must not become unexecuted in results (when run provided)
  if (runId) {
    const counts = loadMatrixCounts(runId)
    const validation = readJson<{ supported_capability_unexecuted?: string[] }>(
      path.join(finalDir(runId), 'execution-validation.json'),
    )
    const unexecuted = validation?.supported_capability_unexecuted || []
    if (unexecuted.length) {
      issues.push({
        code: 'SUPPORTED_UNEXECUTED',
        severity: 'error',
        detail: `SUPPORTED capabilities unexecuted: ${unexecuted.slice(0, 10).join(', ')}`,
      })
    }
    // Previously PASS capability becoming missing results
    if (counts && counts.missing > 0) {
      issues.push({
        code: 'PREVIOUSLY_COVERED_MISSING',
        severity: 'error',
        detail: `${counts.missing} scenarios missing results (previously covered structure)`,
      })
    }
  }

  // Manifest evidence sanity for NI baseline caps
  for (const cid of baselines.notImplemented.capability_ids || []) {
    const cap = caps.find((c) => c.id === cid)
    if (!cap) {
      warnings.push({
        code: 'NI_BASELINE_CAP_REMOVED',
        severity: 'warning',
        detail: `Baseline NI capability ${cid} no longer in manifest (NI decrease OK if intentional)`,
      })
      continue
    }
    if (cap.status === 'SUPPORTED') {
      warnings.push({
        code: 'NI_CAP_NOW_SUPPORTED',
        severity: 'warning',
        detail: `${cid} is now SUPPORTED — refresh NI baseline after regenerating scenarios`,
      })
    }
    void evidenceFiles
  }

  const status: ReleaseGateStatus = issues.length ? 'FAIL' : 'PASS'
  const comparison: BaselineComparison = {
    ok: issues.length === 0,
    status,
    issues,
    warnings,
    deltas,
  }

  console.log(JSON.stringify(comparison, null, 2))
  const md = [
    `# Baseline Comparison`,
    '',
    `Status: **${status}**`,
    '',
    `| Metric | Baseline | Current | Δ |`,
    `| --- | ---: | ---: | ---: |`,
    ...Object.entries(deltas).map(
      ([k, v]) => `| ${k} | ${v.baseline} | ${v.current} | ${v.delta >= 0 ? '+' : ''}${v.delta} |`,
    ),
    '',
    ...issues.map((i) => `- **${i.code}**: ${i.detail}`),
    ...warnings.map((w) => `- warning **${w.code}**: ${w.detail}`),
    '',
    'Baseline updates must be explicit (never auto-updated by CI).',
    '',
  ].join('\n')
  writeGithubSummary(md)

  if (writeReport && runId) {
    writeJson(path.join(finalDir(runId), 'baseline-comparison.json'), comparison)
    fs.writeFileSync(path.join(finalDir(runId), 'baseline-comparison.md'), md)
  } else if (writeReport) {
    const outDir = path.join(BASELINE_DIR, '..', 'reports')
    fs.mkdirSync(outDir, { recursive: true })
    writeJson(path.join(outDir, 'baseline-comparison.json'), comparison)
    fs.writeFileSync(path.join(outDir, 'baseline-comparison.md'), md)
  }

  if (!comparison.ok) process.exit(1)
  console.log('\nbaseline comparison PASS')
}

main()
