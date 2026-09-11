/**
 * Continuous E2E CLI entrypoints.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildHealthReport,
  emptyState,
  loadProfile,
  loadState,
  saveState,
  tick,
  validateProfileOnly,
  STATE_PATH,
  CONTINUOUS_ROOT,
} from './scenario-controller.js'
import { CONTINUOUS_OWNERSHIP, CONTINUOUS_NAME_PREFIX } from './lifecycle.js'
import { liveEnsureAll, liveTeardownContinuous, writeEnsureLiveReport } from './live-ensure.js'

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

async function ensureDryPlan(): Promise<object> {
  const profile = loadProfile()
  const plan = profile.streams.map((s) => ({
    id: s.id,
    name: `${CONTINUOUS_NAME_PREFIX} ${s.label}`,
    source: s.source,
    destination: s.destination,
    auth: s.auth,
    path: s.path ?? null,
    eps: s.eps,
    state_machine: s.state_machine ?? null,
    ownership: CONTINUOUS_OWNERSHIP,
    action: 'ensure_if_missing',
  }))
  return {
    ok: true,
    mode: 'ensure-plan',
    note:
      'API ensure requires a running lab. Live create is opt-in via GDC_CONTINUOUS_LIVE_ENSURE=1.',
    live: process.env.GDC_CONTINUOUS_LIVE_ENSURE === '1',
    plan,
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (!cmd) {
    console.error('Usage: validate|tick|report|ensure|teardown|reset [--force] [--dry-run]')
    process.exit(2)
  }

  if (cmd === 'validate') {
    const result = validateProfileOnly()
    const retentionPath = path.join(CONTINUOUS_ROOT, 'retention.yaml')
    if (!fs.existsSync(retentionPath)) throw new Error('missing retention.yaml')
    console.log(JSON.stringify({ ...result, retention: true }, null, 2))
    return
  }

  if (cmd === 'tick') {
    const state = tick({ force: hasFlag('--force'), dryRun: hasFlag('--dry-run') })
    console.log(JSON.stringify({ ok: true, updatedAt: state.updatedAt, activeFaults: state.activeFaults, streams: state.streams }, null, 2))
    return
  }

  if (cmd === 'report') {
    const report = buildHealthReport()
    const outDir = path.join(CONTINUOUS_ROOT, 'state')
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, 'health-report.json')
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, reportPath: out, report }, null, 2))
    return
  }

  if (cmd === 'ensure') {
    const profile = loadProfile()
    if (!loadState()) saveState(emptyState(profile))
    const plan = await ensureDryPlan()
    const out = path.join(CONTINUOUS_ROOT, 'state', 'ensure-plan.json')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n')

    if (process.env.GDC_CONTINUOUS_LIVE_ENSURE === '1') {
      const live = await liveEnsureAll({ includeRealApps: !hasFlag('--skip-real-apps') })
      const livePath = writeEnsureLiveReport(live, CONTINUOUS_ROOT)
      console.log(JSON.stringify({ ...plan, live, liveReportPath: livePath }, null, 2))
      if (!live.ok) process.exitCode = 1
      return
    }

    console.log(JSON.stringify(plan, null, 2))
    return
  }

  if (cmd === 'reset') {
    // Safe continuous reset: clear controller fault state + toxiproxy/lab faults; keep platform resources.
    const profile = loadProfile()
    const state = emptyState(profile)
    saveState(state)
    try {
      tick({ force: false, dryRun: false })
    } catch {
      /* ignore */
    }
    const { clearFault } = await import('./scenario-controller.js')
    clearFault({ kind: 'toxiproxy', toxic: 'latency', target: 'wiremock' })
    console.log(
      JSON.stringify(
        {
          ok: true,
          ownership: CONTINUOUS_OWNERSHIP,
          note: 'Controller state reset; platform continuous resources retained. Use teardown for full continuous delete.',
        },
        null,
        2,
      ),
    )
    return
  }

  if (cmd === 'teardown') {
    // Continuous teardown is explicit only. Ephemeral Full E2E cleanup never reaches here.
    const state = loadState()
    if (state && state.ownership !== CONTINUOUS_OWNERSHIP) {
      throw new Error(`refuse teardown: ownership ${state.ownership}`)
    }
    let live: unknown = null
    if (process.env.GDC_CONTINUOUS_LIVE_ENSURE === '1' || hasFlag('--live')) {
      live = await liveTeardownContinuous()
    }
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH)
    for (const f of ['health-report.json', 'ensure-plan.json', 'live-ensure-report.json', 'live-validation-report.json']) {
      const p = path.join(CONTINUOUS_ROOT, 'state', f)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          toreDownState: true,
          live,
          note: live
            ? 'Continuous-owned platform resources deleted by name prefix.'
            : 'State cleared. Pass --live or GDC_CONTINUOUS_LIVE_ENSURE=1 to delete platform continuous resources.',
        },
        null,
        2,
      ),
    )
    return
  }

  console.error(`Unknown command: ${cmd}`)
  process.exit(2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
