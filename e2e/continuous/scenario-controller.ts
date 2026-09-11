/**
 * Continuous E2E scenario controller — profile load, state ticks, fault apply/clear.
 * Does not create a competing cleanup subsystem; continuous ownership is separate.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { execFileSync } from 'node:child_process'
import { CONTINUOUS_OWNERSHIP, CONTINUOUS_NAME_PREFIX } from './lifecycle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const CONTINUOUS_ROOT = __dirname
export const PROFILE_PATH = path.join(CONTINUOUS_ROOT, 'profile.yaml')
export const STATE_DIR = path.join(CONTINUOUS_ROOT, 'state')
export const STATE_PATH = path.join(STATE_DIR, 'controller-state.json')

const LAB_FAULT = path.resolve(__dirname, '..', 'lab', 'fault-inject.sh')
const TOXI_FAULT = path.resolve(__dirname, '..', 'lab', 'fault-toxiproxy.sh')

export type FaultSpec =
  | { kind: 'lab'; target: string }
  | { kind: 'toxiproxy'; toxic: 'latency' | 'timeout' | 'reset' | 'bandwidth'; latency_ms?: number; jitter_ms?: number; timeout_ms?: number; rate_kb?: number; target?: string }
  | { kind: 'wiremock_stub'; stub: string }
  | null

export type Phase = {
  name: string
  duration_sec: number
  fault?: FaultSpec
}

export type StreamProfile = {
  id: string
  label: string
  intended_state: string
  source: string
  destination: string
  auth: string
  path?: string
  eps: number
  state_machine?: string
  toxiproxy_target?: string
}

export type ContinuousProfile = {
  metadata: {
    id: string
    ownership: string
    name_prefix: string
    purpose: string
  }
  resource_limits: Record<string, number | string>
  streams: StreamProfile[]
  state_machines: Record<string, { phases: Phase[] }>
}

export type StreamRuntimeState = {
  streamId: string
  machine?: string
  phaseIndex: number
  phaseStartedAt: string
  lastFault?: FaultSpec
  lastTickAt?: string
  lastError?: string
}

export type ControllerState = {
  ownership: typeof CONTINUOUS_OWNERSHIP
  profileId: string
  updatedAt: string
  streams: Record<string, StreamRuntimeState>
  activeFaults: string[]
}

export function loadProfile(profilePath = PROFILE_PATH): ContinuousProfile {
  const raw = fs.readFileSync(profilePath, 'utf8')
  const doc = parseYaml(raw) as ContinuousProfile
  if (!doc?.streams?.length) throw new Error('continuous profile missing streams')
  if (doc.metadata?.ownership !== CONTINUOUS_OWNERSHIP) {
    throw new Error(`expected ownership ${CONTINUOUS_OWNERSHIP}, got ${doc.metadata?.ownership}`)
  }
  if (doc.metadata?.name_prefix !== CONTINUOUS_NAME_PREFIX) {
    throw new Error(`expected name_prefix ${CONTINUOUS_NAME_PREFIX}`)
  }
  const n = doc.streams.length
  const min = Number(doc.resource_limits?.target_stream_count_min ?? 8)
  const max = Number(doc.resource_limits?.target_stream_count_max ?? 15)
  if (n < min || n > max) {
    throw new Error(`stream count ${n} outside [${min}, ${max}]`)
  }
  for (const s of doc.streams) {
    if (s.eps > Number(doc.resource_limits?.max_eps_per_stream ?? 1)) {
      throw new Error(`stream ${s.id} eps ${s.eps} exceeds max`)
    }
  }
  return doc
}

export function emptyState(profile: ContinuousProfile): ControllerState {
  const streams: Record<string, StreamRuntimeState> = {}
  const now = new Date().toISOString()
  for (const s of profile.streams) {
    streams[s.id] = {
      streamId: s.id,
      machine: s.state_machine,
      phaseIndex: 0,
      phaseStartedAt: now,
    }
  }
  return {
    ownership: CONTINUOUS_OWNERSHIP,
    profileId: profile.metadata.id,
    updatedAt: now,
    streams,
    activeFaults: [],
  }
}

export function loadState(): ControllerState | null {
  if (!fs.existsSync(STATE_PATH)) return null
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as ControllerState
}

export function saveState(state: ControllerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  state.updatedAt = new Date().toISOString()
  const tmp = `${STATE_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, STATE_PATH)
}

function runScript(script: string, args: string[], optional = false): string {
  if (!fs.existsSync(script)) {
    if (optional) return `SKIP missing ${path.basename(script)}`
    throw new Error(`missing script ${script}`)
  }
  try {
    return execFileSync(script, args, { encoding: 'utf8', env: process.env, timeout: 60_000 })
  } catch (err) {
    if (optional) return `SKIP ${(err as Error).message}`
    throw err
  }
}

export function applyFault(fault: FaultSpec | undefined): string {
  if (!fault) return 'no-op'
  if (fault.kind === 'lab') {
    return runScript(LAB_FAULT, ['start', fault.target])
  }
  if (fault.kind === 'toxiproxy') {
    const target = fault.target || 'wiremock'
    if (fault.toxic === 'latency') {
      return runScript(
        TOXI_FAULT,
        ['start', 'latency', target, String(fault.latency_ms ?? 2000), String(fault.jitter_ms ?? 0)],
        true,
      )
    }
    if (fault.toxic === 'timeout') {
      return runScript(TOXI_FAULT, ['start', 'timeout', target, String(fault.timeout_ms ?? 1)], true)
    }
    if (fault.toxic === 'reset') {
      return runScript(TOXI_FAULT, ['start', 'reset', target], true)
    }
    if (fault.toxic === 'bandwidth') {
      return runScript(TOXI_FAULT, ['start', 'bandwidth', target, String(fault.rate_kb ?? 10)], true)
    }
  }
  if (fault.kind === 'wiremock_stub') {
    // Stub files are preloaded; marking active is enough for report/tick bookkeeping.
    return `wiremock_stub:${fault.stub}`
  }
  return 'unknown-fault'
}

export function clearFault(fault: FaultSpec | undefined): string {
  if (!fault) return 'no-op'
  if (fault.kind === 'lab') {
    return runScript(LAB_FAULT, ['stop', fault.target], true)
  }
  if (fault.kind === 'toxiproxy') {
    return runScript(TOXI_FAULT, ['stop', fault.target || 'wiremock'], true)
  }
  return 'cleared'
}

export function validateProfileOnly(profilePath = PROFILE_PATH): {
  ok: true
  streamCount: number
  machines: string[]
  ownership: string
} {
  const profile = loadProfile(profilePath)
  return {
    ok: true,
    streamCount: profile.streams.length,
    machines: Object.keys(profile.state_machines || {}),
    ownership: profile.metadata.ownership,
  }
}

/**
 * Advance streams whose phase duration elapsed. Force=true advances all machines by one phase.
 */
