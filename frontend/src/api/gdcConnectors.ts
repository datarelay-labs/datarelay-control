import {
  GDC_AUTH_REQUIRED_MESSAGE,
  GDC_DEFAULT_READ_JSON_TIMEOUT_MS,
  requestJson,
  safeRequestJson,
  safeRequestJsonResult,
  type GdcJsonResult,
} from '../api'
import { CATALOG_CONNECTORS_LIST_KEY, CATALOG_LIST_CACHE_TTL_MS } from './catalogListCache'
import { GDC_API_PREFIX } from './gdcApiPrefix'
import { readJsonWithSignal, type GdcSignalOptions } from './gdcSignalOptions'
import { cachedRequest, clearSharedRequestCache } from './requestCache'

const CONNECTORS_LIST_READ_TIMEOUT_MS = 30_000
const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }
const connectorsListReadOpts = { timeoutMs: CONNECTORS_LIST_READ_TIMEOUT_MS }
const CONNECTORS_LIST_CACHE_NS = 'catalog-connectors'
export const CONNECTORS_LIST_LOAD_FAILED_MESSAGE = 'Failed to load connectors'
const CONNECTOR_BY_ID_CACHE_NS = 'catalog-connector-by-id'

function invalidateConnectorsCatalogCache(connectorId?: number): void {
  clearSharedRequestCache(CONNECTORS_LIST_CACHE_NS, CATALOG_CONNECTORS_LIST_KEY)
  if (connectorId != null) {
    clearSharedRequestCache(CONNECTOR_BY_ID_CACHE_NS, String(connectorId))
  }
}

export type ConnectorRead = {
  id: number
  name: string
  /** Operator product grouping (M31.1); when absent, frontend heuristic applies. */
  product_group?: string | null
  description: string | null
  status: string | null
  connector_type: 'generic_http' | 's3_compatible' | 'relational_database' | 'remote_file' | 'webhook_receiver'
  source_type:
    | 'HTTP_API_POLLING'
    | 'S3_OBJECT_POLLING'
    | 'S3'
    | 'DATABASE_QUERY'
    | 'REMOTE_FILE_POLLING'
    | 'REMOTE_FILE'
    | 'WEBHOOK_RECEIVER'
    | 'WEBHOOK'
  source_id: number | null
  stream_count: number
  host: string | null
  base_url: string | null
  verify_ssl: boolean
  http_proxy: string | null
  common_headers: Record<string, string>
  auth_type:
    | 'no_auth'
    | 'basic'
    | 'bearer'
    | 'api_key'
    | 'oauth2_client_credentials'
    | 'session_login'
    | 'jwt_refresh_token'
    | 'vendor_jwt_exchange'
  auth: Record<string, unknown>
  created_at?: string | null
  updated_at?: string | null
  source_updated_at?: string | null
  endpoint_url?: string | null
  bucket?: string | null
  region?: string | null
  prefix?: string | null
  object_key_pattern?: string | null
  path_style_access?: boolean | null
  use_ssl?: boolean | null
  access_key?: string | null
  secret_key_configured?: boolean | null
  db_type?: string | null
  database?: string | null
  port?: number | null
  db_username?: string | null
  db_password_configured?: boolean | null
  ssl_mode?: string | null
  connection_timeout_seconds?: number | null
  remote_username?: string | null
  remote_password_configured?: boolean | null
  known_hosts_policy?: string | null
    remote_file_protocol?: 'sftp' | 'sftp_compatible_scp' | 'scp' | string | null
  remote_private_key_configured?: boolean | null
  remote_private_key_passphrase_configured?: boolean | null
  known_hosts_configured?: boolean | null
  receiver_key?: string | null
  receiver_path?: string | null
  webhook_auth_mode?: 'no_auth' | 'shared_secret_header' | 'bearer_token' | string | null
  webhook_auth_header_name?: string | null
  webhook_shared_secret_configured?: boolean | null
  webhook_bearer_token_configured?: boolean | null
  max_request_bytes?: number | null
  payload_preview?: string | null
  auth_health_check_interval?: 'disabled' | '15m' | '1h' | '6h' | '24h'
  last_auth_check_at?: string | null
  last_auth_check_status?: 'success' | 'failed' | null
  last_auth_error?: string | null
}

