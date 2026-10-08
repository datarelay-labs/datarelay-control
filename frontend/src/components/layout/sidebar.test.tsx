import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_STRUCTURE } from '../../config/app-navigation'
import { persistTestSession, clearTestSession } from '../../lib/governance-rbac'
import { Sidebar } from './sidebar'

vi.mock('../../api/gdcAdmin', () => ({
  postAuthLogout: vi.fn(() => Promise.resolve(undefined)),
  getAdminSystemInfo: vi.fn(async () => ({ app_env: 'development' })),
}))

function renderSidebar(opts?: { pathname?: string; mobileOpen?: boolean; collapsed?: boolean }) {
  const onNavigate = vi.fn()
  const onMobileClose = vi.fn()
  const onToggleCollapsed = vi.fn()
  const onPersonaChange = vi.fn()
  render(
    <MemoryRouter>
      <Sidebar
        structure={SIDEBAR_STRUCTURE}
        collapsed={opts?.collapsed ?? false}
        mobileOpen={opts?.mobileOpen ?? false}
        pathname={opts?.pathname ?? '/streams'}
        persona="connector"
        onPersonaChange={onPersonaChange}
        onToggleCollapsed={onToggleCollapsed}
        onNavigate={onNavigate}
        onMobileClose={onMobileClose}
      />
    </MemoryRouter>,
  )
  return { onNavigate, onMobileClose, onToggleCollapsed }
}

describe('Sidebar SaaS shell', () => {
  afterEach(() => {
    cleanup()
    clearTestSession()
  })

  it('renders primary navigation structure with calm group labels', () => {
    persistTestSession('ADMINISTRATOR')
    renderSidebar({ pathname: '/monitoring' })
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(within(nav).getByText('Data Sources')).toBeInTheDocument()
    expect(within(nav).getByText('Delivery')).toBeInTheDocument()
    expect(within(nav).getByText('Governance')).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Streams' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Routes' })).toBeInTheDocument()
  })

  it('provides a prominent create action for authorized Stream operators, including mobile', async () => {
    persistTestSession('CONNECTOR_OPERATOR')
    const user = userEvent.setup()
    const { onNavigate, onMobileClose } = renderSidebar({ mobileOpen: true })
    await user.click(screen.getByTestId('sidebar-create-stream'))
    expect(onNavigate).toHaveBeenCalledWith('/streams/new')
    expect(onMobileClose).toHaveBeenCalled()
  })

  it('does not advertise a create action to read-only and governance-only roles', () => {
    persistTestSession('VIEWER')
    renderSidebar()
    expect(screen.queryByTestId('sidebar-create-stream')).not.toBeInTheDocument()
  })

  it('marks the active leaf with aria-current=page', () => {
    renderSidebar({ pathname: '/destinations' })
    expect(screen.getByRole('button', { name: 'Destinations' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Streams' })).not.toHaveAttribute('aria-current')
  })

  it('exposes the runtime environment as an informational status, not a selector', async () => {
    renderSidebar()
    const status = screen.getByTestId('shell-environment-status')
    expect(status).toHaveAttribute('role', 'status')
    expect(status.tagName).toBe('DIV')
    expect(within(status).queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Environment/i })).not.toBeInTheDocument()
    await waitFor(() => expect(status).toHaveAttribute('aria-label', 'Environment: Development'))
    expect(within(status).getByText('Development')).toBeInTheDocument()
    expect(within(status).queryByText('Production')).not.toBeInTheDocument()
  })

  it('closes the mobile drawer after navigation', async () => {
    const user = userEvent.setup()
    const { onNavigate, onMobileClose } = renderSidebar({ mobileOpen: true })
    await user.click(screen.getByRole('button', { name: 'Streams' }))
    expect(onNavigate).toHaveBeenCalledWith('/streams')
    expect(onMobileClose).toHaveBeenCalled()
  })

  it('records mobile open state for the drawer', () => {
    renderSidebar({ mobileOpen: true })
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute(
      'data-mobile-open',
      'true',
    )
  })

  it('exposes the desktop collapse control and keeps the aside focusable', async () => {
    const user = userEvent.setup()
    const { onToggleCollapsed } = renderSidebar({ collapsed: false })
    const aside = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(aside).toHaveAttribute('tabIndex', '-1')
    const collapse = screen.getByRole('button', { name: 'Collapse menu' })
    await user.click(collapse)
    expect(onToggleCollapsed).toHaveBeenCalled()
  })
})
