import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShellLayout } from './app-shell-layout'
import { MAIN_CONTENT_ID } from '../shell/app-shell'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'

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
}))

function renderShell(initialPath = '/streams') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AppShellLayout />}>
          <Route path="/streams" element={<p>Streams workspace</p>} />
          <Route path="/destinations" element={<p>Destinations workspace</p>} />
          <Route path="/monitoring" element={<p>Dashboard workspace</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('AppShellLayout responsive accessibility', () => {
  beforeEach(() => {
    mediaState.isMdUp = false
    persistTestSession('ADMINISTRATOR', 'shell-tester')
  })

  afterEach(() => {
    cleanup()
    clearTestSession()
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
