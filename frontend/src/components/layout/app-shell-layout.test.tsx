import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShellLayout } from './app-shell-layout'
import { MAIN_CONTENT_ID } from '../shell/app-shell'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { getOperationalSnapshot } from '../../api/operationalSnapshot'
import { isRuntimeFixtureModeActive } from '../../lib/runtime-operational-fixture-mode'

const mediaState = vi.hoisted(() => ({ isMdUp: false }))

vi.mock('../../hooks/use-media-query', () => ({
  useIsMdUp: () => mediaState.isMdUp,
  useMediaQuery: () => mediaState.isMdUp,
}))

vi.mock('../../hooks/use-shell-route-labels', () => ({
  useShellRouteLabels: () => ({
    stream: null,
    connector: null,
    destination: null,
    route: null,
    mappingEdit: null,
    loading: false,
  }),
}))

vi.mock('../../hooks/use-stream-source-type-for-api-test-shell', () => ({
  useStreamSourceTypeForApiTestShell: () => null,
}))

vi.mock('../../api/gdcAdmin', () => ({
  postAuthLogout: vi.fn(() => Promise.resolve(undefined)),
  getAdminSystemInfo: vi.fn(async () => ({ app_env: 'development' })),
}))

vi.mock('../../api/operationalSnapshot', () => ({
  getOperationalSnapshot: vi.fn(async () => null),
  clearOperationalSnapshotCache: vi.fn(),
}))

vi.mock('../../lib/runtime-operational-fixture-mode', () => ({
  isRuntimeFixtureModeActive: vi.fn(async () => false),
}))

