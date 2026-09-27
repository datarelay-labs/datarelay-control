#!/usr/bin/env npx tsx
/**
 * Build / refresh Release Gate baselines from current manifest + matrix (+ optional run).
 * NEVER invoked by CI automatically — operators only.
 */
import {
  BASELINE_DIR,
  currentControlCapabilities,
  gitCommit,
  loadMatrix,
  loadManifest,
  loadMatrixCounts,
  writeJson,
} from './lib.js'
import type {
  CapabilityBaseline,
  NotImplementedBaseline,
  ResultBaseline,
  ScenarioBaseline,
} from './release-gate-types.js'

function parseArgs(): { runId?: string } {
  const args = process.argv.slice(2)
  let runId: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id') runId = args[++i]
  }
  return { runId }
}

function main(): void {
  const { runId } = parseArgs()
  const commit = gitCommit()
  const generated_at = new Date().toISOString()
  const manifest = loadManifest()
  const matrix = loadMatrix()
  const caps = currentControlCapabilities(manifest)
  const byStatus: Record<string, number> = {}
  for (const c of caps) byStatus[c.status] = (byStatus[c.status] || 0) + 1

  const capability: CapabilityBaseline = {
    commit,
    generated_at,
    capability_count: caps.length,
    supported_count: byStatus.SUPPORTED || 0,
    partial_count: byStatus.PARTIAL || 0,
    ui_only_count: byStatus.UI_ONLY || 0,
    runtime_only_count: byStatus.RUNTIME_ONLY || 0,
    by_status: byStatus,
    capability_ids: caps.map((c) => c.id).sort(),
    supported_ids: caps.filter((c) => c.status === 'SUPPORTED').map((c) => c.id).sort(),
  }

  const scenario: ScenarioBaseline = {
    commit,
    generated_at,
    scenario_count: matrix.counts.total,
    browser_count: matrix.counts.browser,
    api_seeded_count: matrix.counts.api_seeded,
    route_off_count: matrix.counts.route_off,
    route_on_count: matrix.counts.route_on,
    by_suite: matrix.counts.by_suite || {},
    by_expected_status: matrix.counts.by_expected_status || {},
    scenario_ids: matrix.scenarios.map((s) => s.id).sort(),
    browser_ids: matrix.scenarios.filter((s) => s.executionMode === 'browser').map((s) => s.id).sort(),
  }

  const niScenarios = matrix.scenarios.filter((s) => s.expectedStatus === 'NOT_IMPLEMENTED')
  const statusById = new Map(caps.map((c) => [c.id, c.status]))
  const niCaps = new Set<string>()
  for (const s of niScenarios) {
    for (const c of s.capabilities) {
      if (statusById.get(c) !== 'SUPPORTED') niCaps.add(c)
    }
  }

  const notImplemented: NotImplementedBaseline = {
    commit,
    generated_at,
    count: niScenarios.length,
    scenario_ids: niScenarios.map((s) => s.id).sort(),
    capability_ids: [...niCaps].sort(),
    require_manifest_status: ['PARTIAL', 'UI_ONLY', 'RUNTIME_ONLY'],
  }

  let result: ResultBaseline = {
    commit,
    generated_at,
    run_id: runId || 'structure-only',
    scenario_count: matrix.counts.total,
    browser_count: matrix.counts.browser,
    route_off_count: matrix.counts.route_off,
    route_on_count: matrix.counts.route_on,
    pass: matrix.counts.by_expected_status?.PASS || 0,
    fail: 0,
    blocked: 0,
    gap: 0,
    not_implemented: niScenarios.length,
    missing: 0,
    suites: matrix.counts.by_suite || {},
  }

  if (runId) {
    const counts = loadMatrixCounts(runId)
    if (counts) {
      result = {
        ...result,
        run_id: runId,
        scenario_count: counts.total,
        browser_count: counts.browser_executed,
        route_off_count: counts.route_off_executed,
        route_on_count: counts.route_on_executed,
        pass: counts.pass,
        fail: counts.fail,
        blocked: counts.blocked,
        gap: counts.gap,
        not_implemented: counts.not_implemented,
        missing: counts.missing,
      }
    }
  }

  writeJson(`${BASELINE_DIR}/capability-baseline.json`, capability)
  writeJson(`${BASELINE_DIR}/scenario-baseline.json`, scenario)
  writeJson(`${BASELINE_DIR}/result-baseline.json`, result)
  writeJson(`${BASELINE_DIR}/not-implemented-baseline.json`, notImplemented)

  console.log(
    JSON.stringify(
      {
        ok: true,
        commit,
        capability_count: capability.capability_count,
        supported_count: capability.supported_count,
        scenario_count: scenario.scenario_count,
        browser_count: scenario.browser_count,
        route_off: scenario.route_off_count,
        route_on: scenario.route_on_count,
        not_implemented: notImplemented.count,
        run_id: result.run_id,
      },
      null,
      2,
    ),
  )
}

main()
