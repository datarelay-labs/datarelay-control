import { fetchConnectorById } from '../api/gdcConnectors'
import { fetchStreamMappingUiConfig } from '../api/gdcRuntime'
import { fetchStreamById } from '../api/gdcStreams'
import { runConnectorAuthTest, runHttpApiTest, type HttpApiTestResponse } from '../api/gdcRuntimePreview'
import type { MappingUIConfigResponse, StreamRead } from '../api/types/gdcApi'
import { wizardExtractEvents } from '../components/streams/wizard/wizard-json-extract'
import { buildStreamHttpConfigFromStreamRead, connectorBaseUrlFromMappingUi } from './streamHttpConfigFromStreamRead'
import { normalizeGdcStreamSourceType, type GdcStreamSourceTypeKey } from './sourceTypePresentation'
import { buildRepresentativeEventFromUnionSchema, unionSchemaFromExtractedEvents, unionSchemaFromStreamConfig, type UnionSchema } from './unionSchema'

export type MappingSourceSampleResult = {
  ok: boolean
  sourceType: GdcStreamSourceTypeKey
  /** Full raw payload for tree + backend preview (HTTP body, row array, webhook sample, etc.). */
  rawPayload: unknown
  /** Document shown in JSON tree (object wrapper when needed). */
  treeDocument: Record<string, unknown>
  extractedEvents: Array<Record<string, unknown>>
  unionSchema: UnionSchema | null
  eventArrayPath: string
  eventRootPath: string
  sampleEventIndex: number
  message: string | null
  recordsLabel: string
  fetchedAt: string
}

export function wrapTreeDocument(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  if (Array.isArray(raw)) return { data: raw }
  return { value: raw }
}

function treeDocumentFromExtracted(
  extracted: Array<Record<string, unknown>>,
  rawPayload: unknown,
): Record<string, unknown> {
  const unionSchema = unionSchemaFromExtractedEvents(extracted)
  if (unionSchema) return buildRepresentativeEventFromUnionSchema(unionSchema)
  const first = extracted[0]
  if (first) return first
  return wrapTreeDocument(rawPayload)
}

function applyPersistedUnionSchema(stream: StreamRead, result: MappingSourceSampleResult): MappingSourceSampleResult {
  const persisted = unionSchemaFromStreamConfig(stream.config_json as Record<string, unknown> | undefined)
  if (!persisted) return result
  return {
    ...result,
    unionSchema: persisted,
    treeDocument: buildRepresentativeEventFromUnionSchema(persisted),
  }
}

function pickWebhookSample(
  sourceConfig: Record<string, unknown>,
): { sample: unknown; error: string | null } {
  const sp = sourceConfig.sample_payload
  if (sp !== undefined && sp !== null) return { sample: sp, error: null }
  const raw = sourceConfig.raw_sample_payload
  if (raw !== undefined && raw !== null) return { sample: raw, error: null }

  const preview = sourceConfig.payload_preview
  if (preview === undefined || preview === null) return { sample: null, error: null }
  if (typeof preview !== 'string') return { sample: preview, error: null }

  const text = preview.trim()
  if (!text) return { sample: null, error: null }
  try {
    return { sample: JSON.parse(text), error: null }
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length > 1) {
      try {
        return { sample: lines.map((line) => JSON.parse(line)), error: null }
      } catch {
        // Fall through to an actionable validation error.
      }
    }
    return { sample: null, error: 'Saved webhook payload preview is not valid JSON or NDJSON.' }
  }
}

function eventPathsFromCfg(cfg: MappingUIConfigResponse): { eventArrayPath: string; eventRootPath: string } {
  const m = cfg.mapping
  return {
    eventArrayPath: String(m?.event_array_path ?? '').trim(),
    eventRootPath: String(m?.event_root_path ?? '').trim(),
  }
}

function buildHttpTestPayload(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
  connectorId: number | null,
): Parameters<typeof runHttpApiTest>[0] {
  const streamCfg = buildStreamHttpConfigFromStreamRead(stream, cfg)
  const baseUrl = connectorBaseUrlFromMappingUi(stream, cfg)
  return {
    connector_id: connectorId ?? undefined,
    source_config: connectorId != null ? {} : { base_url: baseUrl },
    stream_config: streamCfg,
    checkpoint: null,
    fetch_sample: true,
  }
}