function renderShell(initialPath = '/streams') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AppShellLayout />}>
          <Route path="/streams" element={<p>Streams workspace</p>} />
          <Route path="/destinations" element={<p>Destinations workspace</p>} />
          <Route path="/monitoring" element={<p>Dashboard workspace</p>} />
          <Route path="/admin" element={<p>Administration workspace</p>} />
          <Route path="/routes" element={<p>Routes workspace</p>} />
          <Route path="/help/:topic" element={<p>In-product help guide</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AppShellLayout responsive accessibility', () => {
  beforeEach(() => {
    mediaState.isMdUp = false
    persistTestSession('ADMINISTRATOR', 'shell-tester')
    vi.mocked(getOperationalSnapshot).mockReset().mockResolvedValue(null)
    vi.mocked(isRuntimeFixtureModeActive).mockReset().mockResolvedValue(false)
  })

  afterEach(() => {
    cleanup()
    clearTestSession()
    localStorage.removeItem('gdc.colorScheme')
  })

  it('keeps the Foundation theme attribute aligned with the existing Control theme toggle', async () => {
    localStorage.setItem('gdc.colorScheme', 'dark')
    const user = userEvent.setup()
    renderShell()

    const documentRoot = document.documentElement
    const shell = document.querySelector('div[data-dr-theme]')
    const portalProbe = document.createElement('div')
    document.body.appendChild(portalProbe)

    expect(documentRoot).toHaveAttribute('data-dr-theme', 'dark')
    expect(portalProbe.closest('[data-dr-theme]')).toBe(documentRoot)
    expect(shell).toHaveAttribute('data-dr-theme', 'dark')
    expect(shell).toHaveClass('dark')

    await user.click(screen.getByRole('button', { name: 'Toggle color theme' }))

    expect(documentRoot).toHaveAttribute('data-dr-theme', 'light')
    expect(portalProbe.closest('[data-dr-theme]')).toBe(documentRoot)
    expect(shell).toHaveAttribute('data-dr-theme', 'light')
    expect(shell).not.toHaveClass('dark')
    portalProbe.remove()
  })

  it('exposes a skip link that targets the main landmark', () => {
    renderShell()
    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skip).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`)
    expect(skip).toHaveClass('gdc-skip-link')
    expect(skip).not.toHaveAttribute('inert')
    expect(document.getElementById(MAIN_CONTENT_ID)?.tagName).toBe('MAIN')
    expect(screen.getByRole('main')).toHaveTextContent('Streams workspace')
  })

  it('makes the skip link inert while the mobile drawer is open', async () => {
    const user = userEvent.setup()
    renderShell()
    const toggle = screen.getByTestId('shell-mobile-nav-toggle')
    expect(screen.getByRole('link', { name: 'Skip to main content' })).not.toHaveAttribute('inert')

    await user.click(toggle)
    const skip = screen.getByRole('link', { name: 'Skip to main content', hidden: true })
    expect(skip).toHaveAttribute('inert')
    expect(skip).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`)
    expect(skip).toHaveClass('gdc-skip-link')

    await user.click(toggle)
    expect(screen.getByRole('link', { name: 'Skip to main content' })).not.toHaveAttribute('inert')
  })

  it('keeps desktop sidebar collapse available when md-up', async () => {
    mediaState.isMdUp = true
    const user = userEvent.setup()
    renderShell()
    const collapse = screen.getByRole('button', { name: 'Collapse menu' })
    expect(document.getElementById('primary-navigation')).not.toHaveAttribute('inert')
    await user.click(collapse)
    expect(screen.getByRole('button', { name: 'Expand menu' })).toBeInTheDocument()
  })

  it('toggles mobile navigation with aria-expanded / aria-controls', async () => {
    const user = userEvent.setup()
    renderShell()
    const toggle = screen.getByTestId('shell-mobile-nav-toggle')
    const nav = document.getElementById('primary-navigation')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', 'primary-navigation')
    expect(nav).toHaveAttribute('data-mobile-open', 'false')
    expect(nav).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Open settings' }).parentElement).not.toHaveAttribute('inert')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(nav).toHaveAttribute('data-mobile-open', 'true')
    expect(nav).not.toHaveAttribute('inert')
    expect(screen.getByRole('main')).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Open settings', hidden: true }).parentElement).toHaveAttribute(
      'inert',
    )

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).toHaveAttribute('data-mobile-open', 'false')
    expect(nav).toHaveAttribute('inert')
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
  })

  it('moves focus into navigation on open and returns it to the trigger on close', async () => {
    const user = userEvent.setup()
    renderShell()
    const toggle = screen.getByTestId('shell-mobile-nav-toggle')
    await user.click(toggle)
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('complementary', { name: 'Primary navigation' }))
    })

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(document.activeElement).toBe(toggle)
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes mobile navigation after successful navigation', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByTestId('shell-mobile-nav-toggle'))
    const nav = screen.getByRole('complementary', { name: 'Primary navigation' })
    await user.click(within(nav).getByRole('button', { name: 'Delivery' }))
    expect(within(nav).getByRole('button', { name: 'Delivery' })).toHaveAttribute('aria-expanded', 'true')
    await user.click(within(nav).getByRole('button', { name: 'Destinations' }))
    expect(screen.getByRole('main')).toHaveTextContent('Destinations workspace')
    expect(screen.getByTestId('shell-mobile-nav-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(nav).toHaveAttribute('data-mobile-open', 'false')
  })

  it('closes mobile navigation via backdrop', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByTestId('shell-mobile-nav-toggle'))
    await user.click(screen.getByRole('button', { name: 'Close navigation' }))
    expect(screen.getByTestId('shell-mobile-nav-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('labels an in-product help guide correctly instead of displaying operational status', () => {
    renderShell('/help/delivery')
    expect(screen.getByRole('heading', { level: 1, name: 'Help Center' })).toBeInTheDocument()
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(breadcrumb).getByRole('link', { name: 'Help Center' })).toHaveAttribute('href', '/help')
    expect(breadcrumb).toHaveTextContent('Workflow guide')
    expect(screen.getByText('In-product help guide')).toBeInTheDocument()
    expect(screen.getByText(/In-product workflow guidance/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Runtime status')).not.toBeInTheDocument()
  })

  it('uses the fresh authenticated operational snapshot for global health instead of default green', async () => {
    vi.mocked(getOperationalSnapshot).mockResolvedValue({
      updated_at: new Date().toISOString(),
      global: { health_status: 'HEALTHY', running_streams: 2, enabled_streams: 2, total_routes: 3 },
    } as Awaited<ReturnType<typeof getOperationalSnapshot>> & object)
    renderShell('/monitoring')
    await waitFor(() => {
      expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Healthy')
    })
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveTextContent('2 running / 2 enabled Streams · 3 Routes')
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveTextContent('Receiver ingestion is not verified')
    expect(getOperationalSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not label an unavailable snapshot as Offline or Healthy', async () => {
    renderShell('/routes')
    await waitFor(() => {
      expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Not verified')
    })
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveTextContent('Runtime snapshot unavailable')
    expect(screen.queryByText(/^Offline$/)).not.toBeInTheDocument()
  })

  it('revalidates observed runtime health on the existing shell refresh action', async () => {
    vi.mocked(getOperationalSnapshot).mockResolvedValueOnce({
      updated_at: new Date().toISOString(),
      global: { health_status: 'HEALTHY', running_streams: 2, enabled_streams: 2, total_routes: 3 },
    } as Awaited<ReturnType<typeof getOperationalSnapshot>> & object)
    vi.mocked(getOperationalSnapshot).mockResolvedValue({
      updated_at: new Date().toISOString(),
      global: { health_status: 'ERROR', running_streams: 1, enabled_streams: 2, total_routes: 3 },
    } as Awaited<ReturnType<typeof getOperationalSnapshot>> & object)
    const user = userEvent.setup()
    renderShell('/streams')
    await waitFor(() => expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Healthy'))
    await user.click(screen.getByRole('button', { name: 'Refresh dashboard and runtime data' }))
    await waitFor(() => expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Attention'))
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveTextContent('error')
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveAttribute('aria-atomic', 'true')
    expect(getOperationalSnapshot).toHaveBeenCalledTimes(2)
  })

  it('does not treat an opted-in development fixture as live runtime health', async () => {
    vi.mocked(isRuntimeFixtureModeActive).mockResolvedValue(true)
    vi.mocked(getOperationalSnapshot).mockResolvedValue({
      updated_at: new Date().toISOString(),
      global: { health_status: 'HEALTHY', running_streams: 2, enabled_streams: 2, total_routes: 3 },
    } as Awaited<ReturnType<typeof getOperationalSnapshot>> & object)
    renderShell('/monitoring')
    await waitFor(() => expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Fixture'))
    expect(screen.getByTestId('shell-runtime-evidence')).toHaveTextContent('not live runtime')
  })

  it('gives Dashboard a single shell title without a repeated breadcrumb', () => {
    renderShell('/monitoring')
    expect(screen.getAllByRole('heading', { name: 'Dashboard' })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByText(/^Dashboard$/)).not.toBeInTheDocument()
  })

  it('gives Administration a single shell title without a repeated breadcrumb', () => {
    renderShell('/admin')
    expect(screen.getAllByRole('heading', { name: 'Administration' })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByText(/^Administration$/)).not.toBeInTheDocument()
  })

  it('gives Routes a single shell title', () => {
    renderShell('/routes')
    expect(screen.getAllByRole('heading', { name: 'Routes' })).toHaveLength(1)
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
  })

  it('preserves primary navigation role and persona-facing nav labels', () => {
    renderShell('/monitoring')
    const nav = screen.getByRole('complementary', { name: 'Primary navigation', hidden: true })
    expect(within(nav).getByRole('button', { name: 'Streams', hidden: true })).toBeInTheDocument()
    expect(
      within(nav).getByRole('button', { name: 'Dashboard', current: 'page', hidden: true }),
    ).toBeInTheDocument()
    expect(within(nav).getByText('Data Sources')).toBeInTheDocument()
    expect(within(nav).getByText('Delivery')).toBeInTheDocument()
    expect(screen.getByTestId('shell-environment-status')).toHaveAttribute('role', 'status')
  })
})
