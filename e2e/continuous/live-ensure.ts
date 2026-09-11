/**
 * Live Continuous E2E ensure — create/enable continuous-owned platform resources.
 * Opt-in only via GDC_CONTINUOUS_LIVE_ENSURE=1.
 * PRODUCT_CODE untouched; ownership = continuous-e2e-lab.
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONTINUOUS_NAME_PREFIX, CONTINUOUS_OWNERSHIP } from './lifecycle.js'
import { loadProfile, type StreamProfile } from './scenario-controller.js'

export type LiveEnsureEnv = {
  apiBaseUrl: string
  wiremockBaseUrl: string
  wiremockHostUrl: string
  webhookCollectorUrl: string
  webhookCollectorDockerUrl: string
  syslogHost: string
  syslogPort: number
  syslogTlsPort: number
  frappeBaseUrl: string
  frappeDockerUrl: string
  wordpressBaseUrl: string
  wordpressDockerUrl: string
  minioEndpoint: string
  minioAccessKey: string
  minioSecretKey: string
  minioBucket: string
  pgFixtureUrl: string
  sftpHost: string
  sftpPort: number
  sftpUser: string
  sftpPassword: string
}

export type EnsuredResource = {
  streamProfileId: string
  streamName: string
  connectorId?: number
  sourceId?: number
  streamId?: number
  routeIds?: number[]
  destinationId?: number
  enabled?: boolean
  delivered?: boolean
  deliveryCount?: number
  runOnce?: unknown
  error?: string
  skipped?: string
}

function env(): LiveEnsureEnv {
  const api = (process.env.GDC_E2E_API_BASE_URL || process.env.PLAYWRIGHT_API_BASE_URL || 'http://127.0.0.1:8000').replace(
    /\/$/,
    '',
  )
  return {
    apiBaseUrl: api,
    // Host-side probes
    wiremockHostUrl: (process.env.WIREMOCK_BASE_URL || 'http://127.0.0.1:28080').replace(/\/$/, ''),
    // In-cluster URLs reachable from gdc-platform-api / scheduler
    wiremockBaseUrl: (process.env.GDC_CONTINUOUS_WIREMOCK_URL || 'http://gdc-wiremock-test:8080').replace(/\/$/, ''),
    webhookCollectorUrl: (process.env.GDC_E2E_WEBHOOK_COLLECTOR_URL || 'http://127.0.0.1:18192').replace(/\/$/, ''),
    webhookCollectorDockerUrl: (
      process.env.GDC_CONTINUOUS_WEBHOOK_DOCKER_URL || 'http://gdc-webhook-collector:8080/continuous-e2e'
    ).replace(/\/$/, ''),
    syslogHost: process.env.GDC_CONTINUOUS_SYSLOG_HOST || 'gdc-syslog-collector',
    syslogPort: Number(process.env.GDC_E2E_SYSLOG_COLLECTOR_PORT || 5514),
    syslogTlsPort: Number(process.env.GDC_E2E_SYSLOG_TLS_PORT || 6514),
    frappeBaseUrl: (process.env.FRAPPE_BASE_URL || 'http://127.0.0.1:8087').replace(/\/$/, ''),
    frappeDockerUrl: (process.env.FRAPPE_DOCKER_URL || 'http://gdc-frappe-session-lab:8087').replace(/\/$/, ''),
    wordpressBaseUrl: (process.env.WORDPRESS_BASE_URL || 'http://127.0.0.1:8088').replace(/\/$/, ''),
    wordpressDockerUrl: (process.env.WORDPRESS_DOCKER_URL || 'http://gdc-wordpress-basic-lab:8088').replace(/\/$/, ''),
    minioEndpoint: process.env.SOURCE_E2E_MINIO_ENDPOINT || 'http://gdc-minio-test:9000',
    minioAccessKey: process.env.SOURCE_E2E_MINIO_ACCESS_KEY || 'gdcminioaccess',
    minioSecretKey: process.env.SOURCE_E2E_MINIO_SECRET_KEY || 'gdcminioaccesssecret12',
    minioBucket: process.env.SOURCE_E2E_MINIO_BUCKET || 'gdc-full-e2e',
    pgFixtureUrl:
      process.env.SOURCE_E2E_PG_FIXTURE_DOCKER_URL ||
      'postgresql://gdc_fixture:gdc_fixture_pw@gdc-postgres-query-test:5432/gdc_query_fixture',
    sftpHost: process.env.SOURCE_E2E_SFTP_DOCKER_HOST || 'gdc-sftp-test',
    sftpPort: Number(process.env.SOURCE_E2E_SFTP_PORT || 22),
    sftpUser: process.env.SOURCE_E2E_SFTP_USER || 'gdc',
    sftpPassword: process.env.SOURCE_E2E_SFTP_PASSWORD || 'devlab123',
  }
}

async function api(
  e: LiveEnsureEnv,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${e.apiBaseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

async function listByNamePrefix(e: LiveEnsureEnv, kind: 'streams' | 'connectors' | 'destinations') {
  const { ok, json } = await api(e, 'GET', `/api/v1/${kind}/`)
  if (!ok) return []
  const items = Array.isArray(json) ? json : json?.items || []
  return items.filter((x: any) => String(x?.name || '').startsWith(CONTINUOUS_NAME_PREFIX))
}

async function ensureDestination(e: LiveEnsureEnv): Promise<number> {
  const name = `${CONTINUOUS_NAME_PREFIX} Webhook Collector`
  const existing = await listByNamePrefix(e, 'destinations')
  const hit = existing.find((d: any) => d.name === name)
  if (hit?.id) return Number(hit.id)

  const created = await api(e, 'POST', '/api/v1/destinations/', {
    name,
    destination_type: 'WEBHOOK_POST',
    config_json: { url: e.webhookCollectorDockerUrl, method: 'POST' },
    enabled: true,
    status: 'ACTIVE',
  })
  if (!created.ok || !created.json?.id) {
    throw new Error(`create destination failed: ${created.status} ${JSON.stringify(created.json)}`)
  }
  return Number(created.json.id)
}

async function ensureSyslogDestination(
  e: LiveEnsureEnv,
  kind: 'tcp' | 'tls',
): Promise<number> {
  const name =
    kind === 'tls'
      ? `${CONTINUOUS_NAME_PREFIX} Syslog TLS Collector`
      : `${CONTINUOUS_NAME_PREFIX} Syslog TCP Collector`
  const existing = await listByNamePrefix(e, 'destinations')
  const hit = existing.find((d: any) => d.name === name)
  if (hit?.id) return Number(hit.id)

  const payload =
    kind === 'tls'
      ? {
          name,
          destination_type: 'SYSLOG_TLS',
          config_json: {
            host: e.syslogHost,
            port: e.syslogTlsPort,
            protocol: 'tls',
            message_format: 'json',
            tls_enabled: true,
            // Lab collector uses a self-signed cert — match full-e2e driver.
            tls_verify_mode: 'insecure_skip_verify',
            tls_server_name: 'localhost',
            facility: 16,
            severity: 6,
            app_name: 'continuous-e2e',
          },
          enabled: true,
          status: 'ACTIVE',
        }
      : {
          name,
          destination_type: 'SYSLOG_TCP',
          config_json: {
            host: e.syslogHost,
            port: e.syslogPort,
            facility: 16,
            severity: 6,
            app_name: 'continuous-e2e',
          },
          enabled: true,
          status: 'ACTIVE',
        }
  const created = await api(e, 'POST', '/api/v1/destinations/', payload)
  if (!created.ok || !created.json?.id) {
    throw new Error(`create syslog dest failed: ${created.status} ${JSON.stringify(created.json)}`)
  }
  return Number(created.json.id)
}

/** Repair existing continuous SYSLOG_TLS destinations created with legacy verify_ssl. */
async function repairSyslogTlsDestinations(e: LiveEnsureEnv): Promise<void> {
  const destinations = await listByNamePrefix(e, 'destinations')
  for (const d of destinations) {
    if (String(d.destination_type || '').toUpperCase() !== 'SYSLOG_TLS') continue
    const cfg = { ...(d.config_json || {}) }
    const needsRepair =
      cfg.tls_verify_mode !== 'insecure_skip_verify' ||
      cfg.tls_enabled !== true ||
      cfg.protocol !== 'tls'
    if (!needsRepair) continue
    await api(e, 'PUT', `/api/v1/destinations/${d.id}`, {
      name: d.name,
      destination_type: 'SYSLOG_TLS',
      enabled: true,
      config_json: {
        ...cfg,
        host: cfg.host || e.syslogHost,
        port: Number(cfg.port || e.syslogTlsPort),
        protocol: 'tls',
        message_format: cfg.message_format || 'json',
        tls_enabled: true,
        tls_verify_mode: 'insecure_skip_verify',
        tls_server_name: cfg.tls_server_name || 'localhost',
        facility: cfg.facility ?? 16,
        severity: cfg.severity ?? 6,
        app_name: cfg.app_name || 'continuous-e2e',
      },
    })
  }
}

