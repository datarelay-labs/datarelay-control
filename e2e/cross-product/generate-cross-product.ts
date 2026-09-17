#!/usr/bin/env npx tsx
/**
 * Full Cross-Product generator (streaming JSONL).
 * Existing 332-scenario matrix is untouched.
 *
 * Expansion strategy (full valid product of free axes; dependent axes via bundles/rules):
 * 1) Transform composition product — all 16 mapping×timestamp×jsonata×regex activations
 * 2) Main chain product — all transforms ON × source×dest × route × protection×delivery × governance bundles × collection bundles
 * 3) Fault/recovery product — applicable faults × source×dest × surface × route × replay (fixed chain partners per R028)
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APPLICABILITY_RULES,
  BROWSER_SUPPORTED_TOPOLOGIES,
  DEST_AUTH_MATRIX,
  EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS,
  FAULT_DEST,
  FAULT_SOURCE,
  NOT_IMPLEMENTED_SCENARIO_IDS,
  ROUTE_ON_TOPOLOGIES,
  SOURCE_AUTH_MATRIX,
  capabilityIdsForAxes,
  deriveDependentAxes,
  evaluateApplicability,
} from './applicability-rules.js'
import {
  COLLECTION_BUNDLES,
  COMPOSITION_COLLECTION,
  COMPOSITION_GOVERNANCE,
  FAULT_CHAIN_COLLECTION,
  FAULT_CHAIN_GOVERNANCE,
  GOVERNANCE_BUNDLES,
  type CollectionBundle,
  type GovernanceBundle,
} from './governance-bundles.js'
import type {
  Activation,
  CrossProductAxes,
  DeliveryBehavior,
  DestinationType,
  ExecutionSurface,
  FaultType,
  GenerationSummary,
  NotApplicableCombination,
  NotImplementedCombination,
  ProtectionAction,
  RouteRuntime,
  RouteTopology,
  SourceType,
  ValidCombination,
} from './cross-product-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'generated')
const AXES_YAML = path.join(__dirname, 'cross-product-axes.yaml')
const RULES_TS = path.join(__dirname, 'applicability-rules.ts')
const NI_BASELINE = path.resolve(__dirname, '../release-gate/baseline/not-implemented-baseline.json')
const MANIFEST = path.resolve(__dirname, '../capabilities/data-relay-capabilities.yaml')

const ACTIVATIONS: Activation[] = ['OFF', 'ON']
const PROTECTIONS: ProtectionAction[] = ['audit', 'mask_partial', 'tokenize', 'hash', 'drop_field']
const DELIVERIES: DeliveryBehavior[] = ['continue', 'quarantine', 'block']
const SURFACES: ExecutionSurface[] = ['API_SEEDED', 'BROWSER']
const ROUTE_RUNTIMES: RouteRuntime[] = ['ROUTE_ON']
const GLOBAL_FAULTS: FaultType[] = ['api_restart', 'runtime_restart', 'partial_route_failure']

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function sha256Text(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function combinationIdFor(axes: CrossProductAxes): string {
  const keys = Object.keys(axes).sort() as (keyof CrossProductAxes)[]
  const normalized: Record<string, string> = {}
  for (const k of keys) normalized[k] = String(axes[k])
  return `xp_${sha256Text(JSON.stringify(normalized)).slice(0, 24)}`
}

function estimateCost(axes: CrossProductAxes): number {
  let c = 10
  if (axes.execution_surface === 'BROWSER') c += 40
  if (axes.fault_type !== 'NONE') c += 35
  if (axes.destination_type === 'SYSLOG_TLS') c += 15
  if (axes.route_topology !== 'SINGLE_ROUTE') c += 25
  if (axes.source_type === 'DATABASE_QUERY' || axes.source_type === 'S3_OBJECT_POLLING') c += 12
  if (axes.source_type === 'REMOTE_FILE_POLLING') c += 12
  if (axes.source_type === 'HTTP_API_POLLING') c += 8
  if (axes.replay_mode !== 'NONE') c += 20
  if (axes.failover_mode !== 'NONE') c += 20
  return c
}

function* sourceAuthPairs() {
  for (const source_type of Object.keys(SOURCE_AUTH_MATRIX) as SourceType[]) {
    for (const source_auth of SOURCE_AUTH_MATRIX[source_type]) {
      yield { source_type, source_auth }
    }
  }
}

function* destinationPairs() {
  for (const destination_type of Object.keys(DEST_AUTH_MATRIX) as DestinationType[]) {
    for (const destination_auth_protocol of DEST_AUTH_MATRIX[destination_type]) {
      yield { destination_type, destination_auth_protocol }
    }
  }
}

function topologiesFor(route_runtime: RouteRuntime): RouteTopology[] {
  return route_runtime === 'ROUTE_OFF' ? ['SINGLE_ROUTE'] : [...ROUTE_ON_TOPOLOGIES]
}

function faultsFor(source_type: SourceType, destination_type: DestinationType): FaultType[] {
  const out: FaultType[] = ['NONE']
  for (const [fault, sources] of Object.entries(FAULT_SOURCE) as [FaultType, SourceType[]][]) {
    if (sources.includes(source_type)) out.push(fault)
  }
  for (const [fault, dests] of Object.entries(FAULT_DEST) as [FaultType, DestinationType[]][]) {
    if (dests.includes(destination_type)) out.push(fault)
  }
  for (const g of GLOBAL_FAULTS) if (!out.includes(g)) out.push(g)
  return out
}

function* transformCombos() {
  for (const field_mapping of ACTIVATIONS) {
    for (const timestamp_normalization of ACTIVATIONS) {
      for (const jsonata of ACTIVATIONS) {
        for (const regex of ACTIVATIONS) {
          yield { field_mapping, timestamp_normalization, jsonata, regex }
        }
      }
    }
  }
}

function allOn(t: {
  field_mapping: Activation
  timestamp_normalization: Activation
  jsonata: Activation
  regex: Activation
}): boolean {
  return (
    t.field_mapping === 'ON' &&
    t.timestamp_normalization === 'ON' &&
    t.jsonata === 'ON' &&
    t.regex === 'ON'
  )
}

function collectionBundlesFor(source_type: SourceType): CollectionBundle[] {
  if (source_type === 'WEBHOOK_RECEIVER') {
    return COLLECTION_BUNDLES.filter((b) => b.incremental_fetch === 'OFF')
  }
  return COLLECTION_BUNDLES
}

type JsonlWriter = { write: (obj: unknown) => void; close: () => void; count: number }

function createJsonlWriter(filePath: string): JsonlWriter {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = fs.openSync(filePath, 'w')
  let count = 0
  return {
    get count() {
      return count
    },
    write(obj: unknown) {
      fs.writeSync(fd, `${JSON.stringify(obj)}\n`)
      count += 1
    },
    close() {
      fs.closeSync(fd)
    },
  }
}

function buildAxes(input: {
  execution_surface: ExecutionSurface
  route_runtime: RouteRuntime
  source_type: SourceType
  source_auth: CrossProductAxes['source_auth']
  destination_type: DestinationType
  destination_auth_protocol: CrossProductAxes['destination_auth_protocol']
  route_topology: RouteTopology
  transform: {
    field_mapping: Activation
    timestamp_normalization: Activation
    jsonata: Activation
    regex: Activation
  }
  protection_action: ProtectionAction
  delivery_behavior: DeliveryBehavior
  gov: GovernanceBundle
  coll: CollectionBundle
  fault_type: FaultType
  replay_mode: CrossProductAxes['replay_mode']
  failover_mode: CrossProductAxes['failover_mode']
}): CrossProductAxes {
  return deriveDependentAxes({
    execution_surface: input.execution_surface,
    route_runtime: input.route_runtime,
    source_type: input.source_type,
    source_auth: input.source_auth,
    destination_type: input.destination_type,
    destination_auth_protocol: input.destination_auth_protocol,
    route_topology: input.route_topology,
    ...input.transform,
    protection_action: input.protection_action,
    delivery_behavior: input.delivery_behavior,
    incremental_fetch: input.coll.incremental_fetch,
    dedup_strategy: input.coll.dedup_strategy,
    unknown_field_type: input.gov.unknown_field_type,
    unknown_field_policy: input.gov.unknown_field_policy,
    sensitive_detection_profile: input.gov.sensitive_detection_profile,
    classification_profile: input.gov.classification_profile,
    fault_type: input.fault_type,
    replay_mode: input.replay_mode,
    failover_mode: input.failover_mode,
  })
}

/** Streaming candidate iterator — three orthogonal full products, no pairwise sampling. */
export function* iterateCandidateAxes(): Generator<CrossProductAxes> {
  const fullTransform = {
    field_mapping: 'ON' as Activation,
    timestamp_normalization: 'ON' as Activation,
    jsonata: 'ON' as Activation,
    regex: 'ON' as Activation,
  }

  // --- Product 1: transform composition (all 16 activations) ---
  for (const transform of transformCombos()) {
    if (allOn(transform)) continue // covered by main/fault products
    for (const execution_surface of SURFACES) {
      for (const route_runtime of ROUTE_RUNTIMES) {
        yield buildAxes({
          execution_surface,
          route_runtime,
          source_type: 'HTTP_API_POLLING',
          source_auth: 'no_auth',
          destination_type: 'WEBHOOK_POST',
          destination_auth_protocol: 'NONE',
          route_topology: 'SINGLE_ROUTE',
          transform,
          protection_action: 'audit',
          delivery_behavior: 'continue',
          gov: COMPOSITION_GOVERNANCE,
          coll: COMPOSITION_COLLECTION,
          fault_type: 'NONE',
          replay_mode: 'NONE',
          failover_mode: 'NONE',
        })
      }
    }
  }

  // --- Product 2a: protection × delivery full cross on composite-chain baseline ---
  // (gov=GOV_SENSITIVE_AUTO, coll=COLL_DEDUP — complex chain partners)
  for (const execution_surface of SURFACES) {
    for (const route_runtime of ROUTE_RUNTIMES) {
      for (const { source_type, source_auth } of sourceAuthPairs()) {
        for (const { destination_type, destination_auth_protocol } of destinationPairs()) {
          for (const route_topology of topologiesFor(route_runtime)) {
            const failover_mode =
              route_topology === 'FAILOVER_ROUTE'
                ? ('FAILOVER_ON_DESTINATION_FAILURE' as const)
                : ('NONE' as const)
            for (const protection_action of PROTECTIONS) {
              for (const delivery_behavior of DELIVERIES) {
                yield buildAxes({
                  execution_surface,
                  route_runtime,
                  source_type,
                  source_auth,
                  destination_type,
                  destination_auth_protocol,
                  route_topology,
                  transform: fullTransform,
                  protection_action,
                  delivery_behavior,
                  gov: FAULT_CHAIN_GOVERNANCE,
                  coll: COMPOSITION_COLLECTION,
                  fault_type: 'NONE',
                  replay_mode: 'NONE',
                  failover_mode,
                })
              }
            }
          }
        }
      }
    }
  }

  // --- Product 2b: governance-bundle full cross (protection=audit, delivery=continue) ---
  for (const execution_surface of SURFACES) {
    for (const route_runtime of ROUTE_RUNTIMES) {
      for (const { source_type, source_auth } of sourceAuthPairs()) {
        for (const { destination_type, destination_auth_protocol } of destinationPairs()) {
          for (const route_topology of topologiesFor(route_runtime)) {
            const failover_mode =
              route_topology === 'FAILOVER_ROUTE'
                ? ('FAILOVER_ON_DESTINATION_FAILURE' as const)
                : ('NONE' as const)
            for (const gov of GOVERNANCE_BUNDLES) {
              yield buildAxes({
                execution_surface,
                route_runtime,
                source_type,
                source_auth,
                destination_type,
                destination_auth_protocol,
                route_topology,
                transform: fullTransform,
                protection_action: 'audit',
                delivery_behavior: 'continue',
                gov,
                coll: COMPOSITION_COLLECTION,
                fault_type: 'NONE',
                replay_mode: 'NONE',
                failover_mode,
              })
            }
          }
        }
      }
    }
  }

  // --- Product 2c: collection-bundle full cross (SINGLE_ROUTE, audit/continue, GOV_SENSITIVE_AUTO) ---
  for (const execution_surface of SURFACES) {
    for (const route_runtime of ROUTE_RUNTIMES) {
      for (const { source_type, source_auth } of sourceAuthPairs()) {
        for (const { destination_type, destination_auth_protocol } of destinationPairs()) {
          for (const coll of collectionBundlesFor(source_type)) {
            yield buildAxes({
              execution_surface,
              route_runtime,
              source_type,
              source_auth,
              destination_type,
              destination_auth_protocol,
              route_topology: 'SINGLE_ROUTE',
              transform: fullTransform,
              protection_action: 'audit',
              delivery_behavior: 'continue',
              gov: FAULT_CHAIN_GOVERNANCE,
              coll,
              fault_type: 'NONE',
              replay_mode: 'NONE',
              failover_mode: 'NONE',
            })
          }
        }
      }
    }
  }

  // --- Product 3: fault/recovery (fixed chain partners — R028) ---
  for (const execution_surface of SURFACES) {
    for (const route_runtime of ROUTE_RUNTIMES) {
      for (const { source_type, source_auth } of sourceAuthPairs()) {
        if (source_type === 'WEBHOOK_RECEIVER') {
          // incremental required by FAULT_CHAIN_COLLECTION — skip webhook for fault product
          continue
        }
        for (const { destination_type, destination_auth_protocol } of destinationPairs()) {
          for (const route_topology of topologiesFor(route_runtime)) {
            // Fault product uses SINGLE_ROUTE and FAILOVER_ROUTE only (checkpoint clarity)
            if (route_topology !== 'SINGLE_ROUTE' && route_topology !== 'FAILOVER_ROUTE') continue
            const failover_mode =
              route_topology === 'FAILOVER_ROUTE'
                ? ('FAILOVER_ON_DESTINATION_FAILURE' as const)
                : ('NONE' as const)
            for (const fault_type of faultsFor(source_type, destination_type)) {
              if (fault_type === 'NONE') continue
              for (const replay_mode of ['NONE', 'REPLAY_AFTER_RECOVERY'] as const) {
                yield buildAxes({
                  execution_surface,
                  route_runtime,
                  source_type,
                  source_auth,
                  destination_type,
                  destination_auth_protocol,
                  route_topology,
                  transform: fullTransform,
                  protection_action: 'audit',
                  delivery_behavior: 'continue',
                  gov: FAULT_CHAIN_GOVERNANCE,
                  coll: FAULT_CHAIN_COLLECTION,
                  fault_type,
                  replay_mode,
                  failover_mode,
                })
              }
            }
          }
        }
      }
    }
  }
}

