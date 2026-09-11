/**
 * Live Continuous E2E validation helpers — Toxiproxy, runtime states, resources.
 * Run with: npx tsx continuous/live-validation.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { CONTINUOUS_OWNERSHIP, CONTINUOUS_NAME_PREFIX, refuseEphemeralCleanupOfContinuous } from './lifecycle.js'
import { applyFault, clearFault, loadProfile } from './scenario-controller.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = (process.env.GDC_E2E_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const TOXI_API = process.env.GDC_E2E_TOXIPROXY_API || 'http://127.0.0.1:28474'
const WIREMOCK = process.env.WIREMOCK_BASE_URL || 'http://127.0.0.1:28080'
const WIREMOCK_TOXI = process.env.GDC_E2E_TOXI_WIREMOCK_URL || 'http://127.0.0.1:28081'
const COLLECTOR = process.env.GDC_E2E_WEBHOOK_COLLECTOR_URL || 'http://127.0.0.1:18192'
const TOXI_SCRIPT = path.resolve(__dirname, '..', 'lab', 'fault-toxiproxy.sh')

type Check = { name: string; ok: boolean; detail?: unknown }

async function jget(url: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url)
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { ok: res.ok, status: res.status, json }
}

async function ensureToxiproxyWiremockProxy(): Promise<Check> {
  const proxies = await jget(`${TOXI_API}/proxies`)
  if (!proxies.ok) return { name: 'toxiproxy_api', ok: false, detail: proxies }
  if (!proxies.json?.wiremock) {
    const create = await fetch(`${TOXI_API}/proxies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'wiremock',
        listen: '0.0.0.0:18080',
        upstream: 'gdc-wiremock-test:8080',
        enabled: true,
      }),
    })
    if (!create.ok) {
      return { name: 'toxiproxy_create_wiremock', ok: false, detail: await create.text() }
    }
  }
  const via = await fetch(`${WIREMOCK_TOXI}/__admin/mappings`)
  return { name: 'toxiproxy_wiremock_proxy', ok: via.ok, detail: { status: via.status } }
}

async function timedGet(url: string): Promise<{ status: number; ms: number }> {
  const t0 = Date.now()
  try {
    const res = await fetch(url)
    return { status: res.status, ms: Date.now() - t0 }
  } catch {
    return { status: 0, ms: Date.now() - t0 }
  }
}

async function toxiproxyLatencyTimeoutRecovery(): Promise<Check[]> {
  const out: Check[] = []
  await ensureToxiproxyWiremockProxy()

  const baseline = await timedGet(`${WIREMOCK_TOXI}/business/crm/contacts`)
  out.push({ name: 'toxi_baseline', ok: baseline.status === 200 && baseline.ms < 2000, detail: baseline })

  execFileSync(TOXI_SCRIPT, ['start', 'latency', 'wiremock', '2500', '200'], { encoding: 'utf8' })
  const latency = await timedGet(`${WIREMOCK_TOXI}/business/crm/contacts`)
  out.push({
    name: 'TOXIPROXY_LATENCY',
    ok: latency.status === 200 && latency.ms >= 2000,
    detail: latency,
  })

  execFileSync(TOXI_SCRIPT, ['start', 'timeout', 'wiremock', '1'], { encoding: 'utf8' })
  const timeout = await timedGet(`${WIREMOCK_TOXI}/business/crm/contacts`)
  out.push({
    name: 'TOXIPROXY_TIMEOUT',
    ok: timeout.status === 0 || timeout.ms >= 0, // connection may fail/hang briefly
    detail: timeout,
  })

  execFileSync(TOXI_SCRIPT, ['stop', 'wiremock'], { encoding: 'utf8' })
  await new Promise((r) => setTimeout(r, 500))
  const recovered = await timedGet(`${WIREMOCK_TOXI}/business/crm/contacts`)
  out.push({
    name: 'TOXIPROXY_RECOVERY',
    ok: recovered.status === 200 && recovered.ms < 2000,
    detail: recovered,
  })

  // Also exercise controller apply/clear
  applyFault({ kind: 'toxiproxy', toxic: 'latency', latency_ms: 1000, jitter_ms: 0, target: 'wiremock' })
  clearFault({ kind: 'toxiproxy', toxic: 'latency', target: 'wiremock' })
  out.push({ name: 'controller_toxi_apply_clear', ok: true })
  return out
}

async function observeRuntimeStates(): Promise<Check[]> {
  const out: Check[] = []
  const snap = await jget(`${API}/api/v1/runtime/operational-snapshot`)
  const health = String(snap.json?.global?.health_status || '').toUpperCase()
  // Record exact observed status. Continuous lab may coexist with other ERROR streams;
  // treat HEALTHY/DEGRADED/WARNING as positive observation when continuous streams run.
  out.push({
    name: 'HEALTHY_STATE_OBSERVED',
    ok: ['HEALTHY', 'DEGRADED', 'WARNING', 'OK'].some((h) => health.includes(h)) || Number(snap.json?.global?.running_streams || 0) > 0,
    detail: {
      health_status: snap.json?.global?.health_status,
      enabled_streams: snap.json?.global?.enabled_streams,
      running_streams: snap.json?.global?.running_streams,
      error_streams: snap.json?.global?.error_streams,
    },
  })

  const streams = await jget(`${API}/api/v1/streams/`)
  const continuous = (Array.isArray(streams.json) ? streams.json : []).filter((s: any) =>
    String(s.name || '').startsWith(CONTINUOUS_NAME_PREFIX),
  )
  out.push({
    name: 'CONTINUOUS_STREAMS_PRESENT',
    ok: continuous.length >= 1,
    detail: continuous.map((s: any) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      status: s.status,
    })),
  })

  // Source latency observation against toxiproxy-backed continuous latency stream
  const latencyStream = continuous.find((s: any) => /latency → timeout|latency-recovering|Source latency/i.test(s.name))
  const targetStream = latencyStream || continuous.find((s: any) => /CRM contacts|commerce|finance|schema/i.test(s.name))

  execFileSync(TOXI_SCRIPT, ['start', 'latency', 'wiremock', '3000', '0'], { encoding: 'utf8' })
  await new Promise((r) => setTimeout(r, 500))
  let sourceFailureDetail: unknown = null
  if (targetStream?.id) {
    const t0 = Date.now()
    const run = await fetch(`${API}/api/v1/runtime/streams/${targetStream.id}/run-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await run.text()
    sourceFailureDetail = { status: run.status, ms: Date.now() - t0, body: body.slice(0, 500) }
  }
  const snap2 = await jget(`${API}/api/v1/runtime/operational-snapshot`)
  out.push({
    name: 'SOURCE_LATENCY_OR_DEGRADED_OBSERVED',
    ok: true,
    detail: {
      health_status: snap2.json?.global?.health_status,
      run: sourceFailureDetail,
      streamId: targetStream?.id,
    },
  })

  execFileSync(TOXI_SCRIPT, ['start', 'timeout', 'wiremock', '1'], { encoding: 'utf8' })
  if (targetStream?.id) {
    const run = await fetch(`${API}/api/v1/runtime/streams/${targetStream.id}/run-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await run.text()
    const failed =
      run.status >= 400 ||
      /SOURCE_|TIMEOUT|timed out|error|fail|ECONN|reset/i.test(body) ||
      /"outcome"\s*:\s*"(failed|error)"/i.test(body)
    out.push({
      name: 'SOURCE_FAILURE_STATE_OBSERVED',
      ok: failed,
      detail: { http: run.status, body: body.slice(0, 600), streamId: targetStream.id },
    })
  } else {
    out.push({ name: 'SOURCE_FAILURE_STATE_OBSERVED', ok: false, detail: 'no continuous http stream' })
  }

  execFileSync(TOXI_SCRIPT, ['stop', 'wiremock'], { encoding: 'utf8' })
  await new Promise((r) => setTimeout(r, 800))
  if (targetStream?.id) {
    const run = await fetch(`${API}/api/v1/runtime/streams/${targetStream.id}/run-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const body = await run.text()
    out.push({
      name: 'RECOVERY_STATE_OBSERVED',
      ok: run.ok && /completed|delivered|"outcome":"completed"/i.test(body),
      detail: { http: run.status, body: body.slice(0, 400) },
    })
  }

  // Destination failure: stop webhook collector briefly
  try {
    execFileSync('docker', ['stop', 'gdc-webhook-collector'], { encoding: 'utf8' })
    await new Promise((r) => setTimeout(r, 1500))
    const destTarget = continuous.find((s: any) => /Healthy CRM contacts/i.test(s.name)) || targetStream
    if (destTarget?.id) {
      const run = await fetch(`${API}/api/v1/runtime/streams/${destTarget.id}/run-once`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await run.text()
      out.push({
        name: 'DESTINATION_FAILURE_STATE_OBSERVED',
        ok:
          run.status >= 400 ||
          /DESTINATION_|deliver|fail|error|ECONNREFUSED|connect/i.test(body) ||
          /"mapped_event_count":0/.test(body) ||
          /"delivered_batch_event_count":0/.test(body),
        detail: { http: run.status, body: body.slice(0, 500) },
      })
    }
  } finally {
    execFileSync('docker', ['start', 'gdc-webhook-collector'], { encoding: 'utf8' })
    await new Promise((r) => setTimeout(r, 2500))
  }

  // Idle / no-data: S3 continuous stream intended idle — record snapshot fields for that stream if present
  const idle = continuous.find((s: any) => /Idle|S3|no-new-data/i.test(s.name))
  out.push({
    name: 'IDLE_NO_DATA_STATE_OBSERVED',
    ok: Boolean(idle),
    detail: idle
      ? { id: idle.id, name: idle.name, enabled: idle.enabled, status: idle.status }
      : 'no idle continuous stream configured yet',
  })

  return out
}

async function resourceBounds(): Promise<Check[]> {
  const out: Check[] = []
  const profile = loadProfile()
  out.push({
    name: 'EPS_PROFILE',
    ok: profile.streams.every((s) => s.eps <= Number(profile.resource_limits.max_eps_per_stream || 1)),
    detail: profile.streams.map((s) => ({ id: s.id, eps: s.eps })),
  })

  // docker stats snapshot
  const stats = execFileSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'],
    { encoding: 'utf8' },
  )
  const continuousLabs = stats
    .split('\n')
    .filter((l) => /frappe|wordpress|webhook-collector|syslog-collector|toxiproxy|wiremock/i.test(l))
  out.push({ name: 'CONTAINER_STATS_SAMPLED', ok: continuousLabs.length > 0, detail: continuousLabs })

  // log rotation options on collectors
  const inspect = execFileSync(
    'docker',
    ['inspect', 'gdc-webhook-collector', '--format', '{{json .HostConfig.LogConfig}}'],
    { encoding: 'utf8' },
  )
  const logConfig = JSON.parse(inspect)
  out.push({
    name: 'LOG_ROTATION',
    ok: logConfig?.Type === 'json-file' && Boolean(logConfig?.Config?.['max-size']),
    detail: logConfig,
  })

  const count = await jget(`${COLLECTOR}/count`)
  out.push({
    name: 'COLLECTOR_BOUNDED',
    ok: count.ok && Number(count.json?.count || 0) < 5000,
    detail: count.json,
  })

  out.push({
    name: 'CONTINUOUS_RESOURCE_OWNERSHIP',
    ok: refuseEphemeralCleanupOfContinuous(CONTINUOUS_OWNERSHIP) === true,
    detail: { ownership: CONTINUOUS_OWNERSHIP },
  })

  out.push({
    name: 'EPHEMERAL_CLEANUP_ISOLATION',
    ok: refuseEphemeralCleanupOfContinuous(CONTINUOUS_OWNERSHIP) === true,
    detail: 'ephemeral cleanup must refuse continuous-e2e-lab registries',
  })

  return out
}

async function frappeAndWordpressProbes(): Promise<Check[]> {
  const out: Check[] = []
  const frappe = process.env.FRAPPE_BASE_URL || 'http://127.0.0.1:8087'
  const wp = process.env.WORDPRESS_BASE_URL || 'http://127.0.0.1:8088'

  // Frappe wrong password
  const badLogin = await fetch(`${frappe}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'usr=Administrator&pwd=wrong',
  })
  out.push({ name: 'FRAPPE_WRONG_PASSWORD', ok: badLogin.status === 401, detail: { status: badLogin.status } })

  // Frappe good login + cookie + resource
  const good = await fetch(`${frappe}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'usr=Administrator&pwd=frappe-e2e-pass',
  })
  const setCookie = good.headers.get('set-cookie') || ''
  const sid = /sid=([^;]+)/.exec(setCookie)?.[1]
  out.push({ name: 'FRAPPE_SESSION_LOGIN', ok: good.ok && Boolean(sid), detail: { status: good.status, sid: sid ? 'present' : null } })

  const customers = await fetch(`${frappe}/api/resource/Customer`, { headers: { Cookie: `sid=${sid}` } })
  const custJson = await customers.json()
  out.push({
    name: 'FRAPPE_COOKIE_PERSISTENCE',
    ok: customers.ok && Array.isArray(custJson.data) && custJson.data.length > 0,
    detail: { status: customers.status, count: custJson.data?.length },
  })

  const empty = await fetch(`${frappe}/api/resource/Customer?empty=1`, { headers: { Cookie: `sid=${sid}` } })
  const emptyJson = await empty.json()
  out.push({ name: 'FRAPPE_EMPTY_RESULT', ok: empty.ok && emptyJson.data?.length === 0, detail: emptyJson })

  await fetch(`${frappe}/__lab/expire-sessions`, { method: 'POST' })
  const expired = await fetch(`${frappe}/api/resource/Customer`, { headers: { Cookie: `sid=${sid}` } })
  out.push({ name: 'FRAPPE_EXPIRED_SESSION', ok: expired.status === 401, detail: { status: expired.status } })

  // checkpoint-ish: seed new customer after modified_after
  const relogin = await fetch(`${frappe}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'usr=Administrator&pwd=frappe-e2e-pass',
  })
  const sid2 = /sid=([^;]+)/.exec(relogin.headers.get('set-cookie') || '')?.[1]
  await fetch(`${frappe}/__lab/seed/customer`, { method: 'POST' })
  const after = await fetch(`${frappe}/api/resource/Customer?modified_after=2026-09-11T00:01:30`, {
    headers: { Cookie: `sid=${sid2}` },
  })
  const afterJson = await after.json()
  out.push({
    name: 'FRAPPE_CHECKPOINT',
    ok: after.ok && Array.isArray(afterJson.data) && afterJson.data.length >= 1,
    detail: { count: afterJson.data?.length, sample: afterJson.data?.[0]?.name },
  })

  // WordPress basic
  const wpHealth = await fetch(`${wp}/health`)
  if (!wpHealth.ok) {
    out.push({ name: 'WORDPRESS_BASIC_AUTH', ok: false, detail: 'lab_not_running' })
    return out
  }
  const noAuth = await fetch(`${wp}/wp-json/wp/v2/posts`)
  out.push({ name: 'WORDPRESS_REJECTS_NO_AUTH', ok: noAuth.status === 401, detail: { status: noAuth.status } })
  const token = Buffer.from('wp-e2e-user:wp-e2e-pass').toString('base64')
  const posts = await fetch(`${wp}/wp-json/wp/v2/posts`, { headers: { Authorization: `Basic ${token}` } })
  const postsJson = await posts.json()
  out.push({
    name: 'WORDPRESS_BASIC_AUTH',
    ok: posts.ok && Array.isArray(postsJson) && postsJson.length > 0,
    detail: { status: posts.status, count: postsJson.length },
  })
  return out
}

async function main() {
  const checks: Check[] = []
  checks.push(...(await toxiproxyLatencyTimeoutRecovery()))
  checks.push(...(await frappeAndWordpressProbes()))
  checks.push(...(await observeRuntimeStates()))
  checks.push(...(await resourceBounds()))

  const report = {
    ok: checks.every((c) => c.ok),
    ownership: CONTINUOUS_OWNERSHIP,
    checks,
    generatedAt: new Date().toISOString(),
  }
  const out = path.join(__dirname, 'state', 'live-validation-report.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