function httpConnectorPayload(e: LiveEnsureEnv, name: string, stream: StreamProfile): Record<string, unknown> {
  const useToxi = Boolean(stream.toxiproxy_target) || stream.id === 'latency-recovering-http'
  const wiremockUrl = useToxi
    ? (process.env.GDC_CONTINUOUS_TOXI_WIREMOCK_URL || 'http://gdc-toxiproxy-test:18080')
    : e.wiremockBaseUrl
  const base: Record<string, unknown> = {
    name,
    connector_type: 'generic_http',
    source_type: 'HTTP_API_POLLING',
    base_url: wiremockUrl,
    verify_ssl: false,
    auth_type: 'no_auth',
  }
  switch (stream.auth) {
    case 'basic':
      base.auth_type = 'basic'
      base.basic_username = 'e2e-basic-user'
      base.basic_password = 'e2e-basic-pass'
      break
    case 'bearer':
      base.auth_type = 'bearer'
      base.bearer_token = 'e2e-bearer-token'
      break
    case 'api_key_header':
      base.auth_type = 'api_key'
      base.api_key_value = 'e2e-api-key-value'
      base.api_key_location = 'headers'
      base.api_key_name = 'X-API-Key'
      break
    case 'oauth2_client_credentials':
      base.auth_type = 'oauth2_client_credentials'
      base.oauth2_token_url = `${wiremockUrl}/oauth2/default/v1/token`
      base.oauth2_client_id = 'okta-e2e-client'
      base.oauth2_client_secret = 'okta-e2e-secret'
      break
    case 'session_login':
      base.auth_type = 'session_login'
      base.login_url = `${wiremockUrl}/e2e-session/login`
      base.login_method = 'POST'
      base.login_username = 'e2e-session-user'
      base.login_password = 'e2e-session-pass'
      base.session_cookie_name = 'GDCSESS'
      break
    default:
      break
  }
  return base
}

