import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as notificationsApi from '../../api/gdcGovernanceNotifications'
import { persistTestSession } from '../../lib/governance-rbac'
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
    persistTestSession('GOVERNANCE_OPERATOR')
    vi.restoreAllMocks()
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationConfig').mockResolvedValue(config)
    vi.spyOn(notificationsApi, 'fetchGovernanceNotificationEvents').mockResolvedValue({
      total: 0,
      events: [],
    })
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
