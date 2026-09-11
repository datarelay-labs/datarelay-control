/**
 * Unit tests for Continuous E2E profile + lifecycle + tick (dry-run).
 * No platform / Docker required.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTINUOUS_OWNERSHIP,
  CONTINUOUS_NAME_PREFIX,
  refuseEphemeralCleanupOfContinuous,
  ownershipForLifecycle,
} from './lifecycle.js'
import {
  buildHealthReport,
  emptyState,
  loadProfile,
  saveState,
  tick,
  validateProfileOnly,
  STATE_DIR,
} from './scenario-controller.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function testLifecycle(): void {
  assert.equal(ownershipForLifecycle('continuous'), CONTINUOUS_OWNERSHIP)
  assert.equal(ownershipForLifecycle('ephemeral'), 'full-e2e-lab')
  assert.equal(refuseEphemeralCleanupOfContinuous(CONTINUOUS_OWNERSHIP), true)
  assert.equal(refuseEphemeralCleanupOfContinuous('full-e2e-lab'), false)
}

function testProfile(): void {
  const v = validateProfileOnly()
  assert.equal(v.ok, true)
  assert.ok(v.streamCount >= 8 && v.streamCount <= 15)
  assert.equal(v.ownership, CONTINUOUS_OWNERSHIP)
  const profile = loadProfile()
  assert.equal(profile.metadata.name_prefix, CONTINUOUS_NAME_PREFIX)
  assert.ok(Object.keys(profile.state_machines).length >= 4)
}

function testTickDryRun(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const profile = loadProfile()
  saveState(emptyState(profile))
  const before = buildHealthReport()
  const afterState = tick({ force: true, dryRun: true })
  assert.equal(afterState.ownership, CONTINUOUS_OWNERSHIP)
  const after = buildHealthReport(profile, afterState)
  assert.equal(after.streamCount, before.streamCount)
  // Forced tick should advance at least one machine-backed stream phase name for latency stream
  assert.ok(after.currentPhases['latency-recovering-http'])
}

function testRetentionPresent(): void {
  const p = path.join(__dirname, 'retention.yaml')
  assert.ok(fs.existsSync(p))
  const text = fs.readFileSync(p, 'utf8')
  assert.match(text, /continuous-e2e-lab/)
  assert.match(text, /max_eps_each/)
}

function main(): void {
  testLifecycle()
  testProfile()
  testTickDryRun()
  testRetentionPresent()
  console.log(JSON.stringify({ ok: true, tests: ['lifecycle', 'profile', 'tick-dry-run', 'retention'] }, null, 2))
}

main()
