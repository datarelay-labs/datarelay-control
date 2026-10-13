import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { DataRouterEnabledContext } from '../../router/data-router-enabled'
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


function renderWithDataRouter(initialEntries: string[] = ['/governance/notifications'], initialIndex?: number) {
  const router = createMemoryRouter([
    {
      path: '/*',
      element: (
        <DataRouterEnabledContext.Provider value>
          <nav><Link to="/monitoring" data-testid="notification-external-nav">Monitoring</Link></nav>
          <Routes>
            <Route path="/governance/notifications" element={<NotificationsPage />} />
            <Route path="/monitoring" element={<p data-testid="notification-monitoring-page">Monitoring</p>} />
          </Routes>
        </DataRouterEnabledContext.Provider>
      ),
    },
  ], { initialEntries, initialIndex })
  render(<RouterProvider router={router} />)
  return router
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


  it('blocks sidebar navigation with unsaved notification rule changes until explicit discard', async () => {
    persistTestSession('ADMINISTRATOR')
    const router = renderWithDataRouter()
    const box = await screen.findByTestId('notification-email-enabled')
    fireEvent.click(within(box).getByRole('checkbox'))
    expect(screen.getByTestId('notification-email-enabled')).toContainElement(within(box).getByRole('checkbox'))
    await waitFor(() => expect(screen.getByTestId('notification-unsaved-warning')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    expect(router.state.location.pathname).toBe('/governance/notifications')
    expect(await screen.findByTestId('notification-discard-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-discard-dialog-cancel'))
    expect(router.state.location.pathname).toBe('/governance/notifications')
    expect(within(box).getByRole('checkbox')).toBeChecked()
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    fireEvent.click(await screen.findByTestId('notification-discard-dialog-confirm'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
  })

  it('blocks browser Back from discarding notification rule edits', async () => {
    persistTestSession('ADMINISTRATOR')
    const router = renderWithDataRouter(['/monitoring', '/governance/notifications'], 1)
    const box = await screen.findByTestId('notification-sub-approval')
    fireEvent.click(within(box).getByRole('checkbox'))
    await router.navigate(-1)
    expect(router.state.location.pathname).toBe('/governance/notifications')
    expect(await screen.findByTestId('notification-discard-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-discard-dialog-confirm'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
  })

  it('does not discard unsaved notification changes when Refresh is clicked without confirmation', async () => {
    persistTestSession('ADMINISTRATOR')
    const reload = vi.mocked(notificationsApi.fetchGovernanceNotificationConfig)
    renderPage()
    const box = await screen.findByTestId('notification-sub-violation')
    fireEvent.click(within(box).getByRole('checkbox'))
    expect(within(box).getByRole('checkbox')).not.toBeChecked()
    expect(reload).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('notifications-refresh'))
    expect(await screen.findByTestId('notification-discard-dialog')).toBeInTheDocument()
    expect(reload).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('notification-discard-dialog-cancel'))
    expect(within(box).getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('notifications-refresh'))
    fireEvent.click(screen.getByTestId('notification-discard-dialog-confirm'))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
    expect(within(box).getByRole('checkbox')).toBeChecked()
  })

  it('allows Viewer navigation without a notification discard dialog', async () => {
    persistTestSession('GOVERNANCE_OPERATOR')
    const router = renderWithDataRouter()
    await screen.findByTestId('notification-channels')
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
    expect(screen.queryByTestId('notification-discard-dialog')).not.toBeInTheDocument()
  })

  it('clears the notification unsaved guard after a successful Save', async () => {
    persistTestSession('ADMINISTRATOR')
    vi.spyOn(notificationsApi, 'updateGovernanceNotificationConfig').mockImplementation(async payload => ({
      ...config, ...payload, updated_at: '2026-10-13T02:00:00Z',
    }))
    const router = renderWithDataRouter()
    const box = await screen.findByTestId('notification-email-enabled')
    fireEvent.click(within(box).getByRole('checkbox'))
    expect(await screen.findByTestId('notification-unsaved-warning')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-save'))
    await waitFor(() => expect(screen.queryByTestId('notification-unsaved-warning')).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
    expect(screen.queryByTestId('notification-discard-dialog')).not.toBeInTheDocument()
  })


  it('warns before hard reload only while notification rule edits are unsaved', async () => {
    persistTestSession('ADMINISTRATOR')
    renderPage()
    const box = await screen.findByTestId('notification-sub-quarantine')
    const cleanReload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanReload)
    expect(cleanReload.defaultPrevented).toBe(false)

    fireEvent.click(within(box).getByRole('checkbox'))
    expect(await screen.findByTestId('notification-unsaved-warning')).toBeInTheDocument()
    const dirtyReload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyReload)
    expect(dirtyReload.defaultPrevented).toBe(true)
    // Reset to the last persisted value without a save; browser reload should be safe.
    fireEvent.click(within(box).getByRole('checkbox'))
    await waitFor(() => expect(screen.queryByTestId('notification-unsaved-warning')).not.toBeInTheDocument())
    const restoredReload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(restoredReload)
    expect(restoredReload.defaultPrevented).toBe(false)
  })

  it('preserves in-flight notification save, refuses cross-page navigation and disables editing', async () => {
    persistTestSession('ADMINISTRATOR')
    let resolveSave: ((updated: notificationsApi.GovernanceNotificationConfig) => void) | null = null
    const save = vi.spyOn(notificationsApi, 'updateGovernanceNotificationConfig').mockImplementation(
      () => new Promise(resolve => { resolveSave = resolve }),
    )
    const router = renderWithDataRouter()
    const box = await screen.findByTestId('notification-email-enabled')
    fireEvent.click(within(box).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('notification-save'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(box).getByRole('checkbox')).toBeDisabled())
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    expect(router.state.location.pathname).toBe('/governance/notifications')
    expect(screen.queryByTestId('notification-discard-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('notification-saving-navigation-warning')).toHaveTextContent('Finish saving')
    if (resolveSave == null) throw new Error('Notification save was not started')
    resolveSave({ ...config, email_enabled: true, updated_at: '2026-10-13T02:00:00Z' })
    await waitFor(() => expect(within(box).getByRole('checkbox')).toBeEnabled())
    await waitFor(() => expect(screen.queryByTestId('notification-unsaved-warning')).not.toBeInTheDocument())
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/monitoring'))
  })

  it('preserves unsaved notification rules if Save fails', async () => {
    persistTestSession('ADMINISTRATOR')
    vi.spyOn(notificationsApi, 'updateGovernanceNotificationConfig').mockRejectedValue(new Error('Save rejected'))
    const router = renderWithDataRouter()
    const box = await screen.findByTestId('notification-sub-replay')
    fireEvent.click(within(box).getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('notification-save'))
    expect(await screen.findByText(/Save rejected/i)).toBeInTheDocument()
    expect(screen.getByTestId('notification-unsaved-warning')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('notification-external-nav'))
    expect(router.state.location.pathname).toBe('/governance/notifications')
    expect(await screen.findByTestId('notification-discard-dialog')).toBeInTheDocument()
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