async function createConnector(e: LiveEnsureEnv, payload: Record<string, unknown>) {
  const res = await api(e, 'POST', '/api/v1/connectors/', payload)
  if (!res.ok) throw new Error(`connector create ${res.status}: ${JSON.stringify(res.json)}`)
  return { connectorId: Number(res.json.id), sourceId: Number(res.json.source_id ?? res.json.id) }
}

async function createHttpStream(
  e: LiveEnsureEnv,
  opts: {
    name: string
    connectorId: number
    sourceId: number
    destinationId: number
    endpoint: string
    pollingIntervalSec?: number
  },
) {
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: opts.name,
    connector_id: opts.connectorId,
    source_id: opts.sourceId,
    stream_type: 'HTTP_API_POLLING',
    config_json: { endpoint: opts.endpoint, method: 'GET' },
    polling_interval: opts.pollingIntervalSec ?? 120,
    enabled: false,
    status: 'STOPPED',
    event_array_path: '$.data',
    rate_limit_json: { max_requests: 30, per_seconds: 60 },
  })
  if (!streamRes.ok || !streamRes.json?.id) {
    throw new Error(`stream create ${streamRes.status}: ${JSON.stringify(streamRes.json)}`)
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', `/api/v1/runtime/mappings/stream/${streamId}/save`, {
    event_array_path: '$.data',
    field_mappings: {
      id: '$.id',
      e2e_correlation_id: '$.e2e_correlation_id',
      message: '$.message',
      severity: '$.severity',
      // Calendar / productivity fixtures use subject when message is absent.
      subject: '$.subject',
    },
  })
  const routeRes = await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: opts.destinationId,
    name: `${opts.name} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  return { streamId, routeIds: [Number(routeRes.json?.id)].filter(Boolean) }
}

async function enableAndRun(e: LiveEnsureEnv, streamId: number) {
  await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
  // Prefer run-once for deterministic delivery proof
  const run = await api(e, 'POST', `/api/v1/runtime/streams/${streamId}/run-once`, {})
  return run.json
}

async function collectorCount(e: LiveEnsureEnv): Promise<number> {
  const res = await fetch(`${e.webhookCollectorUrl}/count`)
  const j = (await res.json()) as { count?: number }
  return Number(j.count || 0)
}

async function syslogApiCount(): Promise<number> {
  const base = (process.env.GDC_E2E_SYSLOG_COLLECTOR_API_URL || 'http://127.0.0.1:18193').replace(/\/$/, '')
  try {
    const res = await fetch(`${base}/count`)
    const j = (await res.json()) as { count?: number }
    return Number(j.count || 0)
  } catch {
    return 0
  }
}

function runDelivered(runOnce: unknown): boolean {
  if (!runOnce || typeof runOnce !== 'object') return false
  const r = runOnce as Record<string, unknown>
  return (
    Number(r.delivered_batch_event_count || 0) > 0 ||
    Number(r.mapped_event_count || 0) > 0 ||
    Number(r.extracted_event_count || 0) > 0
  )
}

async function repairHttpMapping(e: LiveEnsureEnv, streamId: number): Promise<void> {
  await api(e, 'POST', `/api/v1/runtime/mappings/stream/${streamId}/save`, {
    event_array_path: '$.data',
    field_mappings: {
      id: '$.id',
      e2e_correlation_id: '$.e2e_correlation_id',
      message: '$.message',
      severity: '$.severity',
      subject: '$.subject',
    },
  })
}

async function uploadSftpContinuousProof(e: LiveEnsureEnv): Promise<{ ok: boolean; file?: string; detail?: string }> {
  const stamp = Date.now()
  const file = `continuous-proof-${stamp}.ndjson`
  const line =
    JSON.stringify({
      id: `sftp-proof-${stamp}`,
      message: 'continuous sftp proof',
      severity: 'info',
      e2e_correlation_id: `continuous-sftp-${stamp}`,
    }) + '\n'
  const tmp = path.join('/tmp', file)
  try {
    fs.writeFileSync(tmp, line)
    const { execFileSync } = await import('node:child_process')
    const container = process.env.SOURCE_E2E_SFTP_CONTAINER || 'gdc-sftp-test'
    execFileSync('docker', ['exec', container, 'mkdir', '-p', '/home/gdc/upload/full-e2e'], { stdio: 'ignore' })
    execFileSync('docker', ['cp', tmp, `${container}:/home/gdc/upload/full-e2e/${file}`], { stdio: 'ignore' })
    execFileSync('docker', ['exec', container, 'chown', 'gdc:users', `/home/gdc/upload/full-e2e/${file}`], {
      stdio: 'ignore',
    })
    return { ok: true, file }
  } catch (err) {
    return { ok: false, detail: String(err) }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

async function ensureOneHttpStream(
  e: LiveEnsureEnv,
  stream: StreamProfile,
  destinationId: number,
): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} ${stream.label}`
  const existingStreams = await listByNamePrefix(e, 'streams')
  const existing = existingStreams.find((s: any) => s.name === streamName)
  if (existing?.id) {
    const streamId = Number(existing.id)
    if (!existing.enabled) {
      await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
    }
    if (stream.id === 'syslog-tls-healthy' || stream.path?.includes('calendar')) {
      await repairHttpMapping(e, streamId)
    }
    const before = await collectorCount(e)
    const runOnce = await api(e, 'POST', `/api/v1/runtime/streams/${streamId}/run-once`, {})
    await new Promise((r) => setTimeout(r, 1500))
    const after = await collectorCount(e)
    const delivered =
      stream.destination === 'syslog_tls'
        ? runDelivered(runOnce.json)
        : after > before || runDelivered(runOnce.json)
    return {
      streamProfileId: stream.id,
      streamName,
      streamId,
      enabled: true,
      runOnce: runOnce.json,
      delivered,
      deliveryCount:
        stream.destination === 'syslog_tls'
          ? Number((runOnce.json as any)?.delivered_batch_event_count || 0)
          : Math.max(0, after - before),
    }
  }

  const connectorName = `${CONTINUOUS_NAME_PREFIX} ${stream.id} connector`
  const payload = httpConnectorPayload(e, connectorName, stream)
  const { connectorId, sourceId } = await createConnector(e, payload)
  const endpoint =
    stream.auth === 'session_login' && !stream.path
      ? '/e2e-session/events'
      : stream.path || '/business/crm/contacts'
  // session_login continuous stream uses business path; login still hits /e2e-session/login
  const { streamId, routeIds } = await createHttpStream(e, {
    name: streamName,
    connectorId,
    sourceId,
    destinationId,
    endpoint,
    pollingIntervalSec: Math.max(60, Math.round(1 / Math.max(stream.eps, 0.05))),
  })
  const before = await collectorCount(e)
  const runOnce = await enableAndRun(e, streamId)
  await new Promise((r) => setTimeout(r, 2000))
  const after = await collectorCount(e)
  return {
    streamProfileId: stream.id,
    streamName,
    connectorId,
    sourceId,
    streamId,
    routeIds,
    destinationId,
    enabled: true,
    runOnce,
    delivered: after > before,
    deliveryCount: Math.max(0, after - before),
  }
}