export type ConnectorWritePayload = {
  name?: string | null
  product_group?: string | null
  description?: string | null
  status?: string | null
  connector_type?: 'generic_http' | 's3_compatible' | 'relational_database' | 'remote_file' | 'webhook_receiver'
  source_type?:
    | 'HTTP_API_POLLING'
    | 'S3_OBJECT_POLLING'
    | 'S3'
    | 'DATABASE_QUERY'
    | 'REMOTE_FILE_POLLING'
    | 'REMOTE_FILE'
    | 'WEBHOOK_RECEIVER'
    | 'WEBHOOK'
  host?: string | null
  base_url?: string | null
  verify_ssl?: boolean
  http_proxy?: string | null
  common_headers?: Record<string, string>
  endpoint_url?: string | null
  bucket?: string | null
  region?: string | null
  access_key?: string | null
  secret_key?: string | null
  prefix?: string | null
  object_key_pattern?: string | null
  path_style_access?: boolean | null
  use_ssl?: boolean | null
  db_type?: 'POSTGRESQL' | string | null
  database?: string | null
  port?: number | null
  db_username?: string | null
  db_password?: string | null
  ssl_mode?: string | null
  connection_timeout_seconds?: number | null
  db_password_configured?: boolean | null
  remote_username?: string | null
  remote_password?: string | null
  known_hosts_policy?: string | null
  remote_file_protocol?: 'sftp' | 'sftp_compatible_scp' | 'scp' | string | null
  remote_private_key?: string | null
  remote_private_key_passphrase?: string | null
  known_hosts_text?: string | null
  receiver_key?: string | null
  webhook_auth_mode?: 'no_auth' | 'shared_secret_header' | 'bearer_token' | string | null
  webhook_shared_secret?: string | null
  webhook_bearer_token?: string | null
  webhook_auth_header_name?: string | null
  max_request_bytes?: number | null
  payload_preview?: string | null
  auth_health_check_interval?: 'disabled' | '15m' | '1h' | '6h' | '24h'
  auth_type?:
    | 'no_auth'
    | 'basic'
    | 'bearer'
    | 'api_key'
    | 'oauth2_client_credentials'
    | 'session_login'
    | 'jwt_refresh_token'
    | 'vendor_jwt_exchange'
  basic_username?: string | null
  basic_password?: string | null
  bearer_token?: string | null
  api_key_name?: string | null
  api_key_value?: string | null
  api_key_location?: 'headers' | 'query_params' | null
  oauth2_client_id?: string | null
  oauth2_client_secret?: string | null
  oauth2_token_url?: string | null
  oauth2_scope?: string | null
  login_url?: string | null
  login_path?: string | null
  login_method?: string | null
  login_headers?: Record<string, string>
  login_body_template?: Record<string, unknown>
  login_body_mode?: 'json' | 'form_urlencoded' | 'raw' | null
  login_body_raw?: string | null
  login_allow_redirects?: boolean | null
  session_cookie_name?: string | null
  login_username?: string | null
  login_password?: string | null
  preflight_enabled?: boolean | null
  preflight_method?: string | null
  preflight_path?: string | null
  preflight_url?: string | null
  preflight_headers?: Record<string, string>
  preflight_body_raw?: string | null
  preflight_follow_redirects?: boolean | null
  login_query_params?: Record<string, string>
  session_login_extractions?: Array<Record<string, unknown>>
  csrf_extract?: Record<string, unknown> | null
  refresh_token?: string | null
  token_url?: string | null
  token_path?: string | null
  token_http_method?: string | null
  refresh_token_header_name?: string | null
  refresh_token_header_prefix?: string | null
  access_token_json_path?: string | null
  access_token_header_name?: string | null
  access_token_header_prefix?: string | null
  token_ttl_seconds?: number | null
  user_id?: string | null
  api_key?: string | null
  token_method?: string | null
  token_auth_mode?: string | null
  token_content_type?: string | null
  token_body_mode?: string | null
  token_body?: string | null
  access_token_injection?: string | null
  access_token_query_name?: string | null
  token_custom_headers?: Record<string, string> | null
  expected_updated_at?: string
  expected_source_updated_at?: string | null
}