async function fetchViaHttpApiTest(
  stream: StreamRead,
  cfg: MappingUIConfigResponse,
  connectorId: number | null,
  eventArrayPath: string,
  eventRootPath: string,
): Promise<MappingSourceSampleResult> {
  const sourceType = normalizeGdcStreamSourceType(cfg.source_type ?? stream.stream_type)
  const res: HttpApiTestResponse = await runHttpApiTest(buildHttpTestPayload(stream, cfg, connectorId))
  const fetchedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

  if (!res.ok) {
    return {
      ok: false,
      sourceType,
      rawPayload: null,
      treeDocument: {},
      extractedEvents: [],
      unionSchema: null,
      eventArrayPath,
      eventRootPath,
      sampleEventIndex: 0,
      message: res.message ?? res.error_type ?? 'Sample fetch failed',
      recordsLabel: '—',
      fetchedAt,
    }
  }

  const dbRows = res.database_query_sample_rows
  if (dbRows?.length) {
    const rawPayload = dbRows
    const extracted = wizardExtractEvents(rawPayload, eventArrayPath, eventRootPath)
    return {
      ok: true,
      sourceType,
      rawPayload,
      treeDocument: treeDocumentFromExtracted(extracted, rawPayload),
      extractedEvents: extracted,
      unionSchema: unionSchemaFromExtractedEvents(extracted),
      eventArrayPath,
      eventRootPath,
      sampleEventIndex: 0,
      message: null,
      recordsLabel: `${dbRows.length} row(s)`,
      fetchedAt,
    }
  }

  const parsed = res.response?.parsed_json ?? null
  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      sourceType,
      rawPayload: null,
      treeDocument: {},
      extractedEvents: [],
      unionSchema: null,
      eventArrayPath,
      eventRootPath,
      sampleEventIndex: 0,
      message: 'Sample returned empty or non-JSON payload.',
      recordsLabel: '—',
      fetchedAt,
    }
  }

  const rawPayload = parsed
  const extracted = wizardExtractEvents(rawPayload, eventArrayPath, eventRootPath)
  const sum = res.analysis?.response_summary
  const recordsLabel =
    sum?.approx_size_bytes != null
      ? `${sum.approx_size_bytes} B JSON`
      : Array.isArray(parsed)
        ? `${parsed.length} item(s)`
        : 'parsed response'

  return {
    ok: true,
    sourceType,
    rawPayload,
    treeDocument: treeDocumentFromExtracted(extracted, rawPayload),
    extractedEvents: extracted,
    unionSchema: unionSchemaFromExtractedEvents(extracted),
    eventArrayPath,
    eventRootPath,
    sampleEventIndex: 0,
    message: null,
    recordsLabel,
    fetchedAt,
  }
}

/**
 * Load a source sample for Mapping UI using the same preview APIs as API Test / wizard.
 * Supports HTTP_API_POLLING, DATABASE_QUERY, S3_OBJECT_POLLING, REMOTE_FILE_POLLING, WEBHOOK_RECEIVER.
 */
