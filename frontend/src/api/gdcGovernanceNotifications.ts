import { GDC_DEFAULT_READ_JSON_TIMEOUT_MS, safeRequestJson } from '../api'
import { GDC_API_PREFIX } from './gdcApiPrefix'

const GOV = `${GDC_API_PREFIX}/governance`

const readJsonOpts = { timeoutMs: GDC_DEFAULT_READ_JSON_TIMEOUT_MS }

export type GovernanceNotificationConfig = {
  approval_events: boolean
  violation_events: boolean
  quarantine_events: boolean
  replay_events: boolean
  email_enabled: boolean
  email_recipients: string[]
  webhook_enabled: boolean
  webhook_url: string | null
  updated_at: string | null
}

export type GovernanceNotificationConfigUpdate = Partial<
  Pick<
    GovernanceNotificationConfig,
    | 'approval_events'
    | 'violation_events'
    | 'quarantine_events'
    | 'replay_events'
    | 'email_enabled'
    | 'email_recipients'
    | 'webhook_enabled'
    | 'webhook_url'
  >
>

export type GovernanceNotificationEventStatus = 'PENDING' | 'SENT' | 'FAILED'

export type GovernanceNotificationEventEntry = {
  id: number
  event_type: string
  event_category: string
  severity: string
  status: GovernanceNotificationEventStatus
  payload: Record<string, unknown> | null
  created_at: string
  sent_at: string | null
}

export type GovernanceNotificationEventsResponse = {
  total: number
  events: GovernanceNotificationEventEntry[]
}

export type GovernanceNotificationTestResponse = {
  channel: 'email' | 'webhook'
  success: boolean
  message: string
}

export async function fetchGovernanceNotificationConfig(): Promise<GovernanceNotificationConfig> {
  return safeRequestJson<GovernanceNotificationConfig>(`${GOV}/notifications/config`, readJsonOpts)
}

export async function updateGovernanceNotificationConfig(
  payload: GovernanceNotificationConfigUpdate,
): Promise<GovernanceNotificationConfig> {
  return safeRequestJson<GovernanceNotificationConfig>(`${GOV}/notifications/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function testGovernanceNotification(
  channel: 'email' | 'webhook',
): Promise<GovernanceNotificationTestResponse> {
  return safeRequestJson<GovernanceNotificationTestResponse>(`${GOV}/notifications/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  })
}

export async function fetchGovernanceNotificationEvents(
  status?: GovernanceNotificationEventStatus,
  limit = 50,
): Promise<GovernanceNotificationEventsResponse> {
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  q.set('limit', String(limit))
  return safeRequestJson<GovernanceNotificationEventsResponse>(
    `${GOV}/notifications/events?${q.toString()}`,
    readJsonOpts,
  )
}

export async function fetchGovernanceNotificationHealth(): Promise<{
  pending_notifications: number
  failed_notifications: number
  last_delivery_time: string | null
  durable_outbox_enabled?: boolean
  pending_delivery_jobs?: number
  leased_delivery_jobs?: number
  retry_scheduled_delivery_jobs?: number
  dead_letter_delivery_jobs?: number
}> {
  return safeRequestJson(`${GOV}/notifications/health`, readJsonOpts)
}
