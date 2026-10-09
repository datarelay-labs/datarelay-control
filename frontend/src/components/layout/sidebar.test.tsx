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
    const sources = within(nav).getByRole('button', { name: 'Data Sources' })
    const delivery = within(nav).getByRole('button', { name: 'Delivery' })
    const governance = within(nav).getByRole('button', { name: 'Governance' })
    expect(sources).toHaveAttribute('aria-expanded', 'false')
    expect(delivery).toHaveAttribute('aria-expanded', 'false')
    expect(governance).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).queryByRole('button', { name: 'Streams' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Routes' })).not.toBeInTheDocument()

    await user.click(sources)
    expect(sources).toHaveAttribute('aria-expanded', 'true')
    expect(sources).toHaveAttribute('aria-controls', 'sidebar-group-dataSources')
    expect(within(nav).getByRole('button', { name: 'Connectors' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Streams' })).toBeInTheDocument()

    await user.click(delivery)
    expect(delivery).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getByRole('button', { name: 'Destinations' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Routes' })).toBeInTheDocument()

    await user.click(sources)
    expect(sources).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).queryByRole('button', { name: 'Streams' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Routes' })).toBeInTheDocument()
  })

  it('keeps compact desktop navigation groups keyboard-accessible by name', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderSidebar({ collapsed: true, pathname: '/monitoring' })
    const sources = screen.getByRole('button', { name: 'Data Sources' })
    expect(sources).toHaveAttribute('title', 'Data Sources')
    expect(sources).toHaveAttribute('aria-expanded', 'false')
    await user.click(sources)
    expect(sources).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('button', { name: 'Streams' }))
    expect(onNavigate).toHaveBeenCalledWith('/streams')
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
    expect(screen.getByRole('button', { name: 'Delivery' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Data Sources' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Destinations' })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('button', { name: 'Data Sources' }))
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
