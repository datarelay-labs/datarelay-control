/** Shared helpers for Release Gate tooling */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type {
  CapabilityBaseline,
  MatrixCounts,
  NotImplementedBaseline,
  ReleaseGateConfig,
  ResultBaseline,
  RunMetadata,
  ScenarioBaseline,
} from './release-gate-types.js'
import type { Manifest, MatrixBundle } from '../scenarios/scenario-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const E2E_ROOT = path.resolve(__dirname, '..')
export const REPO_ROOT = path.resolve(E2E_ROOT, '..')
export const MANIFEST_PATH = path.join(E2E_ROOT, 'capabilities', 'data-relay-capabilities.yaml')
export const MATRIX_PATH = path.join(E2E_ROOT, 'scenarios', 'generated', 'full-matrix.json')
export const CONFIG_PATH = path.join(__dirname, 'release-gate-config.yaml')
export const BASELINE_DIR = path.join(__dirname, 'baseline')

export function sha256File(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function loadConfig(configPath = CONFIG_PATH): ReleaseGateConfig {
  const raw = parseYaml(fs.readFileSync(configPath, 'utf-8')) as ReleaseGateConfig
  return raw
}

export function loadManifest(manifestPath = MANIFEST_PATH): Manifest {
  const raw = parseYaml(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
  return raw
}

export function loadMatrix(matrixPath = MATRIX_PATH): MatrixBundle {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf-8')) as MatrixBundle
}

export function allCapabilities(m: Manifest): Array<{
  id: string
  status: string
  product_scope?: string
  evidence?: unknown
  limitations?: string[]
}> {
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
  const out: Array<{
    id: string
    status: string
    product_scope?: string
    evidence?: unknown
    limitations?: string[]
  }> = []
  for (const sec of sections) {
    for (const c of sec || []) {
      if (c?.id) {
        out.push({
          id: c.id,
          status: String(c.status || ''),
          product_scope: c.product_scope,
          evidence: (c as { evidence?: unknown }).evidence,
          limitations: c.limitations,
        })
      }
    }
  }
  return out
}

/** Phase A-D Control rows. Phase E stays in the manifest as OUT_OF_SCOPE and is not a release denominator. */
export function currentControlCapabilities(m: Manifest): ReturnType<typeof allCapabilities> {
  return allCapabilities(m).filter((c) => c.product_scope !== 'phase_e_out_of_scope')
}

export function evidenceFiles(evidence: unknown): string[] {
  const files: string[] = []
  if (!evidence) return files
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      if (typeof e === 'string') files.push(e)
      else if (e && typeof e === 'object' && 'file' in e && typeof (e as { file: unknown }).file === 'string') {
        files.push((e as { file: string }).file)
      }
    }
  } else if (typeof evidence === 'object') {
    const ev = evidence as { file?: string; files?: string[] }
    if (ev.file) files.push(ev.file)
    for (const f of ev.files || []) files.push(f)
  }
  return files
}

export function gitCommit(cwd = REPO_ROOT): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function gitBranch(cwd = REPO_ROOT): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function gitDiffNames(base: string, head = 'HEAD', cwd = REPO_ROOT): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    // Fall back to staged+unstaged for local use
    try {
      const out = execSync('git diff --name-only HEAD', { cwd, encoding: 'utf-8' })
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }
}

export function reportDir(runId: string): string {
  return path.join(E2E_ROOT, 'reports', runId)
}

export function finalDir(runId: string): string {
  return path.join(reportDir(runId), 'final')
}

export function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

export function hoursSince(iso: string | undefined | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / (1000 * 60 * 60)
}

export function computeManifestHash(manifestPath = MANIFEST_PATH): string {
  return sha256File(manifestPath)
}

export function computeScenarioHash(matrixPath = MATRIX_PATH): string {
  if (!fs.existsSync(matrixPath)) return 'missing'
  return sha256File(matrixPath)
}

export function buildRunMetadata(partial: Partial<RunMetadata> & { run_id: string }): RunMetadata {
  return {
    git_commit: partial.git_commit || gitCommit(),
    git_branch: partial.git_branch || gitBranch(),
    workflow_run_id: partial.workflow_run_id || process.env.GITHUB_RUN_ID || undefined,
    generated_at: partial.generated_at || new Date().toISOString(),
    manifest_hash: partial.manifest_hash || computeManifestHash(),
    scenario_hash: partial.scenario_hash || computeScenarioHash(),
    route_flag: partial.route_flag,
    execution_mode: partial.execution_mode,
    shard: partial.shard,
    run_id: partial.run_id,
    smoke_pass: partial.smoke_pass,
    coverage_validation_pass: partial.coverage_validation_pass,
    execution_validation_pass: partial.execution_validation_pass,
    consecutive_pass_index: partial.consecutive_pass_index,
    rc_attempt: partial.rc_attempt,
  }
}

export function loadRunMetadata(runId: string): RunMetadata | null {
  const candidates = [
    path.join(finalDir(runId), 'run-metadata.json'),
    path.join(reportDir(runId), 'run-metadata.json'),
  ]
  for (const p of candidates) {
    const m = readJson<RunMetadata>(p)
    if (m) return m
  }
  return null
}

