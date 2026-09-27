#!/usr/bin/env npx tsx
/**
 * Validate Cross-Product generation artifacts.
 * Does not auto-fix baselines.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NOT_IMPLEMENTED_SCENARIO_IDS } from './applicability-rules.js'
import type { GenerationSummary, NotApplicableCombination, ValidCombination } from './cross-product-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GEN = path.join(__dirname, 'generated')
const BASELINE = path.join(__dirname, 'baseline/cross-product-baseline.json')
const NI_BASELINE = path.resolve(__dirname, '../release-gate/baseline/not-implemented-baseline.json')

type ValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
  summary: GenerationSummary | null
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)
}

function hashIds(ids: string[]): string {
  const h = createHash('sha256')
  for (const id of [...ids].sort()) h.update(`${id}\n`)
  return h.digest('hex')
}

export function validateCrossProduct(): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const summaryPath = path.join(GEN, 'generation-summary.json')
  const validPath = path.join(GEN, 'valid-combinations.jsonl')
  const naPath = path.join(GEN, 'not-applicable.jsonl')
  const niPath = path.join(GEN, 'not-implemented.json')

  if (!fs.existsSync(summaryPath)) {
    return { ok: false, errors: ['missing generation-summary.json — run generate-cross-product'], warnings, summary: null }
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as GenerationSummary
  const valid = readJsonl<ValidCombination>(validPath)
  const na = readJsonl<NotApplicableCombination>(naPath)

  if (valid.length !== summary.valid_combinations) {
    errors.push(`valid count mismatch file=${valid.length} summary=${summary.valid_combinations}`)
  }
  if (na.length !== summary.not_applicable_combinations) {
    errors.push(`NA count mismatch file=${na.length} summary=${summary.not_applicable_combinations}`)
  }

  const niCombPath = path.join(GEN, 'not-implemented-combinations.jsonl')
  const niComb = readJsonl<{ combination_id: string }>(niCombPath)
  const expectedNiComb = summary.not_implemented_combinations ?? 0
  if (niComb.length !== expectedNiComb) {
    errors.push(
      `NOT_IMPLEMENTED combination count mismatch file=${niComb.length} summary=${expectedNiComb}`,
    )
  }

  const equationOk =
    summary.candidate_combinations ===
    summary.valid_combinations + summary.not_applicable_combinations + expectedNiComb
  if (!equationOk) {
    errors.push(
      `classification equation failed: candidates(${summary.candidate_combinations}) != valid(${summary.valid_combinations}) + NA(${summary.not_applicable_combinations}) + NI(${expectedNiComb})`,
    )
  }
  if (summary.classification_equation_ok === false) {
    errors.push('summary.classification_equation_ok is false')
  }

  const ids = new Set<string>()
  const naIds = new Set<string>()
  const niIds = new Set<string>()
  for (const row of valid) {
    if (ids.has(row.combination_id)) errors.push(`duplicate valid combination_id ${row.combination_id}`)
    ids.add(row.combination_id)
    if (!row.axes || !row.capability_ids?.length) {
      errors.push(`valid row missing axes/capabilities: ${row.combination_id}`)
    }
  }

  let unjustified = 0
  for (const row of na) {
    if (naIds.has(row.combination_id)) {
      errors.push(`duplicate NOT_APPLICABLE combination_id ${row.combination_id}`)
    }
    naIds.add(row.combination_id)
    if (ids.has(row.combination_id)) {
      errors.push(`combination_id in both VALID and NOT_APPLICABLE: ${row.combination_id}`)
    }
    if (!row.rule_id || !row.reason || !row.evidence) {
      unjustified += 1
      errors.push(`unjustified NOT_APPLICABLE: ${row.combination_id}`)
    }
  }
  for (const row of niComb) {
    if (niIds.has(row.combination_id)) {
      errors.push(`duplicate NOT_IMPLEMENTED combination_id ${row.combination_id}`)
    }
    niIds.add(row.combination_id)
    if (ids.has(row.combination_id) || naIds.has(row.combination_id)) {
      errors.push(`combination_id overlaps NI with VALID/NA: ${row.combination_id}`)
    }
  }

  const classifiedUnique = ids.size + naIds.size + niIds.size
  if (classifiedUnique !== summary.candidate_combinations) {
    errors.push(
      `unique classified (${classifiedUnique}) != candidate_combinations (${summary.candidate_combinations})`,
    )
  }

  const niFile = JSON.parse(fs.readFileSync(niPath, 'utf-8')) as { scenario_ids: string[]; count: number }
  const niBaseline = JSON.parse(fs.readFileSync(NI_BASELINE, 'utf-8')) as { scenario_ids: string[] }
  if (niFile.count !== NOT_IMPLEMENTED_SCENARIO_IDS.length || niFile.scenario_ids.length !== NOT_IMPLEMENTED_SCENARIO_IDS.length) {
    errors.push(
      `NOT_IMPLEMENTED count must be ${NOT_IMPLEMENTED_SCENARIO_IDS.length}, got ${niFile.count}`,
    )
  }
  const expectedNi = [...NOT_IMPLEMENTED_SCENARIO_IDS].sort().join('\n')
  const actualNi = [...niFile.scenario_ids].sort().join('\n')
  const baselineNi = [...niBaseline.scenario_ids].sort().join('\n')
  if (actualNi !== expectedNi || actualNi !== baselineNi) {
    errors.push('NOT_IMPLEMENTED scenario ID set changed (forbidden)')
  }

  const recomputedHash = hashIds([...ids])
  if (recomputedHash !== summary.combination_id_set_hash) {
    // summary hashes in insertion order; recompute insertion order from file
    const h = createHash('sha256')
    for (const row of valid) h.update(`${row.combination_id}\n`)
    const fileOrderHash = h.digest('hex')
    if (fileOrderHash !== summary.combination_id_set_hash) {
      errors.push('combination_id_set_hash mismatch vs valid-combinations.jsonl')
    }
  }

  // Axis value sanity: no MySQL/MariaDB, no AI_PROXY, no AI_PROVIDER_POST
  for (const row of valid) {
    const s = String(row.axes.source_type)
    const d = String(row.axes.destination_type)
    if (/mysql|mariadb/i.test(s)) errors.push(`lab-only source in product: ${s}`)
    if (s === 'AI_PROXY_RECEIVER') errors.push('AI_PROXY_RECEIVER must not be in valid set')
    if (d === 'AI_PROVIDER_POST') errors.push('AI_PROVIDER_POST must not be in valid set')
    if (row.axes.route_runtime === 'ROUTE_OFF') errors.push('ROUTE_OFF must not be a supported combination')
  }
  if (summary.route_off_combinations !== 0) {
    errors.push(`route_off_combinations must be 0, got ${summary.route_off_combinations}`)
  }

  if (fs.existsSync(BASELINE)) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) as {
      valid_combinations: number
      not_applicable_combinations: number
      candidate_combinations?: number
      not_implemented_combinations?: number
      combination_id_set_hash: string
      not_implemented_scenario_ids: string[]
      browser_combinations: number
      api_combinations: number
      route_off_combinations: number
      route_on_combinations: number
    }
    const diffs: string[] = []
    if (baseline.valid_combinations !== summary.valid_combinations) {
      diffs.push(`valid ${baseline.valid_combinations} → ${summary.valid_combinations}`)
    }
    if (baseline.not_applicable_combinations !== summary.not_applicable_combinations) {
      diffs.push(`na ${baseline.not_applicable_combinations} → ${summary.not_applicable_combinations}`)
    }
    if (
      baseline.candidate_combinations != null &&
      baseline.candidate_combinations !== summary.candidate_combinations
    ) {
      diffs.push(`candidates ${baseline.candidate_combinations} → ${summary.candidate_combinations}`)
    }
    if (baseline.combination_id_set_hash !== summary.combination_id_set_hash) {
      diffs.push(`combination_id_set_hash changed`)
    }
    if (baseline.browser_combinations !== summary.browser_combinations) {
      diffs.push(`browser ${baseline.browser_combinations} → ${summary.browser_combinations}`)
    }
    if (baseline.api_combinations !== summary.api_combinations) {
      diffs.push(`api ${baseline.api_combinations} → ${summary.api_combinations}`)
    }
    if (baseline.route_off_combinations !== 0 || summary.route_off_combinations !== 0) {
      diffs.push(`route_off ${baseline.route_off_combinations} → ${summary.route_off_combinations}`)
    }
    if (baseline.route_on_combinations !== summary.route_on_combinations) {
      diffs.push(`route_on ${baseline.route_on_combinations} → ${summary.route_on_combinations}`)
    }
    if (diffs.length) {
      const candidatePath = path.join(GEN, 'baseline-candidate-diff.json')
      fs.writeFileSync(
        candidatePath,
        `${JSON.stringify({ baseline, current: summary, diffs, unjustified_not_applicable: unjustified }, null, 2)}\n`,
      )
      // Reviewed reclassification (R019 split / unique candidate accounting) requires intentional baseline update.
      errors.push(`Cross-Product baseline mismatch (candidate diff: ${candidatePath}): ${diffs.join('; ')}`)
    }
  } else {
    warnings.push('cross-product-baseline.json missing — create after first reviewed generation')
  }

  const result: ValidationResult = { ok: errors.length === 0, errors, warnings, summary }
  fs.writeFileSync(path.join(GEN, 'validation-result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings }, null, 2))
  if (!result.ok) process.exitCode = 1
  return result
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith('validate-cross-product.ts'))
if (isMain) validateCrossProduct()
