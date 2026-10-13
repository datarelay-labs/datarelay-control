import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as notificationsApi from '../../api/gdcGovernanceNotifications'
import { persistTestSession } from '../../lib/governance-rbac'
import { clearSession, persistSession, readSession } from '../../auth/session'
import { NotificationsPage } from './notifications-page'

const config: notificationsApi.GovernanceNotificationConfig = {
  approval_events: true,
  violation_events: true,
  quarantine_events: true,
  replay_events: true,
  email_enabled: false,
  email_recipients: [],
  webhook_enabled: false,
  webhook_url: null,
  updated_at: null,
}

const queueHealth = {
  pending_notifications: 2,
  failed_notifications: 1,
  last_delivery_time: null,
  durable_outbox_enabled: true,
  pending_delivery_jobs: 2,
  leased_delivery_jobs: 1,
  retry_scheduled_delivery_jobs: 1,
  dead_letter_delivery_jobs: 3,
}

function renderPage() {
  return render(
    <MemoryRouter>
      <NotificationsPage />
    </MemoryRouter>,
  )
}

describe('Governance notification queue source-driven diagnostics', () => {
  beforeEach(() => {
    clearSession()
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationConfig').mockResolvedValue(config)
    // Never hit the live optional health endpoint during notification UI tests:
    // a 401 response would clear the synthetic actor and corrupt RBAC assertions.
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockResolvedValue({
      ...queueHealth,
      durable_outbox_enabled: false,
    })
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationEvents').mockResolvedValue({
      total: 0,
      events: [],
    })
  })


  it('does not misrepresent SENT notification transport acknowledgement as receiver delivery', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockResolvedValue({
      ...queueHealth,
      durable_outbox_enabled: false,
    })
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationEvents').mockImplementation(async (status) => ({
      total: status === 'SENT' ? 1 : 0,
      events: status === 'SENT' ? [{
        id: 91,
        event_type: 'POLICY_VIOLATION',
        event_category: 'governance',
        severity: 'HIGH',
        status: 'SENT',
        payload: null,
        created_at: '2026-10-13T01:00:00Z',
        sent_at: '2026-10-13T01:00:01Z',
      }] : [],
    }))
    renderPage()
    const row = await screen.findByTestId('notification-event-91')
    fireEvent.click(row)
    const drawer = await screen.findByTestId('notification-event-drawer')
    expect(within(drawer).getByText(/transport (acceptance|acknowledgement)/i)).toBeInTheDocument()
    expect(within(drawer).getByText(/(does not|not).*confirm (inbox|downstream|receiver)/i)).toBeInTheDocument()
    expect(within(drawer).queryByText(/delivered successfully to the configured channel/i)).not.toBeInTheDocument()
  })


  it('does not advertise a nonfunctional email Test action to a read-only Governance Operator', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationEvents').mockImplementation(async (status) => ({
      total: status === 'FAILED' ? 1 : 0,
      events: status === 'FAILED' ? [{
        id: 92,
        event_type: 'POLICY_VIOLATION',
        event_category: 'governance',
        severity: 'HIGH',
        status: 'FAILED',
        payload: null,
        created_at: '2026-10-13T02:00:00Z',
        sent_at: null,
      }] : [],
    }))
    renderPage()
    const row = await screen.findByTestId('notification-event-92')
    fireEvent.click(row)
    const drawer = await screen.findByTestId('notification-event-drawer')
    expect(within(drawer).queryByRole('button', { name: /Test email channel/i })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: /Open governance workspace/i })).toBeInTheDocument()
  })

  it('retains the failed-event email Test action for an authorized Administrator', async () => {
    persistTestSession('ADMINISTRATOR')
    expect(readSession()?.user.role).toBe('ADMINISTRATOR')
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationEvents').mockImplementation(async (status) => ({
      total: status === 'FAILED' ? 1 : 0,
      events: status === 'FAILED' ? [{
        id: 93,
        event_type: 'POLICY_VIOLATION',
        event_category: 'governance',
        severity: 'HIGH',
        status: 'FAILED',
        payload: null,
        created_at: '2026-10-13T02:00:00Z',
        sent_at: null,
      }] : [],
    }))
    const send = vi.spyOn(notificationsApi, 'testGovernanceNotification').mockResolvedValue({
      channel: 'email',
      success: true,
      message: 'SMTP relay accepted',
    })
    renderPage()
    const row = await screen.findByTestId('notification-event-93')
    expect(readSession()?.user.role).toBe('ADMINISTRATOR')
    fireEvent.click(row)
    expect(readSession()?.user.role).toBe('ADMINISTRATOR')
    const drawer = await screen.findByTestId('notification-event-drawer')
    const testButton = within(drawer).getByRole('button', { name: /Test email channel/i })
    fireEvent.click(testButton)
    expect(send).toHaveBeenCalledWith('email')
  })


  it.each([
    ['expired access', { expires_at: '2020-01-01T00:00:00.000Z' }],
    ['disabled account', { status: 'DISABLED' }],
    ['password reset required', { must_change_password: true }],
  ])('does not expose Administrator notification mutations with %s', async (_label, override) => {
    persistTestSession('ADMINISTRATOR')
    const session = readSession()
    if (session == null) throw new Error('Test Administrator session is missing')
    persistSession({
      ...session,
      expires_at: 'expires_at' in override ? override.expires_at : session.expires_at,
      user: { ...session.user, ...('status' in override ? { status: override.status } : {}), ...('must_change_password' in override ? { must_change_password: override.must_change_password } : {}) },
    })
    renderPage()
    await screen.findByTestId('notification-channels')
    expect(screen.queryByTestId('notification-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-test-email')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-test-webhook')).not.toBeInTheDocument()
  })


  it('honors a server-denied notification-write capability even for an active Administrator', async () => {
    persistTestSession('ADMINISTRATOR')
    const session = readSession()
    if (session == null) throw new Error('Test Administrator session missing')
    persistSession({
      ...session,
      user: {
        ...session.user,
        capabilities: {
          ...session.user.capabilities,
          admin_alert_settings_write: false,
        },
      },
    })
    renderPage()
    await screen.findByTestId('notification-channels')
    expect(screen.queryByTestId('notification-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-test-email')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-test-webhook')).not.toBeInTheDocument()
  })

  it('does not let a nonadmin with an inconsistent write capability bypass the Administrator API role rule', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    const session = readSession()
    if (session == null) throw new Error('Test Governance Operator session missing')
    persistSession({
      ...session,
      user: {
        ...session.user,
        capabilities: {
          ...session.user.capabilities,
          admin_alert_settings_write: true,
        },
      },
    })
    renderPage()
    await screen.findByTestId('notification-channels')
    expect(screen.queryByTestId('notification-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('notification-test-email')).not.toBeInTheDocument()
  })

  it('shows read-only queue depth, retries and dead letters when enabled', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockResolvedValue(queueHealth)
    renderPage()
    const panel = await screen.findByTestId('notification-outbox-health')
    expect(within(panel).getByTestId('notification-outbox-pending')).toHaveTextContent('2')
    expect(within(panel).getByTestId('notification-outbox-leased')).toHaveTextContent('1')
    expect(within(panel).getByTestId('notification-outbox-retry')).toHaveTextContent('1')
    expect(within(panel).getByTestId('notification-outbox-dead')).toHaveTextContent('3')
    expect(within(panel).getByText(/does not confirm downstream receipt/i)).toBeInTheDocument()
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument()
  })

  it('does not present a disabled queue as active', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockResolvedValue({
      ...queueHealth,
      durable_outbox_enabled: false,
      pending_delivery_jobs: 0,
      leased_delivery_jobs: 0,
      retry_scheduled_delivery_jobs: 0,
      dead_letter_delivery_jobs: 0,
    })
    renderPage()
    await screen.findByTestId('notification-delivery-status')
    expect(screen.queryByTestId('notification-outbox-health')).not.toBeInTheDocument()
  })



  it('does not hold the existing notification page while optional queue health hangs', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockImplementation(
      () => new Promise<never>(() => {}),
    )
    renderPage()
    expect(await screen.findByTestId('notification-pending')).toBeInTheDocument()
    expect(screen.getByTestId('notification-failed')).toBeInTheDocument()
    expect(screen.getByTestId('notification-sent')).toBeInTheDocument()
    expect(screen.queryByTestId('notification-outbox-health')).not.toBeInTheDocument()
  })

  it('keeps existing notification tables if optional queue health is unavailable', async () => {
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationHealth').mockRejectedValue(
      new Error('Queue health unavailable'),
    )
    renderPage()
    await screen.findByTestId('notification-delivery-status')
    expect(screen.getByTestId('notification-pending')).toBeInTheDocument()
    expect(screen.getByTestId('notification-failed')).toBeInTheDocument()
    expect(screen.queryByTestId('notification-outbox-health')).not.toBeInTheDocument()
  })
})
