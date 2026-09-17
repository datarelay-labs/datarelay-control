#!/usr/bin/env npx tsx
/**
 * Evaluate Full Matrix evidence against Release Gate rules.
 *
 * Status: PASS | FAIL | STALE | INCOMPLETE
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  BASELINE_DIR,
  coverageValidationPass,
  detectSmokePass,
  executionValidationPass,
  finalDir,
  hoursSince,
  loadConfig,
  loadMatrix,
  loadMatrixCounts,
  loadRunMetadata,
  readJson,
  reportDir,
  writeGithubSummary,
  writeJson,
  allCapabilities,
  loadManifest,
  evidenceFiles,
} from './lib.js'
import type {
  FlakeReport,
  MatrixCounts,
  ReleaseGateEvaluation,
  ReleaseGateIssue,
  ReleaseGateStatus,
} from './release-gate-types.js'

function parseArgs(): {
  runId: string
  commit?: string
  mode: 'nightly' | 'release' | 'rc' | 'pr'
  smokeRunId?: string
  maxAgeHours?: number
  requireSameCommit: boolean
} {
  const args = process.argv.slice(2)
  let runId = process.env.GDC_E2E_RUN_ID || ''
  let commit = process.env.GDC_E2E_EXPECT_COMMIT || undefined
  let mode: 'nightly' | 'release' | 'rc' | 'pr' = 'nightly'
  let smokeRunId: string | undefined
  let maxAgeHours: number | undefined
  let requireSameCommit = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--run-id') runId = args[++i] || runId
    else if (a === '--commit') commit = args[++i] || commit
    else if (a === '--mode') mode = (args[++i] as typeof mode) || mode
    else if (a === '--smoke-run-id') smokeRunId = args[++i]
    else if (a === '--max-age-hours') maxAgeHours = Number(args[++i])
    else if (a === '--require-same-commit') requireSameCommit = true
    else if (!a.startsWith('-') && !runId) runId = a
  }
  if (!runId) {
    console.error('Usage: evaluate-release-gate.ts --run-id <id> [--commit <sha>] [--mode nightly|release|rc|pr]')
    process.exit(2)
  }
  if (mode === 'release') requireSameCommit = true
  return { runId, commit, mode, smokeRunId, maxAgeHours, requireSameCommit }
}

function worstStatus(a: ReleaseGateStatus, b: ReleaseGateStatus): ReleaseGateStatus {
  const order: ReleaseGateStatus[] = ['PASS', 'INCOMPLETE', 'STALE', 'FAIL']
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

function validateNotImplemented(
  runId: string,
  counts: MatrixCounts,
  configExpected: number,
  failOnIncrease: boolean,
  requireEvidence: boolean,
): { ok: boolean; issues: ReleaseGateIssue[] } {
  const issues: ReleaseGateIssue[] = []
  const results = readJson<Array<{ scenario_id: string; result: string; reason?: string; capabilities?: string[] }>>(
    path.join(finalDir(runId), 'scenario-results.json'),
  )
  const niBaseline = readJson<{ count: number; scenario_ids: string[] }>(
    path.join(BASELINE_DIR, 'not-implemented-baseline.json'),
  )
  const expected = niBaseline?.count ?? configExpected

  if (failOnIncrease && counts.not_implemented > expected) {
    issues.push({
      code: 'NOT_IMPLEMENTED_INCREASED',
      severity: 'error',
      detail: `NOT_IMPLEMENTED ${counts.not_implemented} > baseline/expected ${expected}`,
    })
  }

  if (!requireEvidence || !results) {
    return { ok: issues.length === 0, issues }
  }

  const manifest = loadManifest()
  const caps = new Map(allCapabilities(manifest).map((c) => [c.id, c]))
  const matrix = loadMatrix()
  const byId = new Map(matrix.scenarios.map((s) => [s.id, s]))

  for (const r of results.filter((x) => x.result === 'NOT_IMPLEMENTED')) {
    const scenario = byId.get(r.scenario_id)
    const capIds = r.capabilities || scenario?.capabilities || []
    if (!capIds.length) {
      issues.push({
        code: 'NI_WITHOUT_CAPABILITY',
        severity: 'error',
        detail: `NOT_IMPLEMENTED ${r.scenario_id} has no capability link`,
        scenario_ids: [r.scenario_id],
      })
      continue
    }

    // Scenario may list supporting SUPPORTED caps (source/destination context).
    // Require ≥1 justifying capability in PARTIAL | UI_ONLY | RUNTIME_ONLY with evidence/limitations/reason.
    const justifying: string[] = []
    const unknown: string[] = []
    for (const cid of capIds) {
      const cap = caps.get(cid)
      if (!cap) {
        unknown.push(cid)
        continue
      }
      if (['PARTIAL', 'UI_ONLY', 'RUNTIME_ONLY'].includes(cap.status)) {
        justifying.push(cid)
        const hasLim = (cap.limitations && cap.limitations.length > 0) || evidenceFiles(cap.evidence).length > 0
        if (!hasLim && !r.reason && !scenario?.reason) {
          issues.push({
            code: 'NI_WITHOUT_EVIDENCE',
            severity: 'error',
            detail: `${r.scenario_id}: justifying capability ${cid} lacks limitations/evidence and result has no reason`,
            scenario_ids: [r.scenario_id],
          })
        }
      }
    }
    for (const cid of unknown) {
      issues.push({
        code: 'NI_UNKNOWN_CAPABILITY',
        severity: 'error',
        detail: `${r.scenario_id} references missing capability ${cid}`,
        scenario_ids: [r.scenario_id],
      })
    }
    if (!justifying.length) {
      // No PARTIAL/UI_ONLY/RUNTIME_ONLY — treat as unjustified NI / possible reclassification of SUPPORTED
      issues.push({
        code: 'NI_WITHOUT_JUSTIFYING_CAPABILITY',
        severity: 'error',
        detail: `${r.scenario_id}: NOT_IMPLEMENTED without PARTIAL/UI_ONLY/RUNTIME_ONLY capability among [${capIds.join(', ')}]`,
        scenario_ids: [r.scenario_id],
      })
      const allSupported = capIds.every((cid) => caps.get(cid)?.status === 'SUPPORTED')
      if (allSupported) {
        issues.push({
          code: 'SUPPORTED_RECLASSIFIED_AS_NI',
          severity: 'error',
          detail: `${r.scenario_id}: all linked capabilities are SUPPORTED but result is NOT_IMPLEMENTED`,
          scenario_ids: [r.scenario_id],
        })
      }
    }

    // Detect FAIL→NI reclassification: generated expected was PASS
    if (scenario?.expectedStatus === 'PASS') {
      issues.push({
        code: 'PASS_RECLASSIFIED_AS_NI',
        severity: 'error',
        detail: `${r.scenario_id}: generated expectedStatus=PASS but execution result=NOT_IMPLEMENTED`,
        scenario_ids: [r.scenario_id],
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

function requiredArtifacts(runId: string): { missing: string[]; present: string[] } {
  const required = [
    path.join(finalDir(runId), 'matrix-summary.json'),
    path.join(finalDir(runId), 'scenario-results.json'),
    path.join(finalDir(runId), 'execution-validation.json'),
    path.join(finalDir(runId), 'capability-coverage.json'),
  ]
  const missing: string[] = []
  const present: string[] = []
  for (const p of required) {
    if (fs.existsSync(p)) present.push(p)
    else missing.push(p)
  }
  return { missing, present }
}

function main(): void {
  const { runId, commit: expectCommitArg, mode, smokeRunId, maxAgeHours, requireSameCommit } = parseArgs()
  const config = loadConfig()
  const issues: ReleaseGateIssue[] = []
  const warnings: ReleaseGateIssue[] = []
  let status: ReleaseGateStatus = 'PASS'

  const meta = loadRunMetadata(runId)
  const counts = loadMatrixCounts(runId)
  const arts = requiredArtifacts(runId)
  const matrix = fs.existsSync(path.join(finalDir(runId), 'matrix-summary.json')) ? loadMatrix() : null

  if (!counts) {
    status = 'INCOMPLETE'
    issues.push({
      code: 'MISSING_MATRIX_SUMMARY',
      severity: 'error',
      detail: `No matrix-summary/execution-validation under ${finalDir(runId)}`,
      artifact_path: finalDir(runId),
    })
  }

  if (arts.missing.length) {
    status = worstStatus(status, 'INCOMPLETE')
    issues.push({
      code: 'MISSING_ARTIFACTS',
      severity: 'error',
      detail: `Missing required artifacts: ${arts.missing.map((p) => path.basename(p)).join(', ')}`,
      artifact_path: finalDir(runId),
    })
  }

  // Checksums integrity if present
  const checksumPath = path.join(finalDir(runId), 'artifact-checksums.json')
  if (fs.existsSync(checksumPath)) {
    const checksums = readJson<{ files: Array<{ path: string; sha256: string }> }>(checksumPath)
    for (const f of checksums?.files || []) {
      const abs = path.isAbsolute(f.path) ? f.path : path.join(reportDir(runId), f.path)
      if (!fs.existsSync(abs)) {
        status = worstStatus(status, 'INCOMPLETE')
        issues.push({
          code: 'CHECKSUM_FILE_MISSING',
          severity: 'error',
          detail: `Checksum lists missing file: ${f.path}`,
          artifact_path: abs,
        })
      }
    }
  }

  const smokePass = detectSmokePass(runId, smokeRunId)
  const coveragePass = coverageValidationPass(runId)
  const execPass = executionValidationPass(runId)

  const requireSmoke = config.required.smoke && mode !== 'nightly'
  if (requireSmoke && !smokePass) {
    status = worstStatus(status, 'FAIL')
    issues.push({ code: 'SMOKE_FAIL', severity: 'error', detail: 'Smoke did not PASS (or smoke evidence missing)' })
  } else if (config.required.smoke && mode === 'nightly' && !smokePass) {
    warnings.push({
      code: 'SMOKE_NOT_ATTACHED',
      severity: 'warning',
      detail: 'Nightly Full Matrix Gate does not require smoke artifact; Release/RC modes do',
    })
  }
  if (config.required.capability_validation || config.required.scenario_validation) {
    if (!coveragePass) {
      status = worstStatus(status, 'FAIL')
      issues.push({ code: 'COVERAGE_VALIDATION_FAIL', severity: 'error', detail: 'Coverage/capability validation not PASS' })
    }
  }
  if (config.required.execution_validation && !execPass) {
    status = worstStatus(status, 'FAIL')
    issues.push({
      code: 'EXECUTION_VALIDATION_FAIL',
      severity: 'error',
      detail: 'execution-validation.json ok != true',
      artifact_path: path.join(finalDir(runId), 'execution-validation.json'),
    })
  }

  if (counts) {
    const expectedScenarios = matrix?.counts.total ?? config.full_matrix.expected_scenarios
    const expectedBrowser = matrix?.counts.browser ?? config.browser.expected_scenarios

    if (counts.fail > config.full_matrix.fail_allowed) {
      status = worstStatus(status, 'FAIL')
      issues.push({ code: 'FAIL_COUNT', severity: 'error', detail: `FAIL=${counts.fail} > allowed ${config.full_matrix.fail_allowed}` })
    }
    if (counts.blocked > config.full_matrix.blocked_allowed) {
      status = worstStatus(status, 'FAIL')
      issues.push({
        code: 'BLOCKED_COUNT',
        severity: 'error',
        detail: `BLOCKED=${counts.blocked} > allowed ${config.full_matrix.blocked_allowed}`,
      })
    }
    if (counts.gap > config.full_matrix.gap_allowed) {
      status = worstStatus(status, 'FAIL')
      issues.push({
        code: 'GAP_COUNT',
        severity: 'error',
        detail: `KNOWN_PRODUCT_GAP=${counts.gap} > allowed ${config.full_matrix.gap_allowed}`,
      })
    }
    if (counts.missing > config.full_matrix.missing_allowed) {
      status = worstStatus(status, 'INCOMPLETE')
      issues.push({
        code: 'MISSING_COUNT',
        severity: 'error',
        detail: `Missing=${counts.missing} > allowed ${config.full_matrix.missing_allowed}`,
      })
    }

    if (counts.total > 0 && counts.total !== expectedScenarios) {
      warnings.push({
        code: 'SCENARIO_COUNT_DRIFT',
        severity: 'warning',
        detail: `Executed matrix total ${counts.total} vs expected/generated ${expectedScenarios}`,
      })
    }

    const browserMissing = Math.max(0, expectedBrowser - counts.browser_executed)
    if (browserMissing > config.browser.missing_allowed) {
      status = worstStatus(status, 'INCOMPLETE')
      issues.push({
        code: 'BROWSER_MISSING',
        severity: 'error',
        detail: `Browser missing=${browserMissing} (executed ${counts.browser_executed}/${expectedBrowser})`,
      })
    }

    if (config.route_processing.require_off && counts.route_off_executed <= 0) {
      status = worstStatus(status, 'INCOMPLETE')
      // ROUTE_OFF retired — canonical product matrix is ROUTE_ON only
    }
    if (config.route_processing.require_on && counts.route_on_executed <= 0) {
      status = worstStatus(status, 'INCOMPLETE')
      issues.push({ code: 'ROUTE_ON_MISSING', severity: 'error', detail: 'route-on results missing' })
    }

    const ni = validateNotImplemented(
      runId,
      counts,
      config.not_implemented.expected,
      config.not_implemented.fail_on_increase,
      config.not_implemented.require_manifest_evidence,
    )
    if (!ni.ok) {
      status = worstStatus(status, 'FAIL')
      issues.push(...ni.issues)
    } else {
      issues.push(...ni.issues.filter((i) => i.severity === 'warning'))
    }
  }

  // Evidence / freshness
  const generatedAt = meta?.generated_at || readJson<{ generated_at?: string }>(path.join(finalDir(runId), 'matrix-summary.json'))
    ?.generated_at
  const ageHours = hoursSince(generatedAt)
  const defaultMaxAge =
    mode === 'release'
      ? config.release.max_result_age_hours
      : mode === 'rc'
        ? config.release_candidate.max_result_age_hours
        : 72
  const ageLimit = maxAgeHours ?? defaultMaxAge

  if (ageHours != null && ageHours > ageLimit) {
    status = worstStatus(status, 'STALE')
    issues.push({
      code: 'RESULT_TOO_OLD',
      severity: 'error',
      detail: `Result age ${ageHours.toFixed(1)}h exceeds max ${ageLimit}h`,
    })
  }

  const reportCommit = meta?.git_commit
  const expectCommit = expectCommitArg || (requireSameCommit || mode === 'release' ? process.env.GITHUB_SHA : undefined)
  if ((requireSameCommit || mode === 'release') && expectCommit && reportCommit && reportCommit !== expectCommit) {
    status = worstStatus(status, 'STALE')
    issues.push({
      code: 'COMMIT_MISMATCH',
      severity: 'error',
      detail: `Report commit ${reportCommit} != expected ${expectCommit}`,
    })
  }
  if ((requireSameCommit || mode === 'release') && expectCommit && !reportCommit) {
    status = worstStatus(status, 'STALE')
    issues.push({
      code: 'COMMIT_METADATA_MISSING',
      severity: 'error',
      detail: 'run-metadata.json git_commit missing; cannot prove same-commit evidence',
    })
  }

  // Flaky
  const flake = readJson<FlakeReport>(path.join(finalDir(runId), 'flake-report.json'))
  const flakyCount = flake?.flaky_count ?? 0
  if (flake?.exceeds_threshold) {
    if (config.flake.fail_gate_on_exceed) {
      status = worstStatus(status, 'FAIL')
      issues.push({
        code: 'FLAKY_THRESHOLD',
        severity: 'error',
        detail: `Flaky scenarios ${flakyCount} exceed threshold ${config.flake.max_flaky_scenarios}`,
      })
    } else {
      warnings.push({
        code: 'FLAKY_THRESHOLD',
        severity: 'warning',
        detail: `Flaky scenarios ${flakyCount} exceed threshold ${config.flake.max_flaky_scenarios} — manual review`,
      })
    }
  }

  const failedScenarios =
    readJson<Array<{ scenario_id: string; result: string }>>(path.join(finalDir(runId), 'scenario-results.json'))
      ?.filter((r) => ['FAIL', 'BLOCKED', 'KNOWN_PRODUCT_GAP'].includes(r.result))
      .map((r) => r.scenario_id) || []

  const evaluation: ReleaseGateEvaluation = {
    status,
    run_id: runId,
    commit: reportCommit || 'unknown',
    expected_commit: expectCommit,
    result_age_hours: ageHours,
    generated_at: generatedAt,
    counts: counts || {
      total: 0,
      executed: 0,
      missing: 0,
      pass: 0,
      fail: 0,
      blocked: 0,
      gap: 0,
      not_implemented: 0,
      not_applicable: 0,
      browser_executed: 0,
      browser_generated: 0,
      route_off_executed: 0,
      route_on_executed: 0,
    },
    flaky_count: flakyCount,
    smoke_pass: smokePass,
    coverage_validation_pass: coveragePass,
    execution_validation_pass: execPass,
    not_implemented_ok: !issues.some((i) => i.code.startsWith('NI_') || i.code.includes('NOT_IMPLEMENTED')),
    baseline_ok: true,
    evidence_ok: !issues.some((i) => i.code.includes('COMMIT') || i.code === 'RESULT_TOO_OLD'),
    issues,
    warnings,
    failed_scenarios: failedScenarios,
    artifact_paths: arts.present,
    evaluated_at: new Date().toISOString(),
  }

  const outDir = finalDir(runId)
  fs.mkdirSync(outDir, { recursive: true })
  writeJson(path.join(outDir, 'release-gate.json'), evaluation)

  const md = [
    `# Release Gate — ${runId}`,
    '',
    `**Status: ${evaluation.status}**`,
    '',
    `| Metric | Value |`,
    `| --- | ---: |`,
    `| Capabilities (browser) | ${evaluation.counts.browser_executed} / ${evaluation.counts.browser_generated} |`,
    `| Scenarios | ${evaluation.counts.executed} / ${evaluation.counts.total} |`,
    `| route-off | ${evaluation.counts.route_off_executed} |`,
    `| route-on | ${evaluation.counts.route_on_executed} |`,
    `| PASS | ${evaluation.counts.pass} |`,
    `| FAIL | ${evaluation.counts.fail} |`,
    `| BLOCKED | ${evaluation.counts.blocked} |`,
    `| GAP | ${evaluation.counts.gap} |`,
    `| NOT_IMPLEMENTED | ${evaluation.counts.not_implemented} |`,
    `| Missing | ${evaluation.counts.missing} |`,
    `| Flaky | ${evaluation.flaky_count} |`,
    `| Commit | \`${evaluation.commit}\` |`,
    `| Result Age (h) | ${evaluation.result_age_hours?.toFixed(2) ?? 'n/a'} |`,
    `| Smoke | ${evaluation.smoke_pass ? 'PASS' : 'FAIL'} |`,
    `| Coverage | ${evaluation.coverage_validation_pass ? 'PASS' : 'FAIL'} |`,
    '',
  ]
  if (issues.length) {
    md.push('## Issues', '')
    for (const i of issues) md.push(`- **${i.code}**: ${i.detail}`)
    md.push('')
  }
  if (warnings.length) {
    md.push('## Warnings', '')
    for (const w of warnings) md.push(`- **${w.code}**: ${w.detail}`)
    md.push('')
  }
  if (failedScenarios.length) {
    md.push('## Failed scenarios', '')
    for (const id of failedScenarios.slice(0, 50)) md.push(`- \`${id}\``)
    md.push('')
    md.push(`Artifact root: \`e2e/reports/${runId}/final/\``)
    md.push('')
  }
  const mdText = md.join('\n')
  fs.writeFileSync(path.join(outDir, 'release-gate.md'), mdText)
  writeGithubSummary(mdText)

  console.log(JSON.stringify(evaluation, null, 2))
  console.log(`\nRelease Gate: ${evaluation.status}`)
  if (evaluation.status !== 'PASS') process.exit(1)
}

main()