async function ensurePostgresStream(
  e: LiveEnsureEnv,
  stream: StreamProfile,
  destinationId: number,
): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} ${stream.label}`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const streamId = Number(existing.id)
    if (!existing.enabled) {
      await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
    }
    const before = await collectorCount(e)
    const runOnce = await api(e, 'POST', `/api/v1/runtime/streams/${streamId}/run-once`, {})
    await new Promise((r) => setTimeout(r, 1500))
    const after = await collectorCount(e)
    return {
      streamProfileId: stream.id,
      streamName,
      streamId,
      enabled: true,
      runOnce: runOnce.json,
      delivered: after > before || runDelivered(runOnce.json),
      deliveryCount: Math.max(0, after - before, Number((runOnce.json as any)?.delivered_batch_event_count || 0)),
    }
  }
  const connectorName = `${CONTINUOUS_NAME_PREFIX} ${stream.id} connector`
  const conn = await createConnector(e, {
    name: connectorName,
    source_type: 'DATABASE_QUERY',
    auth_type: 'no_auth',
    db_type: 'POSTGRESQL',
    host: process.env.SOURCE_E2E_PG_DOCKER_HOST || 'gdc-postgres-query-test',
    port: Number(process.env.SOURCE_E2E_PG_PORT || 5432),
    database: process.env.SOURCE_E2E_PG_DATABASE || 'gdc_query_fixture',
    db_username: process.env.SOURCE_E2E_PG_USER || 'gdc_fixture',
    db_password: process.env.SOURCE_E2E_PG_PASSWORD || 'gdc_fixture_pw',
  })
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: streamName,
    connector_id: conn.connectorId,
    source_id: conn.sourceId,
    stream_type: 'DATABASE_QUERY',
    config_json: {
      query:
        'SELECT event_id AS id, e2e_correlation_id, message, severity, event_ts, ordering_seq FROM full_e2e_rows ORDER BY ordering_seq LIMIT 20',
      max_rows_per_run: 20,
      query_timeout_seconds: 30,
      checkpoint_mode: 'NONE',
    },
    polling_interval: 120,
    enabled: false,
    status: 'STOPPED',
  })
  if (!streamRes.ok) {
    return {
      streamProfileId: stream.id,
      streamName,
      error: `pg stream create ${streamRes.status}: ${JSON.stringify(streamRes.json)}`,
    }
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: destinationId,
    name: `${streamName} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  const before = await collectorCount(e)
  const runOnce = await enableAndRun(e, streamId)
  await new Promise((r) => setTimeout(r, 2000))
  const after = await collectorCount(e)
  return {
    streamProfileId: stream.id,
    streamName,
    ...conn,
    streamId,
    destinationId,
    enabled: true,
    runOnce,
    delivered: after > before,
    deliveryCount: Math.max(0, after - before),
  }
}