export { GDC_AUTH_REQUIRED_MESSAGE }

export function normalizeConnectorsLoadError(message: string | null | undefined): string {
  const raw = String(message ?? '').trim()
  if (!raw) return CONNECTORS_LIST_LOAD_FAILED_MESSAGE
  if (/timed out|aborted|abort/i.test(raw)) return CONNECTORS_LIST_LOAD_FAILED_MESSAGE
  if (/failed to fetch|networkerror|network error|load failed/i.test(raw)) return CONNECTORS_LIST_LOAD_FAILED_MESSAGE
  return raw
}

async function fetchConnectorsListResultUncached(signal?: AbortSignal): Promise<GdcJsonResult<ConnectorRead[]>> {
  const result = await safeRequestJsonResult<unknown>(
    `${GDC_API_PREFIX}/connectors/`,
    readJsonWithSignal(connectorsListReadOpts, signal),
  )
  if (result.ok === false) {
    return {
      ok: false,
      status: result.status,
      message: result.authRequired ? GDC_AUTH_REQUIRED_MESSAGE : normalizeConnectorsLoadError(result.message),
      authRequired: result.authRequired,
    }
  }
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      status: result.status,
      message: 'Connectors API returned an unexpected response. Check authentication and API base URL.',
      authRequired: false,
    }
  }
  return { ok: true, data: result.data as ConnectorRead[], status: result.status }
}

export async function fetchConnectorsListResult(options?: GdcSignalOptions): Promise<GdcJsonResult<ConnectorRead[]>> {
  return cachedRequest(
    CONNECTORS_LIST_CACHE_NS,
    CATALOG_CONNECTORS_LIST_KEY,
    (signal) => fetchConnectorsListResultUncached(signal),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

/** Returns connector rows, or null on auth/HTTP/parse failure (empty list is `[]`, not null). */
export async function fetchConnectorsList(options?: GdcSignalOptions): Promise<ConnectorRead[] | null> {
  const result = await fetchConnectorsListResult(options)
  return result.ok ? result.data : null
}

export async function createConnector(payload: ConnectorWritePayload): Promise<ConnectorRead> {
  const created = await requestJson<ConnectorRead>(`${GDC_API_PREFIX}/connectors/`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  invalidateConnectorsCatalogCache(created.id)
  return created
}

export async function fetchConnectorById(connectorId: number, options?: GdcSignalOptions): Promise<ConnectorRead | null> {
  return cachedRequest(
    CONNECTOR_BY_ID_CACHE_NS,
    String(connectorId),
    (signal) =>
      safeRequestJson<ConnectorRead>(
        `${GDC_API_PREFIX}/connectors/${connectorId}`,
        readJsonWithSignal(readJsonOpts, signal),
      ),
    { ttlMs: CATALOG_LIST_CACHE_TTL_MS, signal: options?.signal },
  )
}

export async function updateConnector(connectorId: number, payload: ConnectorWritePayload): Promise<ConnectorRead> {
  let expectedUpdatedAt = payload.expected_updated_at
  let expectedSourceUpdatedAt = payload.expected_source_updated_at
  if (!expectedUpdatedAt || expectedSourceUpdatedAt === undefined) {
    const current = await fetchConnectorById(connectorId)
    expectedUpdatedAt = expectedUpdatedAt ?? current?.updated_at ?? undefined
    if (expectedSourceUpdatedAt === undefined) {
      expectedSourceUpdatedAt = current?.source_updated_at ?? null
    }
  }
  if (!expectedUpdatedAt) {
    throw new Error('expected_updated_at is required for connector updates')
  }
  const body: ConnectorWritePayload = {
    ...payload,
    expected_updated_at: expectedUpdatedAt,
    expected_source_updated_at: expectedSourceUpdatedAt ?? null,
  }
  const updated = await requestJson<ConnectorRead>(`${GDC_API_PREFIX}/connectors/${connectorId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  invalidateConnectorsCatalogCache(connectorId)
  return updated
}

export async function deleteConnector(connectorId: number): Promise<void> {
  await requestJson<void>(`${GDC_API_PREFIX}/connectors/${connectorId}`, {
    method: 'DELETE',
  })
  invalidateConnectorsCatalogCache(connectorId)
}
