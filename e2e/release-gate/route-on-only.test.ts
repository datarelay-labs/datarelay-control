#!/usr/bin/env npx tsx
/**
 * Durable regression: release/E2E model is Route Processing ON only.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'
import { runGeneratorMutationSuite } from '../suite-validation/generator-gates/evaluate-generator-gates.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const config = yaml.parse(
  fs.readFileSync(path.join(__dirname, 'release-gate-config.yaml'), 'utf-8'),
) as {
  route_processing: { require_off: boolean; require_on: boolean }
  full_matrix: { expected_scenarios: number }
  browser: { expected_scenarios: number }
  not_implemented: { expected: number }
}

assert.equal(config.route_processing.require_off, false)
assert.equal(config.route_processing.require_on, true)

const matrix = JSON.parse(
  fs.readFileSync(path.join(root, 'scenarios/generated/full-matrix.json'), 'utf-8'),
) as {
  counts: { total: number; browser: number; route_off: number; route_on: number; by_expected_status: Record<string, number> }
  scenarios: { id: string; routeProcessing: string }[]
}

assert.equal(matrix.counts.route_off, 0)
assert.equal(matrix.counts.route_on, matrix.counts.total)
assert.equal(matrix.counts.total, config.full_matrix.expected_scenarios)
assert.equal(matrix.counts.browser, config.browser.expected_scenarios)
assert.equal(
  matrix.counts.by_expected_status.NOT_IMPLEMENTED ?? 0,
  config.not_implemented.expected,
)
assert.equal(
  matrix.scenarios.filter((s) => s.routeProcessing === 'off' || s.id.includes('__route-off')).length,
  0,
)

const axes = yaml.parse(
  fs.readFileSync(path.join(root, 'cross-product/cross-product-axes.yaml'), 'utf-8'),
) as { axes: { route_runtime: { values: string[] } } }
assert.deepEqual(axes.axes.route_runtime.values, ['ROUTE_ON'])

const golden = JSON.parse(
  fs.readFileSync(path.join(root, 'suite-validation/golden/golden-scenarios.json'), 'utf-8'),
) as { scenarios: { golden_id: string; route_mode: string; purpose: string }[] }
assert.equal(
  golden.scenarios.filter((s) => s.golden_id === 'G-ROUTE-OFF' || s.route_mode === 'route-off').length,
  0,
)
assert.ok(golden.scenarios.some((s) => s.golden_id === 'G-ROUTE-ON' && s.route_mode === 'route-on'))

const mutations = runGeneratorMutationSuite()
assert.equal(mutations.status, 'PASS')

console.log('route-on-only release/E2E model: PASS')
