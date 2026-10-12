import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { persistTestSession, clearTestSession } from '../../lib/governance-rbac'
import { persistSession, readSession } from '../../auth/session'
import { SHELL_ALERTS_PATH, TopHeader } from './top-header'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderHeader(opts?: { mobileNavOpen?: boolean; onMobileNavToggle?: () => void; runtimeHealthy?: boolean | null; initialPath?: string }) {
  const onToggleTheme = vi.fn()
  render(
    <MemoryRouter initialEntries={[opts?.initialPath ?? '/monitoring']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TopHeader
                title="Dashboard"
                isDark={false}
                onToggleTheme={onToggleTheme}
                runtimeHealthy={opts?.runtimeHealthy ?? null}
                mobileNavOpen={opts?.mobileNavOpen}
                onMobileNavToggle={opts?.onMobileNavToggle}
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
  return { onToggleTheme }
}

describe('TopHeader SaaS shell', () => {
  afterEach(() => {
    cleanup()
    clearTestSession()
  })

  it.each(['ADMINISTRATOR', 'OPERATOR', 'CONNECTOR_OPERATOR'] as const)(
    'offers a primary New data flow action to an active %s user on a landing page',
    async (role) => {
      persistTestSession(role)
      const user = userEvent.setup()
      renderHeader()
      const link = screen.getByRole('link', { name: 'New data flow' })
      expect(link).toHaveAttribute('href', '/streams/new')
      expect(link).toHaveClass('min-h-11')
      await user.click(link)
      expect(screen.getByTestId('location')).toHaveTextContent('/streams/new')
    },
  )

  it.each(['VIEWER', 'GOVERNANCE_OPERATOR', 'GOVERNANCE_AUDITOR'] as const)(
    'does not offer New data flow to %s',
    (role) => {
      persistTestSession(role)
      renderHeader()
      expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
    },
  )

  it.each([
    ['expired', { expires_at: '2020-01-01T00:00:00Z' }],
    ['inactive', { status: 'DISABLED' }],
    ['must reset password', { must_change_password: true }],
  ])('does not offer New data flow to an Administrator with %s session', (_, overrides) => {
    persistTestSession('ADMINISTRATOR')
    const session = readSession()
    expect(session).not.toBeNull()
    persistSession({
      ...session!,
      ...('expires_at' in overrides ? { expires_at: overrides.expires_at } : {}),
      user: { ...session!.user, ...('status' in overrides ? { status: overrides.status } : {}), ...('must_change_password' in overrides ? { must_change_password: overrides.must_change_password } : {}) },
    })
    renderHeader()
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
  })

  it('removes the global creation CTA when the current session role changes', () => {
    persistTestSession('ADMINISTRATOR')
    renderHeader()
    expect(screen.getByRole('link', { name: 'New data flow' })).toBeInTheDocument()
    act(() => persistTestSession('VIEWER'))
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
  })

  it('hides New data flow when the server denies workspace mutations for an active Operator', () => {
    persistTestSession('OPERATOR')
    const session = readSession()!
    persistSession({
      ...session,
      user: { ...session.user, capabilities: { ...session.user.capabilities, workspace_mutations: false } },
    })
    renderHeader()
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
  })

  it('updates New data flow after a server capability downgrade and restoration', () => {
    persistTestSession('OPERATOR')
    renderHeader()
    expect(screen.getByRole('link', { name: 'New data flow' })).toBeInTheDocument()

    const session = readSession()!
    act(() => persistSession({
      ...session,
      user: { ...session.user, capabilities: { ...session.user.capabilities, workspace_mutations: false } },
    }))
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()

    const restrictedSession = readSession()!
    act(() => persistSession({
      ...restrictedSession,
      user: { ...restrictedSession.user, capabilities: { ...restrictedSession.user.capabilities, workspace_mutations: true } },
    }))
    expect(screen.getByRole('link', { name: 'New data flow' })).toBeInTheDocument()
  })

  it('does not offer a new-flow navigation link from an unfinished Wizard', () => {
    persistTestSession('ADMINISTRATOR')
    renderHeader({ initialPath: '/streams/new' })
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
  })

  it('makes New data flow available from the existing operational Data Flows page', () => {
    persistTestSession('ADMINISTRATOR')
    renderHeader({ initialPath: '/routes' })
    expect(screen.getByRole('link', { name: 'New data flow' })).toHaveAttribute('href', '/streams/new')
  })

  it('does not accept a legacy browser role hint without a valid session', () => {
    localStorage.setItem('gdc_platform_ui_role', 'ADMINISTRATOR')
    renderHeader()
    expect(screen.queryByRole('link', { name: 'New data flow' })).not.toBeInTheDocument()
  })

  it('keeps the global creation CTA out of the keyboard path while the mobile drawer is open', () => {
    persistTestSession('ADMINISTRATOR')
    renderHeader({ mobileNavOpen: true, onMobileNavToggle: () => undefined })
    expect(screen.getByRole('link', { name: 'New data flow', hidden: true }).parentElement).toHaveAttribute('inert')
  })

  it('does not render a non-functional global search control', () => {
    renderHeader()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Search streams/i)).not.toBeInTheDocument()
  })

  it('routes the global alert affordance to the operational alerts surface', async () => {
    const user = userEvent.setup()
    renderHeader()
    const alerts = screen.getByTestId('shell-health-alerts')
    expect(alerts).toHaveAttribute('aria-label', 'Open operational alerts')
    await user.click(alerts)
    expect(screen.getByTestId('location')).toHaveTextContent(SHELL_ALERTS_PATH)
  })

  it('keeps step-by-step help available from every workspace without abandoning edits', () => {
    renderHeader()
    const help = screen.getByRole('link', { name: 'Open Help Center' })
    expect(help).toHaveAttribute('href', '/help')
    expect(help).toHaveAttribute('target', '_blank')
    expect(help).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('preserves theme toggle and refresh actions', () => {
    const { onToggleTheme } = renderHeader()
    expect(screen.getByRole('button', { name: 'Toggle color theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh dashboard and runtime data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
    void onToggleTheme
  })

  it('exposes a mobile navigation toggle when provided', async () => {
    const user = userEvent.setup()
    const onMobileNavToggle = vi.fn()
    renderHeader({ mobileNavOpen: false, onMobileNavToggle })
    const toggle = screen.getByTestId('shell-mobile-nav-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'primary-navigation')
    expect(toggle).toHaveAttribute('aria-label', 'Open navigation menu')
    await user.click(toggle)
    expect(onMobileNavToggle).toHaveBeenCalled()
  })

  it('reflects open state on the mobile navigation toggle', () => {
    renderHeader({ mobileNavOpen: true, onMobileNavToggle: () => undefined })
    const toggle = screen.getByTestId('shell-mobile-nav-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-label', 'Close navigation menu')
    expect(screen.getByRole('button', { name: 'Open settings', hidden: true }).parentElement).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Toggle color theme', hidden: true }).parentElement).toHaveAttribute(
      'inert',
    )
  })

  it('does not invent Healthy, active-stream counts, or delivery state without evidence', () => {
    renderHeader()
    expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Not verified')
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument()
    expect(screen.queryByText('24 streams active · delivery path nominal')).not.toBeInTheDocument()
  })

  it('uses green health only for explicitly supplied measurements', () => {
    renderHeader({ runtimeHealthy: true })
    expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Healthy')
    cleanup()
    renderHeader({ runtimeHealthy: false })
    expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Attention')
  })
})