async function ensureS3Stream(
  e: LiveEnsureEnv,
  stream: StreamProfile,
  destinationId: number,
): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} ${stream.label}`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const streamId = Number(existing.id)
    if (!existing.enabled) {
      await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
    }
    // Intended idle / no-new-data — do not require delivery; record checkpoint-idle proof.
    const runOnce = await api(e, 'POST', `/api/v1/runtime/streams/${streamId}/run-once`, {})
    return {
      streamProfileId: stream.id,
      streamName,
      streamId,
      enabled: true,
      runOnce: runOnce.json,
      delivered: false,
      deliveryCount: 0,
      skipped: 'intended_idle_no_new_data',
    }
  }
  const conn = await createConnector(e, {
    name: `${CONTINUOUS_NAME_PREFIX} ${stream.id} connector`,
    source_type: 'S3_OBJECT_POLLING',
    auth_type: 'no_auth',
    endpoint_url: e.minioEndpoint,
    bucket: e.minioBucket,
    access_key: e.minioAccessKey,
    secret_key: e.minioSecretKey,
    region: 'us-east-1',
    path_style_access: true,
    use_ssl: false,
    prefix: 'full-e2e/',
    object_key_pattern: 'full-e2e/*.ndjson',
  })
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: streamName,
    connector_id: conn.connectorId,
    source_id: conn.sourceId,
    stream_type: 'S3_OBJECT_POLLING',
    config_json: {
      prefix: 'full-e2e/',
      object_key_pattern: 'full-e2e/*.ndjson',
      max_objects_per_run: 5,
    },
    polling_interval: 180,
    enabled: false,
    status: 'STOPPED',
  })
  if (!streamRes.ok) {
    return { streamProfileId: stream.id, streamName, error: JSON.stringify(streamRes.json) }
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: destinationId,
    name: `${streamName} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  const runOnce = await enableAndRun(e, streamId)
  return {
    streamProfileId: stream.id,
    streamName,
    ...conn,
    streamId,
    destinationId,
    enabled: true,
    runOnce,
  }
}

async function ensureSftpStream(
  e: LiveEnsureEnv,
  stream: StreamProfile,
  destinationId: number,
): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} ${stream.label}`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const streamId = Number(existing.id)
    if (!existing.enabled) {
      await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
    }
    const seed = await uploadSftpContinuousProof(e)
    const before = await collectorCount(e)
    const runOnce = await api(e, 'POST', `/api/v1/runtime/streams/${streamId}/run-once`, {})
    await new Promise((r) => setTimeout(r, 1500))
    const after = await collectorCount(e)
    const delivered = after > before || runDelivered(runOnce.json)
    return {
      streamProfileId: stream.id,
      streamName,
      streamId,
      enabled: true,
      runOnce: runOnce.json,
      delivered,
      deliveryCount: Math.max(0, after - before),
      skipped: seed.ok ? undefined : `sftp_seed_failed:${seed.detail}`,
    }
  }
  const conn = await createConnector(e, {
    name: `${CONTINUOUS_NAME_PREFIX} ${stream.id} connector`,
    source_type: 'REMOTE_FILE_POLLING',
    auth_type: 'no_auth',
    host: e.sftpHost,
    port: e.sftpPort,
    remote_username: e.sftpUser,
    remote_password: e.sftpPassword,
    remote_file_protocol: 'sftp',
    known_hosts_policy: 'insecure_skip_verify',
    connection_timeout_seconds: 15,
  })
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: streamName,
    connector_id: conn.connectorId,
    source_id: conn.sourceId,
    stream_type: 'REMOTE_FILE_POLLING',
    config_json: {
      remote_directory: '/upload/full-e2e',
      file_glob: '*.ndjson',
      max_files_per_run: 5,
    },
    polling_interval: 180,
    enabled: false,
    status: 'STOPPED',
  })
  if (!streamRes.ok) {
    return { streamProfileId: stream.id, streamName, error: JSON.stringify(streamRes.json) }
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: destinationId,
    name: `${streamName} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  await uploadSftpContinuousProof(e)
  const before = await collectorCount(e)
  const runOnce = await enableAndRun(e, streamId)
  await new Promise((r) => setTimeout(r, 1500))
  const after = await collectorCount(e)
  return {
    streamProfileId: stream.id,
    streamName,
    ...conn,
    streamId,
    destinationId,
    enabled: true,
    runOnce,
    delivered: after > before || runDelivered(runOnce),
    deliveryCount: Math.max(0, after - before),
  }
}

