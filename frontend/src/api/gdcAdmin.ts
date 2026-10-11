import { requestBlob, requestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

export type HttpsSettingsDto = {
  enabled: boolean
  certificate_ip_addresses: string[]
  certificate_dns_names: string[]
  redirect_http_to_https: boolean
  certificate_valid_days: number
  current_access_url: string
  https_active: boolean
  certificate_not_after: string | null
  restart_required_after_save: boolean
  http_listener_active: boolean
  https_listener_active: boolean
  redirect_http_to_https_effective: boolean
  proxy_status: 'ok' | 'degraded' | 'unknown' | 'not_configured'
  proxy_health_ok: boolean | null
  proxy_last_reload_at: string | null
  proxy_last_reload_ok: boolean | null
  proxy_last_reload_detail: string | null
  proxy_fallback_to_http_last: boolean
  browser_http_url: string
  browser_https_url: string | null
}

export type HttpsSettingsSaveDto = {
  ok: boolean
  restart_required: boolean
  certificate_not_after: string | null
  message: string
  proxy_reload_applied: boolean
  proxy_https_effective: boolean | null
  proxy_fallback_to_http: boolean
}

export type ManagementAccessPreviewDraft = {
  web: { enabled: boolean; sources: Array<{ cidr: string }> }
  ssh: { enabled: boolean; sources: Array<{ cidr: string }> }
  rollback_seconds: number
}

export type ManagementAccessPreviewDto = {
  mode: 'PREVIEW_ONLY'
  apply_available: false
  ssh_enforcement_available: false
  web_enforcement_available: false
  observed_api_source: string | null
  web_reason: string
  web_source_matches: boolean
  ssh_reason: string
  blockers: string[]
  candidate_web_enabled: boolean
  candidate_ssh_enabled: boolean
  rollback_seconds: number
}

export type NetworkSettingsDto = {
  http_port: number
  https_port: number
  env_example: Record<string, string>
  restart_required: boolean
  restart_command: string
}

export type NetworkSettingsSaveDto = NetworkSettingsDto & {
  restart_required: true
  message: string
}

export type NetworkSettingsApplyDto = {
  success: boolean
  command: string
  stdout: string
  stderr: string
  exit_code: number
  message: string
}

export type PlatformUserDto = {
  id: number
  username: string
  role: string
  status: string
  created_at: string
  last_login_at: string | null
  timezone?: string | null
  mfa_enabled?: boolean
}

export type DisplaySettingsDto = {
  default_timezone: string
  updated_at?: string | null
}

export type SystemInfoDto = {
  app_name: string
  app_version: string
  app_env: string
  python_version: string
  database_reachable: boolean
  database_url_masked: string
  platform: string
  server_time_utc?: string | null
  timezone?: string | null
  database_version?: string | null
  uptime_seconds?: number | null
}

export type RetentionBlockDto = {
  retention_days: number
  enabled: boolean
  last_cleanup_at: string | null
  next_cleanup_at: string | null
  last_deleted_count?: number | null
  last_duration_ms?: number | null
  last_status?: string | null
}

export type RetentionPolicyDto = {
  logs: RetentionBlockDto
  runtime_metrics: RetentionBlockDto
  preview_cache: RetentionBlockDto
  backup_temp: RetentionBlockDto
  cleanup_scheduler_active: boolean
  cleanup_scheduler_enabled: boolean
  cleanup_interval_minutes: number
  cleanup_batch_size: number
  scheduler_started_at?: string | null
  scheduler_last_tick_at?: string | null
  scheduler_last_summary?: string | null
  cleanup_engine_message: string
  delivery_logs_scheduler_metrics?: {
    logs_cumulative_deleted_since_process_start: number
    logs_category_sweeps: number
  } | null
}

export type RetentionCleanupCategory = 'logs' | 'runtime_metrics' | 'preview_cache' | 'backup_temp'

export type RetentionCleanupOutcomeDto = {
  category: RetentionCleanupCategory | string
  status: string
  enabled: boolean
  dry_run: boolean
  matched_count: number
  deleted_count: number
  duration_ms: number
  retention_days: number
  cutoff: string | null
  message: string
  notes: Record<string, unknown>
}

export type RetentionCleanupRunResponseDto = {
  dry_run: boolean
  triggered_at: string
  outcomes: RetentionCleanupOutcomeDto[]
  policy: RetentionPolicyDto
}

export type AuditEventDto = {
  id: number
  created_at: string
  actor_username: string
  action: string
  entity_type?: string | null
  entity_id?: number | null
  entity_name?: string | null
  details: Record<string, unknown>
}

export type AuditLogListDto = {
  total: number
  items: AuditEventDto[]
}

export type ConfigVersionDto = {
  id: number
  version: number
  entity_type: string
  entity_id: number
  entity_name: string | null
  changed_by: string
  changed_at: string
  summary: string | null
}

export type ConfigVersionListDto = {
  total: number
  items: ConfigVersionDto[]
}

export type HealthMetricDto = {
  key: string
  label: string
  available: boolean
  value: string | null
  status: 'good' | 'medium' | 'bad' | 'unknown'
  notes?: string | null
  link_path?: string | null
}

export type AdminHealthSummaryDto = {
  metrics_window_seconds: number
  metrics: HealthMetricDto[]
}

export type AlertRuleDto = {
  alert_type: string
  enabled: boolean
  severity: 'WARNING' | 'CRITICAL'
  last_triggered_at: string | null
}

export type AlertSettingsDto = {
  rules: AlertRuleDto[]
  webhook_url: string | null
  slack_webhook_url: string | null
  email_to: string | null
  channel_status: Record<string, string>
  notification_delivery: Record<string, string>
  cooldown_seconds: number
  monitor_enabled: boolean
}

export type AlertHistoryItemDto = {
  id: number
  created_at: string
  alert_type: string
  severity: string
  stream_id: number | null
  stream_name: string | null
  route_id: number | null
  destination_id: number | null
  message: string
  fingerprint: string
  channel: string
  delivery_status: string
  http_status: number | null
  error_message: string | null
  webhook_url_masked: string | null
  duration_ms: number | null
  trigger_source: string
}

export type AlertHistoryListDto = {
  total: number
  items: AlertHistoryItemDto[]
}

export type AlertTestResponseDto = {
  ok: boolean
  delivery_status: string
  http_status: number | null
  duration_ms: number | null
  error_message: string | null
  webhook_url_masked: string | null
  history_id: number
}

export type WhoAmIDto = {
  username: string
  role: 'ADMINISTRATOR' | 'OPERATOR' | 'VIEWER'
  authenticated: boolean
  must_change_password?: boolean
  token_expires_at?: string | null
  capabilities?: Record<string, boolean>
  timezone?: string | null
  platform_default_timezone?: string
}

export type SessionUserDto = {
  username: string
  role: 'ADMINISTRATOR' | 'OPERATOR' | 'VIEWER'
  status: string
  must_change_password?: boolean
  capabilities?: Record<string, boolean>
}

export type TokenBundleDto = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  expires_at: string
  user: SessionUserDto
}

