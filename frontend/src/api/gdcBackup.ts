import { requestBlob, requestJson, resolveApiBaseUrl, safeRequestJsonResult } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

export type ImportMode = 'additive' | 'clone' | 'full_restore'

export type ImportPreviewCounts = {
  connectors: number
  sources: number
  streams: number
  mappings: number
  enrichments: number
  destinations: number
  routes: number
  checkpoints: number
}

export type ImportPreviewConflict = {
  code: string
  message: string
  details?: Record<string, unknown> | null
}

export type ImportPreviewWarning = {
  code: string
  message: string
}

export type FullRestorePurgePreview = {
  connectors: number
  sources: number
  streams: number
  mappings: number
  enrichments: number
  destinations: number
  routes: number
  checkpoints: number
  backfill_jobs: number
  continuous_validations: number
}

export type ImportPreviewResult = {
  ok: boolean
  export_kind: string | null
  counts: ImportPreviewCounts
  conflicts: ImportPreviewConflict[]
  warnings: ImportPreviewWarning[]
  unsupported_items: string[]
  full_restore_purge?: FullRestorePurgePreview | null
  preview_token: string
}

export type ImportApplyResult = {
  ok: boolean
  created: {
    connector_ids: number[]
    source_ids: number[]
    stream_ids: number[]
    destination_ids: number[]
  }
  replaced?: FullRestorePurgePreview | null
  redirect_path: string | null
  idempotency_key?: string | null
  idempotent_replay?: boolean
}

export type CloneBackupResponse = {
  connector_id: number
  stream_ids: number[]
  redirect_path: string
}

function exportPath(path: string): string {
  return `${resolveApiBaseUrl()}${GDC_API_PREFIX}${path}`
}

export function buildConnectorExportPath(
  connectorId: number,
  opts: {
    include_streams?: boolean
    include_routes?: boolean
    include_checkpoints?: boolean
    include_destinations?: boolean
  } = {},
): string {
  const q = new URLSearchParams()
  if (opts.include_streams === false) q.set('include_streams', 'false')
  if (opts.include_routes === false) q.set('include_routes', 'false')
  if (opts.include_checkpoints === false) q.set('include_checkpoints', 'false')
  if (opts.include_destinations === true) q.set('include_destinations', 'true')
  const qs = q.toString()
  return exportPath(`/backup/connectors/${connectorId}/export${qs ? `?${qs}` : ''}`)
}

export function buildStreamExportPath(
  streamId: number,
  opts: { include_routes?: boolean; include_checkpoints?: boolean; include_destinations?: boolean } = {},
): string {
  const q = new URLSearchParams()
  if (opts.include_routes === false) q.set('include_routes', 'false')
  if (opts.include_checkpoints === false) q.set('include_checkpoints', 'false')
  if (opts.include_destinations === true) q.set('include_destinations', 'true')
  const qs = q.toString()
  return exportPath(`/backup/streams/${streamId}/export${qs ? `?${qs}` : ''}`)
}

export function buildWorkspaceExportPath(opts: { include_checkpoints?: boolean; include_destinations?: boolean } = {}): string {
  const q = new URLSearchParams()
  if (opts.include_checkpoints === false) q.set('include_checkpoints', 'false')
  if (opts.include_destinations === false) q.set('include_destinations', 'false')
  const qs = q.toString()
  return exportPath(`/backup/workspace/export${qs ? `?${qs}` : ''}`)
}

/** Extract ``/api/v1/...`` path from a full export URL built by ``build*ExportPath``. */
function exportUrlToApiPath(url: string): string {
  const marker = '/api/v1/'
  const idx = url.indexOf(marker)
  if (idx >= 0) return url.slice(idx)
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

export async function downloadBackupUrl(url: string, filename: string): Promise<void> {
  const path = exportUrlToApiPath(url)
  const { blob, filename: fromHeader } = await requestBlob(path, { method: 'GET' })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = fromHeader ?? filename
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(href)
}

export async function postImportPreview(bundle: unknown, mode: ImportMode): Promise<ImportPreviewResult> {
  return requestJson<ImportPreviewResult>(`${GDC_API_PREFIX}/backup/import/preview`, {
    method: 'POST',
    body: JSON.stringify({ bundle, mode }),
  })
}

export async function postImportApply(
  bundle: unknown,
  mode: ImportMode,
  previewToken: string,
  opts: {
    confirm?: boolean
    confirm_destructive?: boolean
    clone_name_suffix?: string
    idempotency_key?: string
  } = {},
): Promise<ImportApplyResult> {
  return requestJson<ImportApplyResult>(`${GDC_API_PREFIX}/backup/import/apply`, {
    method: 'POST',
    body: JSON.stringify({
      bundle,
      mode,
      preview_token: previewToken,
      confirm: opts.confirm ?? true,
      confirm_destructive: opts.confirm_destructive ?? false,
      clone_name_suffix: opts.clone_name_suffix ?? ' (copy)',
      ...(opts.idempotency_key ? { idempotency_key: opts.idempotency_key } : {}),
    }),
  })
}

export async function postCloneConnector(connectorId: number, nameSuffix?: string): Promise<CloneBackupResponse> {
  return requestJson<CloneBackupResponse>(`${GDC_API_PREFIX}/backup/connectors/${connectorId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ name_suffix: nameSuffix ?? ' (copy)' }),
  })
}

export async function postCloneStream(streamId: number, nameSuffix?: string): Promise<CloneBackupResponse> {
  return requestJson<CloneBackupResponse>(`${GDC_API_PREFIX}/backup/streams/${streamId}/clone`, {
    method: 'POST',
    body: JSON.stringify({ name_suffix: nameSuffix ?? ' (copy)' }),
  })
}

export type CurlImportDraft = {
  draft_kind: string
  connector: Record<string, unknown>
  source_config_json: Record<string, unknown>
  stream: {
    name: string
    stream_type: string
    enabled: boolean
    status: string
    config_json: Record<string, unknown>
    polling_interval: number
  }
  parsed: Record<string, unknown>
  warnings: string[]
  parse_errors: string[]
  secrets_included: boolean
}

export type CurlParseResult = {
  ok: boolean
  draft: CurlImportDraft | null
  warnings: string[]
  parse_errors: string[]
}

export type PostmanRequestSummary = {
  item_id: string
  name: string
  folder_path: string
  method: string
  url_preview: string
}

export type PostmanParseResult = {
  ok: boolean
  items: PostmanRequestSummary[]
  draft: CurlImportDraft | null
  warnings: string[]
  parse_errors: string[]
}

export async function postCurlParse(curlCommand: string, connectorName?: string): Promise<CurlParseResult> {
  const res = await safeRequestJsonResult<CurlParseResult>(`${GDC_API_PREFIX}/backup/curl/parse`, {
    method: 'POST',
    body: JSON.stringify({ curl_command: curlCommand, connector_name: connectorName ?? null }),
  })
  if (!res.ok) throw new Error('message' in res ? res.message : 'Curl parse failed')
  return res.data
}

export async function postPostmanParse(
  collection: Record<string, unknown>,
  opts: { itemId?: string; connectorName?: string } = {},
): Promise<PostmanParseResult> {
  const path = `${GDC_API_PREFIX}/backup/postman/parse`
  const res = await safeRequestJsonResult<PostmanParseResult>(path, {
    method: 'POST',
    body: JSON.stringify({
      collection,
      item_id: opts.itemId ?? null,
      connector_name: opts.connectorName ?? null,
    }),
  })
  if (!res.ok) throw new Error('message' in res ? res.message : 'Postman parse failed')
  return res.data
}