async function proveWebhookInboundPush(
  e: LiveEnsureEnv,
  opts: { streamId: number; connectorId: number; sharedSecret?: string; headerName?: string },
): Promise<{ delivered: boolean; detail: unknown }> {
  const conn = await api(e, 'GET', `/api/v1/connectors/${opts.connectorId}`)
  const receiverKey = String(conn.json?.receiver_key || '')
  if (!receiverKey) return { delivered: false, detail: { error: 'missing_receiver_key' } }

  const secret = opts.sharedSecret || 'continuous-e2e-secret'
  const headerName = opts.headerName || 'X-Continuous-Secret'
  const mode = String(conn.json?.webhook_auth_mode || 'no_auth')
  if (mode !== 'shared_secret_header' || !conn.json?.webhook_shared_secret_configured) {
    await api(e, 'PUT', `/api/v1/connectors/${opts.connectorId}`, {
      name: conn.json?.name,
      source_type: 'WEBHOOK_RECEIVER',
      auth_type: 'no_auth',
      receiver_key: receiverKey,
      webhook_auth_mode: 'shared_secret_header',
      webhook_shared_secret: secret,
      webhook_auth_header_name: headerName,
      max_request_bytes: 1_048_576,
    })
  }

  const stamp = Date.now()
  const before = await syslogApiCount()
  const payload = {
    id: `wh-proof-${stamp}`,
    message: 'continuous webhook push proof',
    severity: 'info',
    e2e_correlation_id: `continuous-webhook-${stamp}`,
  }
  const res = await fetch(`${e.apiBaseUrl}/api/v1/ingest/webhook/${receiverKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [headerName]: secret,
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let ingestJson: any = null
  try {
    ingestJson = text ? JSON.parse(text) : null
  } catch {
    ingestJson = { raw: text }
  }
  await new Promise((r) => setTimeout(r, 1500))
  const after = await syslogApiCount()
  const summary = ingestJson?.summary || ingestJson
  const delivered =
    res.ok &&
    (after > before ||
      Number(summary?.delivered_batch_event_count || 0) > 0 ||
      Number(summary?.mapped_event_count || 0) > 0 ||
      Number(summary?.route_delivery_success_count || 0) > 0)
  return {
    delivered,
    detail: { ingestStatus: res.status, summary, syslogBefore: before, syslogAfter: after },
  }
}

async function ensureWebhookPushStream(
  e: LiveEnsureEnv,
  stream: StreamProfile,
  destinationId: number,
): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} ${stream.label}`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const streamId = Number(existing.id)
    if (!existing.enabled) {
      await api(e, 'PUT', `/api/v1/streams/${streamId}`, { enabled: true, status: 'RUNNING' })
    }
    const connectorId = Number(existing.connector_id)
    const proof = await proveWebhookInboundPush(e, { streamId, connectorId })
    return {
      streamProfileId: stream.id,
      streamName,
      streamId,
      connectorId,
      enabled: true,
      delivered: proof.delivered,
      deliveryCount: proof.delivered ? 1 : 0,
      runOnce: proof.detail,
    }
  }
  const conn = await createConnector(e, {
    name: `${CONTINUOUS_NAME_PREFIX} ${stream.id} connector`,
    source_type: 'WEBHOOK_RECEIVER',
    auth_type: 'no_auth',
    webhook_auth_mode: 'shared_secret_header',
    webhook_shared_secret: 'continuous-e2e-secret',
    webhook_auth_header_name: 'X-Continuous-Secret',
    max_request_bytes: 1_048_576,
  })
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: streamName,
    connector_id: conn.connectorId,
    source_id: conn.sourceId,
    stream_type: 'WEBHOOK_RECEIVER',
    config_json: {},
    polling_interval: 60,
    enabled: true,
    status: 'RUNNING',
  })
  if (!streamRes.ok) {
    return { streamProfileId: stream.id, streamName, error: JSON.stringify(streamRes.json) }
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', `/api/v1/runtime/mappings/stream/${streamId}/save`, {
    field_mappings: {
      id: '$.id',
      e2e_correlation_id: '$.e2e_correlation_id',
      message: '$.message',
      severity: '$.severity',
    },
  })
  await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: destinationId,
    name: `${streamName} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  const proof = await proveWebhookInboundPush(e, {
    streamId,
    connectorId: conn.connectorId,
    sharedSecret: 'continuous-e2e-secret',
    headerName: 'X-Continuous-Secret',
  })
  return {
    streamProfileId: stream.id,
    streamName,
    ...conn,
    streamId,
    destinationId,
    enabled: true,
    delivered: proof.delivered,
    deliveryCount: proof.delivered ? 1 : 0,
    runOnce: proof.detail,
  }
}

export async function liveEnsureAll(opts?: { includeRealApps?: boolean }): Promise<{
  ok: boolean
  ownership: string
  destinationId: number
  resources: EnsuredResource[]
  frappe?: EnsuredResource
  wordpress?: EnsuredResource
}> {
  const e = env()
  const profile = loadProfile()
  const destinationId = await ensureDestination(e)
  const syslogTcpId = await ensureSyslogDestination(e, 'tcp').catch(() => destinationId)
  const syslogTlsId = await ensureSyslogDestination(e, 'tls').catch(() => destinationId)
  await repairSyslogTlsDestinations(e).catch(() => undefined)

  const resources: EnsuredResource[] = []
  for (const stream of profile.streams) {
    try {
      let destId = destinationId
      if (stream.destination === 'syslog_tcp' || stream.destination === 'multi_route_webhook_syslog') {
        destId = syslogTcpId
      } else if (stream.destination === 'syslog_tls') {
        destId = syslogTlsId
      }

      let result: EnsuredResource
      if (stream.source.startsWith('http_') || stream.source === 'http_business_schema_drift') {
        result = await ensureOneHttpStream(e, stream, destId)
      } else if (stream.source === 'postgres_business') {
        result = await ensurePostgresStream(e, stream, destId)
      } else if (stream.source === 's3_business') {
        result = await ensureS3Stream(e, stream, destId)
      } else if (stream.source === 'sftp_business') {
        result = await ensureSftpStream(e, stream, destId)
      } else if (stream.source === 'webhook_receiver') {
        result = await ensureWebhookPushStream(e, stream, destId)
      } else {
        result = { streamProfileId: stream.id, streamName: `${CONTINUOUS_NAME_PREFIX} ${stream.label}`, skipped: `unknown_source:${stream.source}` }
      }
      resources.push(result)
    } catch (err) {
      resources.push({
        streamProfileId: stream.id,
        streamName: `${CONTINUOUS_NAME_PREFIX} ${stream.label}`,
        error: String(err),
      })
    }
  }

  let frappe: EnsuredResource | undefined
  let wordpress: EnsuredResource | undefined
  if (opts?.includeRealApps !== false) {
    frappe = await ensureFrappeSessionStream(e, destinationId).catch((err) => ({
      streamProfileId: 'frappe-session-login',
      streamName: `${CONTINUOUS_NAME_PREFIX} Frappe session_login`,
      error: String(err),
    }))
    wordpress = await ensureWordpressBasicStream(e, destinationId).catch((err) => ({
      streamProfileId: 'wordpress-basic-auth',
      streamName: `${CONTINUOUS_NAME_PREFIX} WordPress Basic Auth`,
      error: String(err),
    }))
  }

  const ok =
    resources.filter((r) => r.streamId && !r.error).length >= 8 &&
    resources.some((r) => r.delivered)

  return { ok, ownership: CONTINUOUS_OWNERSHIP, destinationId, resources, frappe, wordpress }
}

async function ensureFrappeSessionStream(e: LiveEnsureEnv, destinationId: number): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} Frappe session_login Customers`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const runOnce = await enableAndRun(e, Number(existing.id))
    return { streamProfileId: 'frappe-session-login', streamName, streamId: Number(existing.id), enabled: true, runOnce }
  }
  // Probe host health first
  const health = await fetch(`${e.frappeBaseUrl}/health`).catch(() => null)
  if (!health?.ok) {
    return {
      streamProfileId: 'frappe-session-login',
      streamName,
      skipped: 'frappe_lab_not_running',
    }
  }
  const conn = await createConnector(e, {
    name: `${CONTINUOUS_NAME_PREFIX} frappe connector`,
    connector_type: 'generic_http',
    source_type: 'HTTP_API_POLLING',
    base_url: e.frappeDockerUrl,
    verify_ssl: false,
    auth_type: 'session_login',
    login_url: `${e.frappeDockerUrl}/api/method/login`,
    login_method: 'POST',
    login_body_mode: 'form_urlencoded',
    login_body_template: { usr: '{{username}}', pwd: '{{password}}' },
    login_username: process.env.FRAPPE_USER || 'Administrator',
    login_password: process.env.FRAPPE_PASSWORD || 'frappe-e2e-pass',
    session_cookie_name: 'sid',
  })
  const { streamId, routeIds } = await createHttpStream(e, {
    name: streamName,
    connectorId: conn.connectorId,
    sourceId: conn.sourceId,
    destinationId,
    endpoint: '/api/resource/Customer',
    pollingIntervalSec: 120,
  })
  // Frappe returns {data: [...]} — event_array_path already $.data
  const before = await collectorCount(e)
  const runOnce = await enableAndRun(e, streamId)
  await new Promise((r) => setTimeout(r, 2500))
  const after = await collectorCount(e)
  return {
    streamProfileId: 'frappe-session-login',
    streamName,
    ...conn,
    streamId,
    routeIds,
    destinationId,
    enabled: true,
    runOnce,
    delivered: after > before,
    deliveryCount: Math.max(0, after - before),
  }
}

