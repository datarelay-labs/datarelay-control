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

  it('keeps the primary sections discoverable and discloses nested destinations on demand', async () => {
    persistTestSession('ADMINISTRATOR')
    const user = userEvent.setup()
    renderSidebar({ pathname: '/monitoring' })
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    const connections = within(nav).getByRole('button', { name: 'Connections' })
    const governance = within(nav).getByRole('button', { name: 'Governance' })
    await user.click(governance)
    expect(within(nav).getByRole('button', { name: 'Governance Dashboard' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Governance Workspace' })).not.toBeInTheDocument()
    await user.click(governance)
    expect(connections).toHaveAttribute('aria-expanded', 'false')
    expect(governance).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).getByRole('button', { name: 'Streams' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Data Flows' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Connectors' })).not.toBeInTheDocument()

    await user.click(connections)
    expect(connections).toHaveAttribute('aria-expanded', 'true')
    expect(connections).toHaveAttribute('aria-controls', 'sidebar-group-connections')
    expect(within(nav).getByRole('button', { name: 'Connectors' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Destinations' })).toBeInTheDocument()

    await user.click(connections)
    expect(connections).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).queryByRole('button', { name: 'Connectors' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Streams' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Data Flows' })).toBeInTheDocument()
  })

  it('keeps compact desktop navigation groups keyboard-accessible by name', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderSidebar({ collapsed: true, pathname: '/monitoring' })
    const connections = screen.getByRole('button', { name: 'Connections' })
    expect(connections).toHaveAttribute('title', 'Connections')
    expect(connections).toHaveAttribute('aria-expanded', 'false')
    await user.click(connections)
    expect(connections).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Destinations' }))
    expect(onNavigate).toHaveBeenCalledWith('/destinations')
    await user.click(screen.getByRole('button', { name: 'Data Flows' }))
    expect(onNavigate).toHaveBeenCalledWith('/routes')
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

  it('automatically expands the active group and marks only its active leaf', async () => {
    const user = userEvent.setup()
    renderSidebar({ pathname: '/destinations' })
    expect(screen.getByRole('button', { name: 'Connections' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Destinations' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Streams' })).not.toHaveAttribute('aria-current')
    await user.click(screen.getByRole('button', { name: 'Data Flows' }))
    expect(screen.getByRole('button', { name: 'Connections' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('highlights the existing Data Flows operational path as a standalone primary leaf', () => {
    renderSidebar({ pathname: '/routes' })
    expect(screen.getByRole('button', { name: 'Data Flows' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Connections' })).toHaveAttribute('aria-expanded', 'false')
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

  it('keeps the mobile drawer full width when desktop sidebar is collapsed', () => {
    renderSidebar({ mobileOpen: true, collapsed: true })
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    expect(nav).toHaveClass('w-[260px]')
    expect(nav).toHaveClass('md:w-[57px]')
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
