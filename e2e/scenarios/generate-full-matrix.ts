#!/usr/bin/env npx tsx
/**
 * Generate Full E2E scenario matrices from e2e/capabilities/data-relay-capabilities.yaml.
 * Does not invent capabilities. Does not upgrade PARTIAL/UI_ONLY/RUNTIME_ONLY to SUPPORTED.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CapabilityRecord,
  E2EScenario,
  Manifest,
  MatrixBundle,
  NotApplicableRecord,
  RouteProcessing,
} from './scenario-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const MANIFEST = path.join(ROOT, 'e2e/capabilities/data-relay-capabilities.yaml')
const OUT_DIR = path.join(__dirname, 'generated')

const SOURCE_TYPE_MAP: Record<string, string> = {
  'source.http_api_polling': 'HTTP_API_POLLING',
  'source.s3_object_polling': 'S3_OBJECT_POLLING',
  'source.database_query_postgresql': 'DATABASE_QUERY',
  'source.remote_file_polling': 'REMOTE_FILE_POLLING',
  'source.webhook_receiver': 'WEBHOOK_RECEIVER',
}

const DEST_TYPE_MAP: Record<string, string> = {
  'destination.syslog_udp': 'SYSLOG_UDP',
  'destination.syslog_tcp': 'SYSLOG_TCP',
  'destination.syslog_tls': 'SYSLOG_TLS',
  'destination.webhook_post': 'WEBHOOK_POST',
}

const AUTH_TO_SOURCE: Record<string, string> = {
  source_http: 'HTTP_API_POLLING',
  source_s3: 'S3_OBJECT_POLLING',
  source_database: 'DATABASE_QUERY',
  source_remote_file: 'REMOTE_FILE_POLLING',
  source_webhook_receiver: 'WEBHOOK_RECEIVER',
}

const AUTH_TO_DEST: Record<string, string> = {
  destination_syslog_tls: 'SYSLOG_TLS',
  destination_webhook: 'WEBHOOK_POST',
  destination_ai_provider: 'AI_PROVIDER_POST',
}

const AUTH_VARIANT: Record<string, string> = {
  'auth.http.no_auth': 'no_auth',
  'auth.http.basic': 'basic',
  'auth.http.bearer': 'bearer',
  'auth.http.api_key': 'api_key',
  'auth.http.oauth2_client_credentials': 'oauth2_client_credentials',
  'auth.http.session_login': 'session_login',
  'auth.http.jwt_refresh_token': 'jwt_refresh_token',
  'auth.http.vendor_jwt_exchange': 'vendor_jwt_exchange',
  'auth.s3.access_key_secret': 's3_keys',
  'auth.database.username_password': 'db_password',
  'auth.remote_file.ssh_password_or_key': 'ssh',
  'auth.webhook_receiver.inbound': 'inbound',
  'auth.destination.syslog_tls_client_cert': 'mtls',
  'auth.ai_provider.api_key_or_bearer': 'ai_provider',
}

const DEFAULT_HTTP_AUTH = 'no_auth'
const DEFAULT_DEST = 'WEBHOOK_POST'
const DEFAULT_SOURCE = 'HTTP_API_POLLING'

const FAULT_TYPES = [
  'http_401',
  'http_403',
  'http_429',
  'http_500',
  'http_timeout',
  'malformed_response',
  'db_disconnect',
  's3_unavailable',
  'sftp_unavailable',
  'webhook_destination_down',
  'syslog_destination_down',
  'tls_certificate_error',
  'partial_route_failure',
  'api_restart',
  'runtime_restart',
] as const

const PROTECTION_ACTIONS = ['audit', 'mask', 'tokenize', 'hash', 'remove'] as const
const DELIVERY_BEHAVIORS = ['continue', 'review', 'quarantine', 'block'] as const

function loadManifest(): Manifest {
  const py = `
import json, yaml, sys
with open(sys.argv[1]) as f:
    print(json.dumps(yaml.safe_load(f)))
`
  const raw = execFileSync('python3', ['-c', py, MANIFEST], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })
  return JSON.parse(raw) as Manifest
}

function isSupported(c: CapabilityRecord): boolean {
  return c.status === 'SUPPORTED'
}

function isTrue(v: boolean | string | undefined): boolean {
  return v === true || v === 'true'
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

function pushScenario(list: E2EScenario[], s: E2EScenario): void {
  list.push(s)
}

function expandRoute(mode: RouteProcessing): RouteProcessing[] {
  // Route-OFF retired — canonical Full Matrix is Route Processing ON only.
  void mode
  return ['on']
}

function withRouteVariants(base: Omit<E2EScenario, 'id'> & { idStem: string }): E2EScenario[] {
  const modes = expandRoute(base.routeProcessing)
  return modes.map((m) => ({
    ...base,
    id: `${base.idStem}__route-${m}`,
    routeProcessing: m as RouteProcessing,
    tags: [...base.tags, `route-${m}`],
  }))
}

function buildAuthentication(
  manifest: Manifest,
  scenarios: E2EScenario[],
  na: NotApplicableRecord[],
): void {
  for (const auth of manifest.authentication) {
    const applicable = auth.applicable_to ?? []
    const variant = AUTH_VARIANT[auth.id] ?? slug(auth.id)
    const sourceType = applicable.map((a) => AUTH_TO_SOURCE[a]).find(Boolean)
    const destType = applicable.map((a) => AUTH_TO_DEST[a]).find(Boolean)

    if (!isSupported(auth)) {
      pushScenario(scenarios, {
        id: `auth__${slug(auth.id)}__status-${auth.status.toLowerCase()}`,
        suite: 'authentication',
        executionMode: isTrue(auth.ui_supported) ? 'browser' : 'api_seeded',
        routeProcessing: 'on',
        source: sourceType ? { type: sourceType, authentication: variant } : undefined,
        destination: destType ? { type: destType, authentication: variant } : undefined,
        capabilities: [auth.id],
        fixture: `auth/${variant}`,
        expectedStatus: auth.status === 'NOT_IMPLEMENTED' ? 'NOT_IMPLEMENTED' : 'NOT_IMPLEMENTED',
        reason: `Manifest status=${auth.status}; not upgraded to SUPPORTED`,
        tags: ['authentication', auth.status.toLowerCase(), 'shard:authentication'],
        shard: 'authentication',
        authOutcome: 'success',
      })
      continue
    }

    if (!sourceType && !destType) {
      na.push({
        combination: `auth=${auth.id}`,
        reason: 'No applicable source/destination mapping in generator',
        capabilities: [auth.id],
      })
      continue
    }

    const ui = isTrue(auth.ui_supported)
    const baseCaps = [auth.id]
    if (sourceType === 'HTTP_API_POLLING') baseCaps.push('source.http_api_polling')
    if (sourceType === 'S3_OBJECT_POLLING') baseCaps.push('source.s3_object_polling')
    if (sourceType === 'DATABASE_QUERY') baseCaps.push('source.database_query_postgresql')
    if (sourceType === 'REMOTE_FILE_POLLING') baseCaps.push('source.remote_file_polling')
    if (sourceType === 'WEBHOOK_RECEIVER') baseCaps.push('source.webhook_receiver')
    if (destType === 'SYSLOG_TLS') baseCaps.push('destination.syslog_tls')
    if (destType === 'WEBHOOK_POST') baseCaps.push('destination.webhook_post')

    // Success path — route flag independent but executed under both lab modes
    for (const mode of ui ? (['browser', 'api_seeded'] as const) : (['api_seeded'] as const)) {
      scenarios.push(
        ...withRouteVariants({
          idStem: `auth__${slug(auth.id)}__success__${mode}`,
          suite: 'authentication',
          executionMode: mode,
          routeProcessing: 'on',
          source: sourceType
            ? { type: sourceType, authentication: variant }
            : { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
          destination: destType
            ? { type: destType, authentication: variant }
            : { type: DEFAULT_DEST },
          capabilities: [
            ...baseCaps,
            'wizard.feature.connection_auth_test',
            'destination.webhook_post',
          ].filter((v, i, a) => a.indexOf(v) === i),
          fixture: `auth/${variant}/success`,
          expectedStatus: 'PASS',
          tags: ['authentication', 'success', `shard:authentication`, mode],
          shard: 'authentication',
          authOutcome: 'success',
        }),
      )
    }

    // Failure path when connection test is supported
    if (auth.connection_test_supported !== false && variant !== 'no_auth') {
      scenarios.push(
        ...withRouteVariants({
          idStem: `auth__${slug(auth.id)}__failure__${ui ? 'browser' : 'api_seeded'}`,
          suite: 'authentication',
          executionMode: ui ? 'browser' : 'api_seeded',
          routeProcessing: 'on',
          source: sourceType
            ? { type: sourceType, authentication: variant, variant: 'bad_credentials' }
            : undefined,
          destination: destType
            ? { type: destType, authentication: variant, variant: 'bad_credentials' }
            : { type: DEFAULT_DEST },
          capabilities: [...baseCaps, 'wizard.feature.connection_auth_test'],
          fixture: `auth/${variant}/failure`,
          expectedStatus: 'PASS',
          tags: ['authentication', 'failure', 'shard:authentication'],
          shard: 'authentication',
          authOutcome: 'failure',
        }),
      )
    } else if (variant === 'no_auth') {
      na.push({
        combination: `auth=${auth.id} × failure`,
        reason: 'no_auth has no invalid-credential failure path',
        capabilities: [auth.id],
      })
    }
  }
}

function buildSourceDestination(
  manifest: Manifest,
  scenarios: E2EScenario[],
  na: NotApplicableRecord[],
): void {
  const sources = manifest.sources.filter(isSupported)
  const dests = manifest.destinations.filter(isSupported)

  for (const src of manifest.sources) {
    if (!isSupported(src)) {
      pushScenario(scenarios, {
        id: `source__${slug(src.id)}__${src.status.toLowerCase()}`,
        suite: 'source',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [src.id],
        fixture: `source/${slug(src.id)}`,
        expectedStatus: src.status === 'RUNTIME_ONLY' ? 'NOT_IMPLEMENTED' : 'NOT_IMPLEMENTED',
        reason: `Manifest status=${src.status}`,
        tags: ['source', src.status.toLowerCase(), 'shard:http'],
        shard: 'http',
      })
      continue
    }

    const srcType = SOURCE_TYPE_MAP[src.id]
    if (!srcType) {
      na.push({ combination: src.id, reason: 'Unknown source type mapping', capabilities: [src.id] })
      continue
    }

    const shard =
      srcType === 'HTTP_API_POLLING'
        ? 'http'
        : srcType === 'DATABASE_QUERY'
          ? 'database'
          : srcType === 'S3_OBJECT_POLLING' || srcType === 'REMOTE_FILE_POLLING'
            ? 'object-file'
            : 'http'

    // Source lifecycle (create→test→sample→runtime)
    for (const mode of isTrue(src.ui_supported) ? (['browser', 'api_seeded'] as const) : (['api_seeded'] as const)) {
      const variants = withRouteVariants({
        idStem: `source__${slug(src.id)}__lifecycle__${mode}`,
        suite: 'source',
        executionMode: mode,
        routeProcessing: 'on',
        source: { type: srcType, authentication: defaultAuthForSource(srcType) },
        destination: { type: DEFAULT_DEST },
        capabilities: [
          src.id,
          'destination.webhook_post',
          'wizard.step.connect',
          'wizard.step.sample',
          'wizard.step.deploy',
          'wizard.feature.connection_auth_test',
        ],
        fixture: `source/${srcType.toLowerCase()}/lifecycle`,
        expectedStatus: 'PASS',
        tags: ['source', 'lifecycle', `shard:${shard}`, mode],
        shard,
      })
      scenarios.push(...variants)
    }

    // Source × Destination delivery matrix
    for (const dest of dests) {
      const destType = DEST_TYPE_MAP[dest.id]
      if (!destType) continue

      // Webhook receiver → syslog TLS may be heavy; still valid
      const destShard =
        destType.startsWith('SYSLOG') || destType === 'WEBHOOK_POST' ? 'destination' : 'destination'

      const variants = withRouteVariants({
        idStem: `srcdest__${slug(src.id)}__${slug(dest.id)}__api`,
        suite: 'destination',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        source: { type: srcType, authentication: defaultAuthForSource(srcType) },
        destination: { type: destType },
        capabilities: [src.id, dest.id, 'runtime.health_metrics_audit_logs'],
        fixture: `srcdest/${srcType.toLowerCase()}/${destType.toLowerCase()}`,
        expectedStatus: 'PASS',
        tags: ['source-destination', `shard:${destShard}`],
        shard: destShard,
      })
      scenarios.push(...variants)
    }

    // Incremental / checkpoint / dedup where applicable
    if (srcType === 'WEBHOOK_RECEIVER') {
      na.push({
        combination: `${src.id} × incremental_fetch`,
        reason: 'Push source — incremental watermark fetch NOT_APPLICABLE',
        capabilities: [src.id, 'wizard.feature.incremental_fetch'],
      })
    } else {
      scenarios.push(
        ...withRouteVariants({
          idStem: `runtime__incremental__${slug(src.id)}`,
          suite: 'runtime',
          executionMode: 'api_seeded',
          routeProcessing: 'on',
          source: { type: srcType, authentication: defaultAuthForSource(srcType) },
          destination: { type: DEFAULT_DEST },
          capabilities: [
            src.id,
            'wizard.feature.incremental_fetch',
            'wizard.feature.checkpoint',
            'runtime.checkpoint_after_delivery',
            'destination.webhook_post',
          ],
          fixture: `runtime/incremental/${srcType.toLowerCase()}`,
          expectedStatus: 'PASS',
          tags: ['incremental', 'checkpoint', `shard:${shard}`],
          shard,
        }),
      )
    }

    scenarios.push(
      ...withRouteVariants({
        idStem: `runtime__dedup__${slug(src.id)}`,
        suite: 'runtime',
        executionMode: isTrue(src.ui_supported) ? 'browser' : 'api_seeded',
        routeProcessing: 'on',
        source: { type: srcType, authentication: defaultAuthForSource(srcType) },
        destination: { type: DEFAULT_DEST },
        capabilities: [src.id, 'wizard.feature.dedup', 'runtime.dedup', 'destination.webhook_post'],
        fixture: `runtime/dedup/${srcType.toLowerCase()}`,
        expectedStatus: 'PASS',
        tags: ['dedup', `shard:${shard}`],
        shard,
      }),
    )

    // Scheduler representative (one per source family)
    pushScenario(scenarios, {
      id: `runtime__scheduler__${slug(src.id)}__route-on`,
      suite: 'runtime',
      executionMode: 'api_seeded',
      routeProcessing: 'on',
      source: { type: srcType, authentication: defaultAuthForSource(srcType) },
      destination: { type: DEFAULT_DEST },
      capabilities: [src.id, 'destination.webhook_post', 'runtime.health_metrics_audit_logs'],
      fixture: `runtime/scheduler/${srcType.toLowerCase()}`,
      expectedStatus: 'PASS',
      tags: ['scheduler', `shard:${shard}`],
      shard,
    })
  }

  for (const dest of manifest.destinations) {
    if (isSupported(dest)) {
      const destType = DEST_TYPE_MAP[dest.id]
      if (!destType) continue
      for (const mode of isTrue(dest.ui_supported) ? (['browser', 'api_seeded'] as const) : (['api_seeded'] as const)) {
        pushScenario(scenarios, {
          id: `dest__${slug(dest.id)}__lifecycle__${mode}__route-on`,
          suite: 'destination',
          executionMode: mode,
          routeProcessing: 'on',
          source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
          destination: { type: destType },
          capabilities: [dest.id, 'source.http_api_polling', 'wizard.step.destinations'],
          fixture: `destination/${destType.toLowerCase()}/lifecycle`,
          expectedStatus: 'PASS',
          tags: ['destination', 'lifecycle', 'shard:destination', mode],
          shard: 'destination',
        })
      }
    } else {
      pushScenario(scenarios, {
        id: `dest__${slug(dest.id)}__${dest.status.toLowerCase()}`,
        suite: 'destination',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [dest.id],
        fixture: `destination/${slug(dest.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${dest.status}`,
        tags: ['destination', dest.status.toLowerCase(), 'shard:destination'],
        shard: 'destination',
      })
    }
  }
}

function defaultAuthForSource(srcType: string): string {
  switch (srcType) {
    case 'HTTP_API_POLLING':
      return 'no_auth'
    case 'S3_OBJECT_POLLING':
      return 's3_keys'
    case 'DATABASE_QUERY':
      return 'db_password'
    case 'REMOTE_FILE_POLLING':
      return 'ssh'
    case 'WEBHOOK_RECEIVER':
      return 'inbound'
    default:
      return 'no_auth'
  }
}

function buildProcessing(manifest: Manifest, scenarios: E2EScenario[], na: NotApplicableRecord[]): void {
  for (const proc of manifest.processing) {
    if (!isSupported(proc)) {
      pushScenario(scenarios, {
        id: `processing__${slug(proc.id)}__${proc.status.toLowerCase()}`,
        suite: 'processing',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [proc.id],
        fixture: `processing/${slug(proc.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${proc.status}`,
        tags: ['processing', proc.status.toLowerCase(), 'shard:processing'],
        shard: 'processing',
        transform: proc.id,
      })
      continue
    }

    const modes = isTrue(proc.ui_supported) ? (['browser', 'api_seeded'] as const) : (['api_seeded'] as const)
    for (const mode of modes) {
      scenarios.push(
        ...withRouteVariants({
          idStem: `processing__${slug(proc.id)}__${mode}`,
          suite: 'processing',
          executionMode: mode,
          routeProcessing: 'on',
          source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
          destination: { type: DEFAULT_DEST },
          capabilities: [
            proc.id,
            'source.http_api_polling',
            'destination.webhook_post',
            'processing.mapping.field_jsonpath',
          ].filter((v, i, a) => a.indexOf(v) === i),
          fixture: `processing/${slug(proc.id)}`,
          expectedStatus: 'PASS',
          tags: ['processing', 'preview-runtime', `shard:processing`, mode],
          shard: 'processing',
          transform: proc.id,
        }),
      )
    }
  }

  // Union schema dedicated scenario
  scenarios.push(
    ...withRouteVariants({
      idStem: 'wizard__union_schema__browser',
      suite: 'wizard',
      executionMode: 'browser',
      routeProcessing: 'on',
      source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH, variant: 'union_schema' },
      destination: { type: DEFAULT_DEST },
      capabilities: [
        'wizard.feature.union_schema',
        'wizard.feature.record_path',
        'wizard.feature.event_root',
        'wizard.step.sample',
        'source.http_api_polling',
        'destination.webhook_post',
        'processing.mapping.unmapped_policy',
      ],
      fixture: 'wizard/union-schema',
      expectedStatus: 'PASS',
      tags: ['union-schema', 'shard:processing'],
      shard: 'processing',
    }),
  )

  na.push({
    combination: 'wizard.feature.rare_field × runtime',
    reason: 'UI_ONLY — verify in UI browser scenario only, not as runtime capability',
    capabilities: ['wizard.feature.rare_field'],
  })
  na.push({
    combination: 'wizard.feature.sensitive_suggestion × runtime',
    reason: 'UI_ONLY — verify in UI browser scenario only, not as runtime capability',
    capabilities: ['wizard.feature.sensitive_suggestion'],
  })
}

function buildWizard(manifest: Manifest, scenarios: E2EScenario[]): void {
  for (const wiz of manifest.wizard) {
    if (wiz.status === 'UI_ONLY') {
      pushScenario(scenarios, {
        id: `wizard__${slug(wiz.id)}__ui_only__browser__route-on`,
        suite: 'wizard',
        executionMode: 'browser',
        routeProcessing: 'on',
        source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
        destination: { type: DEFAULT_DEST },
        capabilities: [wiz.id, 'wizard.step.sample', 'source.http_api_polling'],
        fixture: `wizard/${slug(wiz.id)}`,
        expectedStatus: 'PASS',
        reason: 'UI_ONLY capability — browser assertion only',
        tags: ['wizard', 'ui_only', 'shard:processing'],
        shard: 'processing',
      })
      continue
    }
    if (!isSupported(wiz)) {
      pushScenario(scenarios, {
        id: `wizard__${slug(wiz.id)}__${wiz.status.toLowerCase()}`,
        suite: 'wizard',
        executionMode: isTrue(wiz.ui_supported) ? 'browser' : 'api_seeded',
        routeProcessing: 'on',
        capabilities: [wiz.id],
        fixture: `wizard/${slug(wiz.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${wiz.status}`,
        tags: ['wizard', wiz.status.toLowerCase(), 'shard:processing'],
        shard: 'processing',
      })
      continue
    }

    // Covered by source lifecycle / dedicated scenarios; still ensure unique scenario per capability
    if (
      scenarios.some((s) => s.capabilities.includes(wiz.id) && s.expectedStatus !== 'NOT_IMPLEMENTED')
    ) {
      continue
    }

    pushScenario(scenarios, {
      id: `wizard__${slug(wiz.id)}__browser__route-on`,
      suite: 'wizard',
      executionMode: 'browser',
      routeProcessing: 'on',
      source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
      destination: { type: DEFAULT_DEST },
      capabilities: [wiz.id, 'source.http_api_polling', 'destination.webhook_post'],
      fixture: `wizard/${slug(wiz.id)}`,
      expectedStatus: 'PASS',
      tags: ['wizard', 'shard:processing'],
      shard: 'processing',
    })
  }
}

function buildRoutes(manifest: Manifest, scenarios: E2EScenario[]): void {
  for (const route of manifest.routes) {
    if (!isSupported(route)) {
      pushScenario(scenarios, {
        id: `route__${slug(route.id)}__${route.status.toLowerCase()}`,
        suite: 'route',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
        destination: { type: DEFAULT_DEST },
        capabilities: [route.id],
        fixture: `route/${slug(route.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${route.status}`,
        tags: ['route', route.status.toLowerCase(), 'shard:route'],
        shard: 'route',
      })
      continue
    }

    scenarios.push(
      ...withRouteVariants({
        idStem: `route__${slug(route.id)}__api`,
        suite: 'route',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
        destination: { type: 'WEBHOOK_POST', variant: 'multi_route' },
        capabilities: [
          route.id,
          'routes.architecture.one_stream_many_routes',
          'source.http_api_polling',
          'destination.webhook_post',
          'destination.syslog_tcp',
          'destination.syslog_tls',
        ].filter((v, i, a) => a.indexOf(v) === i),
        fixture: 'route/multi-route',
        expectedStatus: 'PASS',
        tags: ['route', 'multi-route', 'shard:route'],
        shard: 'route',
      }),
    )
  }

  // Explicit multi-route browser + inherit/override/partial-fail
  for (const kind of ['inherit', 'override', 'partial_failure'] as const) {
    scenarios.push(
      ...withRouteVariants({
        idStem: `route__multi__${kind}__browser`,
        suite: 'route',
        executionMode: 'browser',
        routeProcessing: 'on',
        source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
        destination: { type: 'WEBHOOK_POST', variant: 'multi_route' },
        capabilities: [
          'routes.architecture.one_stream_many_routes',
          'routes.global_processing',
          'routes.delivery_settings',
          'routes.metrics_health',
          'runtime.partial_route_failure',
          'flag.gdc_route_processing_enabled',
          'source.http_api_polling',
          'destination.webhook_post',
          'destination.syslog_tcp',
          'destination.syslog_tls',
        ],
        fixture: `route/multi/${kind}`,
        expectedStatus: 'PASS',
        tags: ['route', kind, 'shard:route'],
        shard: 'route',
      }),
    )
  }
}

function buildGovernance(manifest: Manifest, scenarios: E2EScenario[]): void {
  for (const gov of manifest.governance) {
    if (!isSupported(gov)) {
      pushScenario(scenarios, {
        id: `governance__${slug(gov.id)}__${gov.status.toLowerCase()}`,
        suite: 'governance',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [gov.id],
        fixture: `governance/${slug(gov.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${gov.status}`,
        tags: ['governance', gov.status.toLowerCase(), 'shard:governance'],
        shard: 'governance',
      })
      continue
    }
  }

  for (const action of PROTECTION_ACTIONS) {
    for (const behavior of DELIVERY_BEHAVIORS) {
      // require_review is PARTIAL — still generate with review but mark known gap when behavior=review
      const govCaps = [
        `governance.protection.${action === 'remove' ? 'drop_field' : action}`,
        behavior === 'review' ? 'governance.delivery.require_review' : `governance.delivery.${behavior}`,
        'governance.sensitive_detection',
        'source.http_api_polling',
        'destination.webhook_post',
      ]
      // Map remove → drop_field capability exists
      const actionCap =
        action === 'remove' ? 'governance.protection.drop_field' : `governance.protection.${action}`
      const behaviorCap =
        behavior === 'review' ? 'governance.delivery.require_review' : `governance.delivery.${behavior}`

      const supportedAction = manifest.governance.find((g) => g.id === actionCap)
      const supportedBehavior = manifest.governance.find((g) => g.id === behaviorCap)

      if (!supportedAction || !isSupported(supportedAction)) {
        pushScenario(scenarios, {
          id: `governance__${action}__${behavior}__na`,
          suite: 'governance',
          executionMode: 'api_seeded',
          routeProcessing: 'on',
          capabilities: [actionCap, behaviorCap].filter(Boolean),
          fixture: `governance/${action}/${behavior}`,
          expectedStatus: 'NOT_IMPLEMENTED',
          reason: `Protection action capability not SUPPORTED: ${actionCap}`,
          tags: ['governance', 'shard:governance'],
          shard: 'governance',
          protectionAction: action,
          deliveryBehavior: behavior,
        })
        continue
      }

      const expected: E2EScenario['expectedStatus'] =
        supportedBehavior && !isSupported(supportedBehavior) ? 'NOT_IMPLEMENTED' : 'PASS'

      scenarios.push(
        ...withRouteVariants({
          idStem: `governance__${action}__${behavior}__api`,
          suite: 'governance',
          executionMode: 'api_seeded',
          routeProcessing: 'on',
          source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
          destination: { type: DEFAULT_DEST },
          capabilities: [
            actionCap,
            behaviorCap,
            'governance.sensitive_detection',
            'governance.audit_violations_notifications',
            'flag.gdc_protection_enabled',
            'flag.gdc_sensitive_detection_enabled',
            'source.http_api_polling',
            'destination.webhook_post',
          ],
          fixture: `governance/${action}/${behavior}`,
          expectedStatus: expected,
          reason:
            expected === 'NOT_IMPLEMENTED'
              ? `Delivery behavior ${behaviorCap} status=${supportedBehavior?.status}`
              : undefined,
          tags: ['governance', action, behavior, 'shard:governance'],
          shard: 'governance',
          protectionAction: action,
          deliveryBehavior: behavior,
        }),
      )
    }
  }

  // Quarantine + Replay browser
  for (const id of ['governance.quarantine_ops', 'governance.replay'] as const) {
    scenarios.push(
      ...withRouteVariants({
        idStem: `${slug(id)}__browser`,
        suite: 'governance',
        executionMode: 'browser',
        routeProcessing: 'on',
        source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
        destination: { type: DEFAULT_DEST },
        capabilities: [
          id,
          'governance.delivery.quarantine',
          'governance.protection.mask',
          'source.http_api_polling',
          'destination.webhook_post',
        ],
        fixture: `governance/${slug(id)}`,
        expectedStatus: 'PASS',
        tags: ['governance', 'browser', 'shard:governance'],
        shard: 'governance',
      }),
    )
  }

  // Remaining SUPPORTED governance caps without scenario yet
  for (const gov of manifest.governance.filter(isSupported)) {
    if (scenarios.some((s) => s.capabilities.includes(gov.id))) continue
    pushScenario(scenarios, {
      id: `governance__${slug(gov.id)}__api__route-on`,
      suite: 'governance',
      executionMode: 'api_seeded',
      routeProcessing: 'on',
      source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
      destination: { type: DEFAULT_DEST },
      capabilities: [gov.id, 'source.http_api_polling', 'destination.webhook_post'],
      fixture: `governance/${slug(gov.id)}`,
      expectedStatus: 'PASS',
      tags: ['governance', 'shard:governance'],
      shard: 'governance',
    })
  }
}

function buildRuntimeFault(manifest: Manifest, scenarios: E2EScenario[], na: NotApplicableRecord[]): void {
  for (const rt of manifest.runtime) {
    if (!isSupported(rt)) {
      pushScenario(scenarios, {
        id: `runtime__${slug(rt.id)}__${rt.status.toLowerCase()}`,
        suite: 'runtime',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [rt.id],
        fixture: `runtime/${slug(rt.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${rt.status}`,
        tags: ['runtime', rt.status.toLowerCase(), 'shard:runtime'],
        shard: 'runtime',
      })
      continue
    }
    if (scenarios.some((s) => s.capabilities.includes(rt.id))) continue
    pushScenario(scenarios, {
      id: `runtime__${slug(rt.id)}__api__route-on`,
      suite: 'runtime',
      executionMode: 'api_seeded',
      routeProcessing: 'on',
      source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
      destination: { type: DEFAULT_DEST },
      capabilities: [rt.id, 'source.http_api_polling', 'destination.webhook_post'],
      fixture: `runtime/${slug(rt.id)}`,
      expectedStatus: 'PASS',
      tags: ['runtime', 'shard:runtime'],
      shard: 'runtime',
    })
  }

  for (const fault of FAULT_TYPES) {
    const applicableSource =
      fault.startsWith('http_') || fault === 'malformed_response'
        ? 'HTTP_API_POLLING'
        : fault === 'db_disconnect'
          ? 'DATABASE_QUERY'
          : fault === 's3_unavailable'
            ? 'S3_OBJECT_POLLING'
            : fault === 'sftp_unavailable'
              ? 'REMOTE_FILE_POLLING'
              : DEFAULT_SOURCE

    const applicableDest =
      fault === 'webhook_destination_down'
        ? 'WEBHOOK_POST'
        : fault === 'syslog_destination_down' || fault === 'tls_certificate_error'
          ? 'SYSLOG_TLS'
          : DEFAULT_DEST

    if (fault === 'db_disconnect') {
      // applicable
    }

    scenarios.push(
      ...withRouteVariants({
        idStem: `fault__${fault}__api`,
        suite: 'fault',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        source: { type: applicableSource, authentication: defaultAuthForSource(applicableSource) },
        destination: { type: applicableDest },
        capabilities: [
          'runtime.retry_backoff',
          'runtime.timeout',
          'runtime.checkpoint_after_delivery',
          'runtime.health_metrics_audit_logs',
          'runtime.process_restart_recovery',
          sourceCapForType(applicableSource),
          destCapForType(applicableDest),
        ].filter(Boolean) as string[],
        fixture: `fault/${fault}`,
        expectedStatus: 'PASS',
        tags: ['fault', fault, 'shard:fault'],
        shard: 'fault',
        faultType: fault,
      }),
    )
  }

  // MySQL/MariaDB explicitly NOT_APPLICABLE
  na.push({
    combination: 'source × MySQL/MariaDB',
    reason: 'Product db_type is POSTGRESQL only; MySQL/MariaDB are lab fixtures, not product support',
    capabilities: ['source.database_query_postgresql'],
  })
}

function sourceCapForType(t: string): string {
  const entry = Object.entries(SOURCE_TYPE_MAP).find(([, v]) => v === t)
  return entry?.[0] ?? 'source.http_api_polling'
}

function destCapForType(t: string): string {
  const entry = Object.entries(DEST_TYPE_MAP).find(([, v]) => v === t)
  return entry?.[0] ?? 'destination.webhook_post'
}

function buildFlagsAndInfra(manifest: Manifest, scenarios: E2EScenario[]): void {
  for (const flag of manifest.feature_flags) {
    if (!isSupported(flag)) {
      pushScenario(scenarios, {
        id: `flag__${slug(flag.id)}__${flag.status.toLowerCase()}`,
        suite: 'runtime',
        executionMode: 'api_seeded',
        routeProcessing: 'on',
        capabilities: [flag.id],
        fixture: `flag/${slug(flag.id)}`,
        expectedStatus: 'NOT_IMPLEMENTED',
        reason: `Manifest status=${flag.status}`,
        tags: ['feature_flag', 'shard:runtime'],
        shard: 'runtime',
      })
      continue
    }
    if (scenarios.some((s) => s.capabilities.includes(flag.id))) continue
    pushScenario(scenarios, {
      id: `flag__${slug(flag.id)}__api__route-on`,
      suite: 'runtime',
      executionMode: 'api_seeded',
      routeProcessing: 'on',
      capabilities: [flag.id],
      fixture: `flag/${slug(flag.id)}`,
      expectedStatus: 'PASS',
      tags: ['feature_flag', 'shard:runtime'],
      shard: 'runtime',
    })
  }

  for (const ti of manifest.test_infrastructure) {
    if (!isSupported(ti)) {
      pushScenario(scenarios, {
        id: `testinfra__${slug(ti.id)}__${ti.status.toLowerCase()}`,
        suite: 'runtime',
        executionMode: ti.id.includes('playwright') ? 'browser' : 'api_seeded',
        routeProcessing: 'on',
        capabilities: [ti.id],
        fixture: `testinfra/${slug(ti.id)}`,
        expectedStatus: ti.status === 'PARTIAL' ? 'PASS' : 'NOT_IMPLEMENTED',
        reason: `Manifest status=${ti.status}`,
        tags: ['test_infrastructure', 'shard:runtime'],
        shard: 'runtime',
      })
      continue
    }
    if (scenarios.some((s) => s.capabilities.includes(ti.id))) continue
    pushScenario(scenarios, {
      id: `testinfra__${slug(ti.id)}__api__route-on`,
      suite: 'runtime',
      executionMode: 'api_seeded',
      routeProcessing: 'on',
      capabilities: [ti.id],
      fixture: `testinfra/${slug(ti.id)}`,
      expectedStatus: 'PASS',
      tags: ['test_infrastructure', 'shard:runtime'],
      shard: 'runtime',
    })
  }
}

function ensureSupportedCoverage(manifest: Manifest, scenarios: E2EScenario[]): void {
  const all = [
    ...manifest.authentication,
    ...manifest.sources,
    ...manifest.destinations,
    ...manifest.wizard,
    ...manifest.processing,
    ...manifest.routes,
    ...manifest.governance,
    ...manifest.runtime,
    ...manifest.feature_flags,
    ...manifest.test_infrastructure,
  ]
  for (const cap of all.filter(isSupported)) {
    if (scenarios.some((s) => s.capabilities.includes(cap.id))) continue
    pushScenario(scenarios, {
      id: `coverage__${slug(cap.id)}__api__route-on`,
      suite: 'runtime',
      executionMode: isTrue(cap.ui_supported) ? 'browser' : 'api_seeded',
      routeProcessing: 'on',
      source: { type: DEFAULT_SOURCE, authentication: DEFAULT_HTTP_AUTH },
      destination: { type: DEFAULT_DEST },
      capabilities: [cap.id],
      fixture: `coverage/${slug(cap.id)}`,
      expectedStatus: 'PASS',
      tags: ['coverage-gap-fill', 'shard:runtime'],
      shard: 'runtime',
    })
  }
}

function countBundle(scenarios: E2EScenario[], na: NotApplicableRecord[], commit?: string): MatrixBundle {
  const bySuite: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let browser = 0
  let api = 0
  let routeOff = 0
  let routeOn = 0
  let routeBoth = 0
  for (const s of scenarios) {
    bySuite[s.suite] = (bySuite[s.suite] || 0) + 1
    byStatus[s.expectedStatus] = (byStatus[s.expectedStatus] || 0) + 1
    if (s.executionMode === 'browser') browser++
    else api++
    if (s.routeProcessing === 'off') routeOff++
    else if (s.routeProcessing === 'on') routeOn++
    else routeBoth++
  }
  return {
    generated_at: new Date().toISOString(),
    manifest_commit: commit,
    scenarios,
    not_applicable: na,
    counts: {
      total: scenarios.length,
      browser,
      api_seeded: api,
      route_off: routeOff,
      route_on: routeOn,
      route_both: routeBoth,
      by_suite: bySuite,
      by_expected_status: byStatus,
    },
  }
}

function writeMatrix(name: string, scenarios: E2EScenario[], na: NotApplicableRecord[], commit?: string): void {
  const filteredNa = na.filter((n) => {
    // keep NA that relate to this matrix loosely via tags/suite in name
    return true
  })
  const bundle = countBundle(scenarios, filteredNa, commit)
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8')
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const manifest = loadManifest()
  const commit = String(manifest.metadata?.generated_from_commit || '')
  const scenarios: E2EScenario[] = []
  const na: NotApplicableRecord[] = []

  buildAuthentication(manifest, scenarios, na)
  buildSourceDestination(manifest, scenarios, na)
  buildProcessing(manifest, scenarios, na)
  buildWizard(manifest, scenarios)
  buildRoutes(manifest, scenarios)
  buildGovernance(manifest, scenarios)
  buildRuntimeFault(manifest, scenarios, na)
  buildFlagsAndInfra(manifest, scenarios)
  ensureSupportedCoverage(manifest, scenarios)

  // Deduplicate by id (keep first)
  const seen = new Set<string>()
  const unique: E2EScenario[] = []
  for (const s of scenarios) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    unique.push(s)
  }

  const auth = unique.filter((s) => s.suite === 'authentication')
  const srcdest = unique.filter((s) => s.suite === 'source' || s.suite === 'destination')
  const processing = unique.filter((s) => s.suite === 'processing' || s.suite === 'wizard')
  const governance = unique.filter((s) => s.suite === 'governance')
  const fault = unique.filter((s) => s.suite === 'fault' || s.suite === 'runtime')

  writeMatrix('authentication-matrix.json', auth, na.filter((n) => n.combination.includes('auth')), commit)
  writeMatrix('source-destination-matrix.json', srcdest, na.filter((n) => n.combination.includes('source') || n.combination.includes('MySQL')), commit)
  writeMatrix('processing-matrix.json', processing, na.filter((n) => n.combination.includes('wizard') || n.combination.includes('rare') || n.combination.includes('sensitive')), commit)
  writeMatrix('governance-matrix.json', governance, [], commit)
  writeMatrix('runtime-fault-matrix.json', fault, na, commit)
  writeMatrix('full-matrix.json', unique, na, commit)

  console.log(
    JSON.stringify(
      {
        ok: true,
        total: unique.length,
        browser: unique.filter((s) => s.executionMode === 'browser').length,
        api_seeded: unique.filter((s) => s.executionMode === 'api_seeded').length,
        route_off: unique.filter((s) => s.routeProcessing === 'off').length,
        route_on: unique.filter((s) => s.routeProcessing === 'on').length,
        not_applicable: na.length,
        by_suite: countBundle(unique, na).counts.by_suite,
      },
      null,
      2,
    ),
  )
}

main()