export type MfaChallengeDto = {
  mfa_required: true
  challenge_token: string
  expires_at: string
}

/** Alias kept for backwards compatibility with existing callers. */
export type LoginResponseDto = TokenBundleDto | MfaChallengeDto

export async function getAdminHttpsSettings(): Promise<HttpsSettingsDto> {
  return requestJson<HttpsSettingsDto>(`${GDC_API_PREFIX}/admin/https-settings`)
}

export async function putAdminHttpsSettings(body: {
  enabled: boolean
  certificate_ip_addresses: string[]
  certificate_dns_names: string[]
  redirect_http_to_https: boolean
  certificate_valid_days: number
  regenerate_certificate?: boolean
}): Promise<HttpsSettingsSaveDto> {
  return requestJson<HttpsSettingsSaveDto>(`${GDC_API_PREFIX}/admin/https-settings`, {
    method: 'PUT',
    body: JSON.stringify({
      ...body,
      regenerate_certificate: body.regenerate_certificate ?? true,
    }),
  })
}

export async function postAdminManagementAclPreview(
  draft: ManagementAccessPreviewDraft,
): Promise<ManagementAccessPreviewDto> {
  return requestJson<ManagementAccessPreviewDto>(`${GDC_API_PREFIX}/admin/management-access/preview`, {
    method: 'POST',
    body: JSON.stringify(draft),
  })
}

export async function getAdminNetworkSettings(): Promise<NetworkSettingsDto> {
  return requestJson<NetworkSettingsDto>(`${GDC_API_PREFIX}/admin/network-settings`)
}