export function generateCrossProduct(): GenerationSummary {
  fs.mkdirSync(OUT, { recursive: true })
  const validPath = path.join(OUT, 'valid-combinations.jsonl')
  const naPath = path.join(OUT, 'not-applicable.jsonl')
  const niCombPath = path.join(OUT, 'not-implemented-combinations.jsonl')
  const dupPath = path.join(OUT, 'duplicate-emissions.jsonl')
  const summaryPath = path.join(OUT, 'generation-summary.json')
  const niPath = path.join(OUT, 'not-implemented.json')

  const validWriter = createJsonlWriter(validPath)
  const naWriter = createJsonlWriter(naPath)
  const niCombWriter = createJsonlWriter(niCombPath)
  const dupWriter = createJsonlWriter(dupPath)

  const ni = JSON.parse(fs.readFileSync(NI_BASELINE, 'utf-8')) as { scenario_ids: string[] }
  if (ni.scenario_ids.length !== 20) {
    throw new Error(`NOT_IMPLEMENTED baseline must have 20 ids, got ${ni.scenario_ids.length}`)
  }
  for (const id of NOT_IMPLEMENTED_SCENARIO_IDS) {
    if (!ni.scenario_ids.includes(id)) throw new Error(`NOT_IMPLEMENTED set drift: missing ${id}`)
  }

  const idHasher = createHash('sha256')
  let emissions = 0
  let duplicateEmissions = 0
  let browser = 0
  let api = 0
  let routeOff = 0
  let routeOn = 0
  const bySource: Record<string, number> = {}
  const byDest: Record<string, number> = {}
  const byFault: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  /** First-seen classification per combination_id */
  const classified = new Map<string, 'VALID' | 'NOT_APPLICABLE' | 'NOT_IMPLEMENTED'>()

  for (const axes of iterateCandidateAxes()) {
    emissions += 1
    const rejection = evaluateApplicability(axes)
    const combination_id = combinationIdFor(axes)
    const prior = classified.get(combination_id)

    if (prior) {
      // Orthogonal products overlap on chain-baseline intersections — already classified.
      duplicateEmissions += 1
      dupWriter.write({
        combination_id,
        prior_status: prior,
        current_would_be: rejection ? 'NOT_APPLICABLE' : 'VALID',
        rule_id: rejection?.rule_id ?? null,
        axes,
        note: 'Duplicate emission from orthogonal product overlap; first classification retained',
      })
      continue
    }

    if (rejection) {
      const row: NotApplicableCombination = {
        combination_id,
        axes,
        rule_id: rejection.rule_id,
        reason: rejection.reason,
        capability_ids: rejection.capability_ids,
        evidence: rejection.evidence,
      }
      naWriter.write(row)
      classified.set(combination_id, 'NOT_APPLICABLE')
      byRule[rejection.rule_id] = (byRule[rejection.rule_id] || 0) + 1
      continue
    }

    // NOT_IMPLEMENTED cross-product combinations: none — NI capabilities are axis-excluded (R021).
    // Reserved path for future explicit NI classification of generated tuples.
    const niCombo: NotImplementedCombination | null = null
    if (niCombo) {
      niCombWriter.write(niCombo)
      classified.set(combination_id, 'NOT_IMPLEMENTED')
      continue
    }

    classified.set(combination_id, 'VALID')
    idHasher.update(`${combination_id}\n`)

    const row: ValidCombination = {
      combination_id,
      axes,
      capability_ids: capabilityIdsForAxes(axes),
      expected_status: 'PASS',
      browser_supported:
        axes.execution_surface !== 'BROWSER' || BROWSER_SUPPORTED_TOPOLOGIES.has(axes.route_topology),
      estimated_cost: estimateCost(axes),
    }
    validWriter.write(row)

    if (axes.execution_surface === 'BROWSER') browser += 1
    else api += 1
    if (axes.route_runtime === 'ROUTE_OFF') routeOff += 1
    else routeOn += 1
    bySource[axes.source_type] = (bySource[axes.source_type] || 0) + 1
    byDest[axes.destination_type] = (byDest[axes.destination_type] || 0) + 1
    byFault[axes.fault_type] = (byFault[axes.fault_type] || 0) + 1

    if (emissions % 50000 === 0) {
      console.error(
        `progress emissions=${emissions} unique=${classified.size} valid=${validWriter.count} na=${naWriter.count}`,
      )
    }
  }

  validWriter.close()
  naWriter.close()
  niCombWriter.close()
  dupWriter.close()

  const candidates = classified.size
  const notImplementedCombinations = niCombWriter.count
  const classificationEquationOk =
    candidates === validWriter.count + naWriter.count + notImplementedCombinations

  const summary: GenerationSummary = {
    generated_at: new Date().toISOString(),
    manifest_hash: sha256File(MANIFEST),
    applicability_rules_hash: sha256File(RULES_TS),
    axes_hash: sha256File(AXES_YAML),
    candidate_combinations: candidates,
    candidate_emissions: emissions,
    duplicate_emissions: duplicateEmissions,
    valid_combinations: validWriter.count,
    not_applicable_combinations: naWriter.count,
    not_implemented_combinations: notImplementedCombinations,
    not_implemented_capability_ids: [...EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS].sort(),
    not_implemented_scenario_ids: [...NOT_IMPLEMENTED_SCENARIO_IDS],
    browser_combinations: browser,
    api_combinations: api,
    route_off_combinations: routeOff,
    route_on_combinations: routeOn,
    by_source: bySource,
    by_destination: byDest,
    by_fault: byFault,
    by_rule_reject: byRule,
    combination_id_set_hash: idHasher.digest('hex'),
    classification_equation_ok: classificationEquationOk,
    deterministic: true,
  }

  if (!classificationEquationOk) {
    throw new Error(
      `Classification equation failed: candidates(${candidates}) != valid(${validWriter.count}) + NA(${naWriter.count}) + NI(${notImplementedCombinations})`,
    )
  }

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(
    niPath,
    `${JSON.stringify(
      {
        count: 20,
        scenario_ids: [...NOT_IMPLEMENTED_SCENARIO_IDS],
        excluded_capability_ids: [...EXCLUDED_FROM_PRODUCT_CAPABILITY_IDS].sort(),
        not_implemented_combinations: notImplementedCombinations,
        note: 'Frozen from release-gate not-implemented-baseline.json — must not change. Cross-product NI combinations are axis-excluded (R021); count is 0.',
      },
      null,
      2,
    )}\n`,
  )
  fs.writeFileSync(
    path.join(OUT, 'applicability-rule-catalog.json'),
    `${JSON.stringify(
      APPLICABILITY_RULES.map((r) => ({
        rule_id: r.rule_id,
        description: r.description,
        capability_ids: r.capability_ids,
        evidence: r.evidence,
      })),
      null,
      2,
    )}\n`,
  )
  fs.writeFileSync(
    path.join(OUT, 'classification-audit.json'),
    `${JSON.stringify(
      {
        equation: 'candidates = valid + not_applicable + not_implemented_combinations',
        candidates,
        valid: validWriter.count,
        not_applicable: naWriter.count,
        not_implemented_combinations: notImplementedCombinations,
        candidate_emissions: emissions,
        duplicate_emissions: duplicateEmissions,
        equation_ok: classificationEquationOk,
        note:
          'Previously reported 1,425 gap was duplicate VALID emissions from orthogonal product overlap, not a third unclassified status.',
      },
      null,
      2,
    )}\n`,
  )

  console.log(
    JSON.stringify(
      {
        candidates: summary.candidate_combinations,
        valid: summary.valid_combinations,
        not_applicable: summary.not_applicable_combinations,
        not_implemented_combinations: summary.not_implemented_combinations,
        candidate_emissions: summary.candidate_emissions,
        duplicate_emissions: summary.duplicate_emissions,
        classification_equation_ok: summary.classification_equation_ok,
        browser: summary.browser_combinations,
        api: summary.api_combinations,
        route_off: summary.route_off_combinations,
        route_on: summary.route_on_combinations,
        combination_id_set_hash: summary.combination_id_set_hash,
        by_rule_reject: summary.by_rule_reject,
      },
      null,
      2,
    ),
  )
  return summary
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    process.argv[1].endsWith('generate-cross-product.ts'))

if (isMain) {
  generateCrossProduct()
}