export async function fetchMappingSourceSample(streamId: number): Promise<MappingSourceSampleResult | null> {
  const [stream, cfg] = await Promise.all([fetchStreamById(streamId), fetchStreamMappingUiConfig(streamId)])
  if (!stream || !cfg) return null

  const sourceType = normalizeGdcStreamSourceType(cfg.source_type ?? stream.stream_type)
  const { eventArrayPath, eventRootPath } = eventPathsFromCfg(cfg)
  const connectorId = typeof stream.connector_id === 'number' ? stream.connector_id : null
  const fetchedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

  if (sourceType === 'WEBHOOK_RECEIVER') {
    const picked = pickWebhookSample(cfg.source_config ?? {})
    if (picked.error) {
      return {
        ok: false,
        sourceType,
        rawPayload: null,
        treeDocument: {},
        extractedEvents: [],
        unionSchema: null,
        eventArrayPath,
        eventRootPath,
        sampleEventIndex: 0,
        message: picked.error,
        recordsLabel: '—',
        fetchedAt,
      }
    }
    const sample = picked.sample
    if (sample === null) {
      return {
        ok: false,
        sourceType,
        rawPayload: null,
        treeDocument: {},
        extractedEvents: [],
        unionSchema: null,
        eventArrayPath,
        eventRootPath,
        sampleEventIndex: 0,
        message: 'No webhook sample payload configured on the source. Add a payload preview in Connector settings.',
        recordsLabel: '—',
        fetchedAt,
      }
    }
    const extracted = wizardExtractEvents(sample, eventArrayPath, eventRootPath)
    return applyPersistedUnionSchema(stream, {
      ok: true,
      sourceType,
      rawPayload: sample,
      treeDocument: treeDocumentFromExtracted(extracted, sample),
      extractedEvents: extracted,
      unionSchema: unionSchemaFromExtractedEvents(extracted),
      eventArrayPath,
      eventRootPath,
      sampleEventIndex: 0,
      message: null,
      recordsLabel: 'webhook sample payload',
      fetchedAt,
    })
  }

  if (sourceType === 'S3_OBJECT_POLLING' && connectorId != null) {
    const probe = await runConnectorAuthTest({ connector_id: connectorId, method: 'GET', test_path: '/' })
    if (!probe.ok) {
      return {
        ok: false,
        sourceType,
        rawPayload: null,
        treeDocument: {},
        extractedEvents: [],
      unionSchema: null,
        eventArrayPath,
        eventRootPath,
        sampleEventIndex: 0,
        message: probe.message ?? 'S3 connectivity probe failed',
        recordsLabel: '—',
        fetchedAt,
      }
    }
  }

  if (sourceType === 'REMOTE_FILE_POLLING' && connectorId != null) {
    const sc = cfg.source_config ?? {}
    const streamCfg = (stream.config_json ?? {}) as Record<string, unknown>
    const remoteDirectory = String(streamCfg.remote_directory ?? sc.remote_directory ?? '').trim()
    const filePattern = String(streamCfg.file_pattern ?? sc.file_pattern ?? '*').trim() || '*'
    const recursive = Boolean(streamCfg.recursive ?? sc.recursive ?? false)
    if (!remoteDirectory) {
      return {
        ok: false,
        sourceType,
        rawPayload: null,
        treeDocument: {},
        extractedEvents: [],
      unionSchema: null,
        eventArrayPath,
        eventRootPath,
        sampleEventIndex: 0,
        message: 'remote_directory is required on the stream before fetching a remote file sample.',
        recordsLabel: '—',
        fetchedAt,
      }
    }
    const probe = await runConnectorAuthTest({
      connector_id: connectorId,
      method: 'GET',
      test_path: '/',
      remote_file_stream_config: {
        remote_directory: remoteDirectory,
        file_pattern: filePattern,
        recursive,
      },
    })
    if (!probe.ok) {
      return {
        ok: false,
        sourceType,
        rawPayload: null,
        treeDocument: {},
        extractedEvents: [],
      unionSchema: null,
        eventArrayPath,
        eventRootPath,
        sampleEventIndex: 0,
        message: probe.message ?? 'Remote file probe failed',
        recordsLabel: '—',
        fetchedAt,
      }
    }
  }

  return applyPersistedUnionSchema(stream, await fetchViaHttpApiTest(stream, cfg, connectorId, eventArrayPath, eventRootPath))
}

export async function loadMappingWorkspaceContext(streamId: number): Promise<{
  stream: StreamRead
  cfg: MappingUIConfigResponse
  connectorName: string
  sample: MappingSourceSampleResult
} | null> {
  const [stream, cfg] = await Promise.all([fetchStreamById(streamId), fetchStreamMappingUiConfig(streamId)])
  if (!stream || !cfg) return null
  let connectorName = '—'
  const cid = typeof stream.connector_id === 'number' ? stream.connector_id : null
  if (cid != null) {
    const c = await fetchConnectorById(cid)
    if (c?.name) connectorName = c.name
  }
  const sample = (await fetchMappingSourceSample(streamId)) ?? {
    ok: false,
    sourceType: normalizeGdcStreamSourceType(cfg.source_type),
    rawPayload: null,
    treeDocument: {},
    extractedEvents: [],
    unionSchema: unionSchemaFromStreamConfig(stream.config_json as Record<string, unknown> | undefined),
    eventArrayPath: String(cfg.mapping?.event_array_path ?? '').trim(),
    eventRootPath: String(cfg.mapping?.event_root_path ?? '').trim(),
    sampleEventIndex: 0,
    message: 'Could not load source sample.',
    recordsLabel: '—',
    fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  return { stream, cfg, connectorName, sample }
}