async function ensureWordpressBasicStream(e: LiveEnsureEnv, destinationId: number): Promise<EnsuredResource> {
  const streamName = `${CONTINUOUS_NAME_PREFIX} WordPress Basic Auth Posts`
  const existing = (await listByNamePrefix(e, 'streams')).find((s: any) => s.name === streamName)
  if (existing?.id) {
    const runOnce = await enableAndRun(e, Number(existing.id))
    return { streamProfileId: 'wordpress-basic-auth', streamName, streamId: Number(existing.id), enabled: true, runOnce }
  }
  const health = await fetch(`${e.wordpressBaseUrl}/health`).catch(() => null)
  if (!health?.ok) {
    return { streamProfileId: 'wordpress-basic-auth', streamName, skipped: 'wordpress_lab_not_running' }
  }
  const conn = await createConnector(e, {
    name: `${CONTINUOUS_NAME_PREFIX} wordpress connector`,
    connector_type: 'generic_http',
    source_type: 'HTTP_API_POLLING',
    base_url: e.wordpressDockerUrl,
    verify_ssl: false,
    auth_type: 'basic',
    basic_username: process.env.WP_USER || 'wp-e2e-user',
    basic_password: process.env.WP_PASSWORD || 'wp-e2e-pass',
  })
  // WP returns a top-level array — set event_array_path null / $
  const streamRes = await api(e, 'POST', '/api/v1/streams/', {
    name: streamName,
    connector_id: conn.connectorId,
    source_id: conn.sourceId,
    stream_type: 'HTTP_API_POLLING',
    config_json: { endpoint: '/wp-json/wp/v2/posts', method: 'GET' },
    polling_interval: 120,
    enabled: false,
    status: 'STOPPED',
    event_array_path: '$',
    rate_limit_json: { max_requests: 30, per_seconds: 60 },
  })
  if (!streamRes.ok) {
    return { streamProfileId: 'wordpress-basic-auth', streamName, error: JSON.stringify(streamRes.json) }
  }
  const streamId = Number(streamRes.json.id)
  await api(e, 'POST', '/api/v1/routes/', {
    stream_id: streamId,
    destination_id: destinationId,
    name: `${streamName} route`,
    enabled: true,
    status: 'ACTIVE',
    failure_policy: 'LOG_AND_CONTINUE',
  })
  const before = await collectorCount(e)
  const runOnce = await enableAndRun(e, streamId)
  await new Promise((r) => setTimeout(r, 2500))
  const after = await collectorCount(e)
  return {
    streamProfileId: 'wordpress-basic-auth',
    streamName,
    ...conn,
    streamId,
    destinationId,
    enabled: true,
    runOnce,
    delivered: after > before,
    deliveryCount: Math.max(0, after - before),
  }
}

