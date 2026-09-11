/**
 * Per-run registry of Full E2E Lab created resources.
 * Writes e2e/reports/<run-id>/created-resources.json
 *
 * Cleanup must use recorded IDs — never name-prefix bulk delete alone.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const E2E_ROOT = path.resolve(__dirname, '..')
export const REPORTS_ROOT = path.join(E2E_ROOT, 'reports')

export type ResourceKind =
  | 'connector'
  | 'source'
  | 'stream'
  | 'route'
  | 'destination'
  | 'checkpoint'
  | 'dedup_key'
  | 'quarantine'
  | 'correlation'
  | 'mapping'
  | 'enrichment'
  | 'governance'

/** Ephemeral Full E2E vs Continuous Lab ownership — cleanup is ownership-scoped. */
export type ResourceOwnership = 'full-e2e-lab' | 'continuous-e2e-lab'

export type CreatedResourceRecord = {
  kind: ResourceKind
  id?: number | string
  name?: string
  scenarioId?: string
  createdAt: string
  ownership: ResourceOwnership
  /** Lifecycle hint; continuous resources must not be removed by ephemeral cleanup. */
  lifecycle?: 'ephemeral' | 'continuous'
  meta?: Record<string, unknown>
}

export type CreatedResourcesFile = {
  runId: string
  ownership: ResourceOwnership
  updatedAt: string
  resources: CreatedResourceRecord[]
}

export function reportDir(runId: string): string {
  return path.join(REPORTS_ROOT, runId)
}

export function createdResourcesPath(runId: string): string {
  return path.join(reportDir(runId), 'created-resources.json')
}

export function loadCreatedResources(runId: string): CreatedResourcesFile | null {
  const p = createdResourcesPath(runId)
  if (!fs.existsSync(p)) return null
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CreatedResourcesFile
  } catch {
    return null
  }
}

export function emptyRegistry(
  runId: string,
  ownership: ResourceOwnership = 'full-e2e-lab',
): CreatedResourcesFile {
  return {
    runId,
    ownership,
    updatedAt: new Date().toISOString(),
    resources: [],
  }
}

export function saveCreatedResources(file: CreatedResourcesFile): string {
  const dir = reportDir(file.runId)
  fs.mkdirSync(dir, { recursive: true })
  file.updatedAt = new Date().toISOString()
  const p = createdResourcesPath(file.runId)
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, p)
  return p
}

/** Merge unique resources by kind+id (+ name for id-less correlation records). */
export function mergeResources(
  base: CreatedResourceRecord[],
  extra: CreatedResourceRecord[],
): CreatedResourceRecord[] {
  const key = (r: CreatedResourceRecord) =>
    `${r.kind}:${r.id ?? ''}:${r.name ?? ''}:${r.scenarioId ?? ''}`
  const map = new Map<string, CreatedResourceRecord>()
  for (const r of [...base, ...extra]) {
    map.set(key(r), r)
  }
  return [...map.values()]
}

export class ResourceRegistry {
  private file: CreatedResourcesFile
  private dirty = false

  constructor(
    readonly runId: string,
    readonly scenarioId?: string,
    readonly ownership: ResourceOwnership = 'full-e2e-lab',
  ) {
    const existing = loadCreatedResources(runId)
    this.file = existing ?? emptyRegistry(runId, ownership)
    if (existing && existing.ownership !== ownership) {
      throw new Error(
        `registry ownership mismatch for ${runId}: file=${existing.ownership} requested=${ownership}`,
      )
    }
  }

  get path(): string {
    return createdResourcesPath(this.runId)
  }

  get snapshot(): CreatedResourcesFile {
    return {
      ...this.file,
      resources: [...this.file.resources],
    }
  }

  track(partial: Omit<CreatedResourceRecord, 'createdAt' | 'ownership'> & { createdAt?: string }): void {
    const record: CreatedResourceRecord = {
      ...partial,
      scenarioId: partial.scenarioId ?? this.scenarioId,
      createdAt: partial.createdAt ?? new Date().toISOString(),
      ownership: this.ownership,
      lifecycle: this.ownership === 'continuous-e2e-lab' ? 'continuous' : 'ephemeral',
    }
    this.file.resources = mergeResources(this.file.resources, [record])
    this.dirty = true
    this.flush()
  }

  trackConnector(opts: { connectorId: number; sourceId?: number; name?: string; scenarioId?: string }): void {
    this.track({ kind: 'connector', id: opts.connectorId, name: opts.name, scenarioId: opts.scenarioId })
    if (opts.sourceId) {
      this.track({
        kind: 'source',
        id: opts.sourceId,
        name: opts.name,
        scenarioId: opts.scenarioId,
        meta: { connector_id: opts.connectorId },
      })
    }
  }

  trackDestination(opts: { destinationId: number; name?: string; scenarioId?: string }): void {
    this.track({ kind: 'destination', id: opts.destinationId, name: opts.name, scenarioId: opts.scenarioId })
  }

  trackStream(opts: {
    streamId: number
    name?: string
    routeIds?: number[]
    scenarioId?: string
  }): void {
    this.track({ kind: 'stream', id: opts.streamId, name: opts.name, scenarioId: opts.scenarioId })
    for (const routeId of opts.routeIds || []) {
      this.track({
        kind: 'route',
        id: routeId,
        scenarioId: opts.scenarioId,
        meta: { stream_id: opts.streamId },
      })
    }
    // Stream delete removes checkpoint/dedup/mapping/enrichment; track for validate visibility.
    this.track({
      kind: 'checkpoint',
      id: opts.streamId,
      scenarioId: opts.scenarioId,
      meta: { stream_id: opts.streamId },
    })
    this.track({
      kind: 'dedup_key',
      id: opts.streamId,
      scenarioId: opts.scenarioId,
      meta: { stream_id: opts.streamId },
    })
  }

  trackCorrelation(correlationId: string | string[], scenarioId?: string): void {
    const ids = Array.isArray(correlationId) ? correlationId : [correlationId]
    for (const id of ids) {
      this.track({ kind: 'correlation', id, scenarioId })
    }
  }

  trackQuarantine(itemId: number | string, scenarioId?: string): void {
    this.track({ kind: 'quarantine', id: itemId, scenarioId })
  }

  flush(): string {
    if (!this.dirty && fs.existsSync(this.path)) return this.path
    // Reload+merge to cooperate across sequential scenarios in one run.
    const onDisk = loadCreatedResources(this.runId)
    if (onDisk) {
      this.file.resources = mergeResources(onDisk.resources, this.file.resources)
    }
    const p = saveCreatedResources(this.file)
    this.dirty = false
    return p
  }
}

/** List run ids that have a created-resources.json with full-e2e-lab ownership. */
export function listOwnedRunIds(reportsRoot = REPORTS_ROOT): string[] {
  return listOwnedRunIdsByOwnership('full-e2e-lab', reportsRoot)
}

/** Continuous Lab registries — never returned by ephemeral cleanup helpers. */
export function listContinuousOwnedRunIds(reportsRoot = REPORTS_ROOT): string[] {
  return listOwnedRunIdsByOwnership('continuous-e2e-lab', reportsRoot)
}

export function listOwnedRunIdsByOwnership(
  ownership: ResourceOwnership,
  reportsRoot = REPORTS_ROOT,
): string[] {
  if (!fs.existsSync(reportsRoot)) return []
  return fs
    .readdirSync(reportsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const f = loadCreatedResources(name)
      return f?.ownership === ownership && (f.resources?.length ?? 0) > 0
    })
    .sort()
}