export function tick(opts: { force?: boolean; dryRun?: boolean } = {}): ControllerState {
  const profile = loadProfile()
  const state = loadState() ?? emptyState(profile)
  const now = Date.now()
  const active = new Set(state.activeFaults)

  for (const stream of profile.streams) {
    if (!stream.state_machine) continue
    const machine = profile.state_machines[stream.state_machine]
    if (!machine?.phases?.length) continue
    const rt = state.streams[stream.id] ?? {
      streamId: stream.id,
      machine: stream.state_machine,
      phaseIndex: 0,
      phaseStartedAt: new Date().toISOString(),
    }
    const phase = machine.phases[rt.phaseIndex % machine.phases.length]
    const started = Date.parse(rt.phaseStartedAt)
    const elapsedSec = (now - started) / 1000
    const shouldAdvance = opts.force || elapsedSec >= phase.duration_sec
    if (!shouldAdvance) {
      state.streams[stream.id] = rt
      continue
    }

    // Leave current phase fault
    if (!opts.dryRun) clearFault(rt.lastFault)
    if (rt.lastFault?.kind === 'lab') active.delete(`lab:${rt.lastFault.target}`)
    if (rt.lastFault?.kind === 'toxiproxy') active.delete(`toxi:${rt.lastFault.toxic}`)

    const nextIndex = (rt.phaseIndex + 1) % machine.phases.length
    const nextPhase = machine.phases[nextIndex]
    let lastError: string | undefined
    if (!opts.dryRun) {
      try {
        applyFault(nextPhase.fault)
        if (nextPhase.fault?.kind === 'lab') active.add(`lab:${nextPhase.fault.target}`)
        if (nextPhase.fault?.kind === 'toxiproxy') active.add(`toxi:${nextPhase.fault.toxic}`)
      } catch (err) {
        lastError = String(err)
      }
    }

    state.streams[stream.id] = {
      streamId: stream.id,
      machine: stream.state_machine,
      phaseIndex: nextIndex,
      phaseStartedAt: new Date().toISOString(),
      lastFault: nextPhase.fault ?? null,
      lastTickAt: new Date().toISOString(),
      lastError,
    }
  }

  state.activeFaults = [...active]
  if (!opts.dryRun) saveState(state)
  return state
}

export function buildHealthReport(profile = loadProfile(), state = loadState() ?? emptyState(profile)) {
  const phases: Record<string, string> = {}
  for (const s of profile.streams) {
    const rt = state.streams[s.id]
    if (!s.state_machine || !rt) {
      phases[s.id] = s.intended_state
      continue
    }
    const machine = profile.state_machines[s.state_machine]
    const phase = machine?.phases[rt.phaseIndex % (machine?.phases.length || 1)]
    phases[s.id] = phase?.name ?? s.intended_state
  }
  return {
    ownership: CONTINUOUS_OWNERSHIP,
    profileId: profile.metadata.id,
    streamCount: profile.streams.length,
    intendedStates: Object.fromEntries(profile.streams.map((s) => [s.id, s.intended_state])),
    currentPhases: phases,
    activeFaults: state.activeFaults,
    updatedAt: state.updatedAt,
    resourceLimits: profile.resource_limits,
  }
}