export async function putAdminNetworkSettings(body: {
  http_port: number
  https_port: number
}): Promise<NetworkSettingsSaveDto> {
  return requestJson<NetworkSettingsSaveDto>(`${GDC_API_PREFIX}/admin/network-settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function postAdminNetworkSettingsApply(): Promise<NetworkSettingsApplyDto> {
  return requestJson<NetworkSettingsApplyDto>(`${GDC_API_PREFIX}/admin/network-settings/apply`, {
    method: 'POST',
  })
}

export async function listAdminUsers(): Promise<PlatformUserDto[]> {
  return requestJson<PlatformUserDto[]>(`${GDC_API_PREFIX}/admin/users`)
}

export async function createAdminUser(body: { username: string; password: string; role: string }): Promise<PlatformUserDto> {
  return requestJson<PlatformUserDto>(`${GDC_API_PREFIX}/admin/users`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateAdminUser(
  userId: number,
  body: { password?: string; role?: string; status?: string },
): Promise<PlatformUserDto> {
  return requestJson<PlatformUserDto>(`${GDC_API_PREFIX}/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteAdminUser(userId: number): Promise<void> {
  await requestJson(`${GDC_API_PREFIX}/admin/users/${userId}`, { method: 'DELETE' })
}

export async function postAdminUserMfaReset(
  userId: number,
  body: { confirm_username: string; current_password: string },
): Promise<void> {
  await requestJson(`${GDC_API_PREFIX}/admin/users/${userId}/mfa/reset`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function postAdminPasswordChange(body: {
  username: string
  current_password: string
  new_password: string
  confirm_password: string
}): Promise<void> {
  await requestJson(`${GDC_API_PREFIX}/admin/password`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getAdminSystemInfo(): Promise<SystemInfoDto> {
  return requestJson<SystemInfoDto>(`${GDC_API_PREFIX}/admin/system`)
}

export async function getAdminRetentionPolicy(): Promise<RetentionPolicyDto> {
  return requestJson<RetentionPolicyDto>(`${GDC_API_PREFIX}/admin/retention-policy`)
}

export async function putAdminRetentionPolicy(body: Record<string, unknown>): Promise<RetentionPolicyDto> {
  return requestJson<RetentionPolicyDto>(`${GDC_API_PREFIX}/admin/retention-policy`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function getAdminDisplaySettings(): Promise<DisplaySettingsDto> {
  return requestJson<DisplaySettingsDto>(`${GDC_API_PREFIX}/admin/display-settings`)
}

export async function putAdminDisplaySettings(body: { default_timezone: string }): Promise<DisplaySettingsDto> {
  return requestJson<DisplaySettingsDto>(`${GDC_API_PREFIX}/admin/display-settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function getAdminAuditLog(params?: { limit?: number; offset?: number }): Promise<AuditLogListDto> {
  const q = new URLSearchParams()
  if (params?.limit != null) q.set('limit', String(params.limit))
  if (params?.offset != null) q.set('offset', String(params.offset))
  const suffix = q.toString() ? `?${q.toString()}` : ''
  return requestJson<AuditLogListDto>(`${GDC_API_PREFIX}/admin/audit-log${suffix}`)
}

export async function getAdminConfigVersions(params?: { limit?: number; offset?: number }): Promise<ConfigVersionListDto> {
  const q = new URLSearchParams()
  if (params?.limit != null) q.set('limit', String(params.limit))
  if (params?.offset != null) q.set('offset', String(params.offset))
  const suffix = q.toString() ? `?${q.toString()}` : ''
  return requestJson<ConfigVersionListDto>(`${GDC_API_PREFIX}/admin/config-versions${suffix}`)
}

export async function getAdminHealthSummary(): Promise<AdminHealthSummaryDto> {
  return requestJson<AdminHealthSummaryDto>(`${GDC_API_PREFIX}/admin/health-summary`)
}

export type MaintenanceNoticeDto = {
  code: string
  message: string
  panel: string
}

export type MaintenanceHealthDto = {
  generated_at: string
  overall: 'OK' | 'WARN' | 'ERROR'
  ok: MaintenanceNoticeDto[]
  warn: MaintenanceNoticeDto[]
  error: MaintenanceNoticeDto[]
  panels: Record<string, Record<string, unknown>>
}

export async function getAdminMaintenanceHealth(): Promise<MaintenanceHealthDto> {
  return requestJson<MaintenanceHealthDto>(`${GDC_API_PREFIX}/admin/maintenance/health`)
}

export type DevValidationAdminStatusDto = {
  generated_at: string
  lab_effective: boolean
  enable_dev_validation_lab: boolean
  app_env: string
  fixture_flags: Record<string, boolean>
  lab_defaults_applied?: boolean
  lab_defaults_meta?: Record<string, unknown>
  seeded_lab_streams_by_type?: Record<string, number>
  seeded_lab_streams_total?: number
  platform_catalog_db: Record<string, unknown>
  fixtures_required: Array<Record<string, unknown>>
  fixture_readiness: Record<string, { reachable?: boolean; latency_ms?: number | null; detail?: string | null }>
  fixture_readiness_badge: string
  streams_dependency_missing: Array<{ stream_id: number; name: string; stream_type: string; reasons: string[] }>
  validation_lab: Record<string, unknown> | null
}

export async function getAdminDevValidationStatus(): Promise<DevValidationAdminStatusDto> {
  return requestJson<DevValidationAdminStatusDto>(`${GDC_API_PREFIX}/admin/dev-validation/status`)
}

export async function getAdminAlertSettings(): Promise<AlertSettingsDto> {
  return requestJson<AlertSettingsDto>(`${GDC_API_PREFIX}/admin/alert-settings`)
}

export async function putAdminAlertSettings(body: {
  rules?: AlertRuleDto[]
  webhook_url?: string | null
  slack_webhook_url?: string | null
  email_to?: string | null
  cooldown_seconds?: number | null
  monitor_enabled?: boolean | null
}): Promise<AlertSettingsDto> {
  return requestJson<AlertSettingsDto>(`${GDC_API_PREFIX}/admin/alert-settings`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function postAdminRetentionCleanupRun(body: {
  categories?: RetentionCleanupCategory[]
  dry_run?: boolean
}): Promise<RetentionCleanupRunResponseDto> {
  return requestJson<RetentionCleanupRunResponseDto>(`${GDC_API_PREFIX}/admin/retention-policy/run`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export async function postAdminAlertTest(body: {
  alert_type?: string
  message?: string
}): Promise<AlertTestResponseDto> {
  return requestJson<AlertTestResponseDto>(`${GDC_API_PREFIX}/admin/alert-settings/test`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export async function getAdminAlertHistory(params?: {
  limit?: number
  offset?: number
  alert_type?: string
  stream_id?: number
}): Promise<AlertHistoryListDto> {
  const q = new URLSearchParams()
  if (params?.limit != null) q.set('limit', String(params.limit))
  if (params?.offset != null) q.set('offset', String(params.offset))
  if (params?.alert_type) q.set('alert_type', params.alert_type)
  if (params?.stream_id != null) q.set('stream_id', String(params.stream_id))
  const suffix = q.toString() ? `?${q.toString()}` : ''
  return requestJson<AlertHistoryListDto>(`${GDC_API_PREFIX}/admin/alert-history${suffix}`)
}

export async function getAuthWhoAmI(): Promise<WhoAmIDto> {
  return requestJson<WhoAmIDto>(`${GDC_API_PREFIX}/auth/whoami`)
}

/** Session principal (GET /api/v1/auth/whoami — the SPA "me" probe). */
export async function getAuthMe(): Promise<WhoAmIDto> {
  return getAuthWhoAmI()
}

export async function patchAuthProfile(body: { timezone?: string | null }): Promise<WhoAmIDto> {
  return requestJson<WhoAmIDto>(`${GDC_API_PREFIX}/auth/profile`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function postAuthLogin(body: { username: string; password: string }): Promise<LoginResponseDto> {
  return requestJson<LoginResponseDto>(`${GDC_API_PREFIX}/auth/login`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function postAuthMfaVerify(body: {
  challenge_token: string
  totp?: string
  recovery_code?: string
}): Promise<TokenBundleDto> {
  return requestJson<TokenBundleDto>(`${GDC_API_PREFIX}/auth/mfa/verify`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getAuthMfaStatus(): Promise<{ enabled: boolean }> {
  return requestJson<{ enabled: boolean }>(`${GDC_API_PREFIX}/auth/mfa/status`)
}

export async function postAuthMfaEnrollStart(current_password: string): Promise<{
  secret: string; otpauth_uri: string; expires_at: string
}> {
  return requestJson(`${GDC_API_PREFIX}/auth/mfa/enroll/start`, {
    method: 'POST', body: JSON.stringify({ current_password }),
  })
}

export async function postAuthMfaEnrollConfirm(totp: string): Promise<{
  enabled: boolean; recovery_codes: string[]
}> {
  return requestJson(`${GDC_API_PREFIX}/auth/mfa/enroll/confirm`, {
    method: 'POST', body: JSON.stringify({ totp }),
  })
}

export async function postAuthRefresh(refresh_token: string): Promise<TokenBundleDto> {
  return requestJson<TokenBundleDto>(`${GDC_API_PREFIX}/auth/refresh`, {
    method: 'POST',
    body: JSON.stringify({ refresh_token }),
  })
}

export async function postAuthLogout(body?: { revoke_all?: boolean }): Promise<void> {
  await requestJson(`${GDC_API_PREFIX}/auth/logout`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  })
}

export type SelfPasswordChangeResponseDto = {
  ok: boolean
  message: string
}

export async function postAuthChangePassword(body: {
  current_password: string
  new_password: string
  confirm_new_password: string
}): Promise<SelfPasswordChangeResponseDto> {
  return requestJson<SelfPasswordChangeResponseDto>(`${GDC_API_PREFIX}/auth/change-password`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Download masked diagnostics ZIP (administrator-only API). */
export async function downloadAdminSupportBundle(): Promise<void> {
  const { blob, filename } = await requestBlob(`${GDC_API_PREFIX}/admin/support-bundle`, { method: 'GET' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename && filename.trim() ? filename : 'gdc-support-bundle.zip'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}