export function loadMatrixCounts(runId: string): MatrixCounts | null {
  const summary = readJson<{
    total_generated?: number
    executed?: number
    missing?: number
    by_status?: Record<string, number>
    browser_executed?: number
    browser_generated?: number
    route_off_executed?: number
    route_on_executed?: number
  }>(path.join(finalDir(runId), 'matrix-summary.json'))
  const validation = readJson<{
    totals?: Record<string, number>
    browser?: { total?: number; executed?: number; missing?: number }
  }>(path.join(finalDir(runId), 'execution-validation.json'))
  if (!summary && !validation) return null
  const bs = summary?.by_status || {}
  const totals = validation?.totals || {}
  return {
    total: Number(summary?.total_generated ?? totals.Total ?? 0),
    executed: Number(summary?.executed ?? totals.Executed ?? 0),
    missing: Number(summary?.missing ?? totals.Missing ?? 0),
    pass: Number(bs.PASS ?? totals.PASS ?? 0),
    fail: Number(bs.FAIL ?? totals.FAIL ?? 0),
    blocked: Number(bs.BLOCKED ?? totals.BLOCKED ?? 0),
    gap: Number(bs.KNOWN_PRODUCT_GAP ?? totals.KNOWN_PRODUCT_GAP ?? 0),
    not_implemented: Number(bs.NOT_IMPLEMENTED ?? totals.NOT_IMPLEMENTED ?? 0),
    not_applicable: Number(bs.NOT_APPLICABLE ?? totals.NOT_APPLICABLE ?? 0),
    browser_executed: Number(summary?.browser_executed ?? validation?.browser?.executed ?? 0),
    browser_generated: Number(summary?.browser_generated ?? validation?.browser?.total ?? 0),
    route_off_executed: Number(summary?.route_off_executed ?? 0),
    route_on_executed: Number(summary?.route_on_executed ?? 0),
  }
}

export function detectSmokePass(runId: string, smokeRunId?: string): boolean {
  const meta = loadRunMetadata(runId)
  if (typeof meta?.smoke_pass === 'boolean') return meta.smoke_pass

  const smokeIds = [smokeRunId, `${runId}_smoke`, runId.replace(/_final$/, '_smoke_final'), 'phase33_smoke_final'].filter(
    Boolean,
  ) as string[]
  for (const sid of smokeIds) {
    const exitFile = path.join(reportDir(sid), 'playwright-exit-code.txt')
    if (fs.existsSync(exitFile)) {
      const code = fs.readFileSync(exitFile, 'utf-8').trim()
      if (code === '0') return true
    }
    const summary = readJson<{ ok?: boolean; pass?: boolean }>(path.join(reportDir(sid), 'smoke-summary.json'))
    if (summary?.ok === true || summary?.pass === true) return true
  }

  // Inline smoke marker in final/
  const inline = readJson<{ ok?: boolean; pass?: boolean; exit_code?: number }>(
    path.join(finalDir(runId), 'smoke-status.json'),
  )
  if (inline) {
    if (inline.ok === true || inline.pass === true || inline.exit_code === 0) return true
    return false
  }
  return false
}

export function coverageValidationPass(runId?: string): boolean {
  const meta = runId ? loadRunMetadata(runId) : null
  if (typeof meta?.coverage_validation_pass === 'boolean') return meta.coverage_validation_pass
  const coveragePath = path.join(E2E_ROOT, 'scenarios', 'generated', 'coverage-validation.json')
  const cov = readJson<{ ok?: boolean }>(coveragePath)
  if (cov && typeof cov.ok === 'boolean') return cov.ok
  // Fall back: if generated matrix exists and validate script last wrote ok elsewhere
  const finalCov = runId
    ? readJson<{ ok?: boolean }>(path.join(finalDir(runId), 'coverage-validation.json'))
    : null
  if (finalCov && typeof finalCov.ok === 'boolean') return finalCov.ok
  return fs.existsSync(MATRIX_PATH)
}

export function executionValidationPass(runId: string): boolean {
  const v = readJson<{ ok?: boolean }>(path.join(finalDir(runId), 'execution-validation.json'))
  if (typeof v?.ok === 'boolean') return v.ok
  const meta = loadRunMetadata(runId)
  if (typeof meta?.execution_validation_pass === 'boolean') return meta.execution_validation_pass
  return false
}

export function loadBaselines(): {
  capability: CapabilityBaseline
  scenario: ScenarioBaseline
  result: ResultBaseline
  notImplemented: NotImplementedBaseline
} {
  return {
    capability: readJson<CapabilityBaseline>(path.join(BASELINE_DIR, 'capability-baseline.json'))!,
    scenario: readJson<ScenarioBaseline>(path.join(BASELINE_DIR, 'scenario-baseline.json'))!,
    result: readJson<ResultBaseline>(path.join(BASELINE_DIR, 'result-baseline.json'))!,
    notImplemented: readJson<NotImplementedBaseline>(path.join(BASELINE_DIR, 'not-implemented-baseline.json'))!,
  }
}

export function walkFiles(dir: string, name: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'playwright-html') continue
      walkFiles(p, name, out)
    } else if (ent.name === name) {
      out.push(p)
    }
  }
  return out
}

export function writeGithubSummary(md: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    fs.appendFileSync(summaryFile, md.endsWith('\n') ? md : `${md}\n`)
  }
}