export async function liveTeardownContinuous(): Promise<{ ok: boolean; deleted: Record<string, number[]> }> {
  const e = env()
  const deleted: Record<string, number[]> = { streams: [], routes: [], connectors: [], destinations: [] }
  const streams = await listByNamePrefix(e, 'streams')
  for (const s of streams) {
    // disable first
    await api(e, 'PUT', `/api/v1/streams/${s.id}`, { enabled: false, status: 'STOPPED' })
    // delete routes for stream if listed
    const routes = s.routes || []
    for (const r of routes) {
      const id = typeof r === 'object' ? r.id : r
      if (id) {
        await api(e, 'DELETE', `/api/v1/routes/${id}`)
        deleted.routes.push(Number(id))
      }
    }
    const del = await api(e, 'DELETE', `/api/v1/streams/${s.id}`)
    if (del.ok || del.status === 204) deleted.streams.push(Number(s.id))
  }
  const connectors = await listByNamePrefix(e, 'connectors')
  for (const c of connectors) {
    const del = await api(e, 'DELETE', `/api/v1/connectors/${c.id}`)
    if (del.ok || del.status === 204) deleted.connectors.push(Number(c.id))
  }
  const destinations = await listByNamePrefix(e, 'destinations')
  for (const d of destinations) {
    const del = await api(e, 'DELETE', `/api/v1/destinations/${d.id}`)
    if (del.ok || del.status === 204) deleted.destinations.push(Number(d.id))
  }
  return { ok: true, deleted }
}

export function writeEnsureLiveReport(report: unknown, continuousRoot: string): string {
  const outDir = path.join(continuousRoot, 'state')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'live-ensure-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  return out
}
