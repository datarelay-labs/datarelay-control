import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHELL_ALERTS_PATH, TopHeader } from './top-header'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderHeader(opts?: { mobileNavOpen?: boolean; onMobileNavToggle?: () => void }) {
  const onToggleTheme = vi.fn()
  render(
    <MemoryRouter initialEntries={['/monitoring']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <TopHeader
                title="Dashboard"
                isDark={false}
                onToggleTheme={onToggleTheme}
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
  })

  it('does not render a non-functional global search control', () => {
    renderHeader()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Search streams/i)).not.toBeInTheDocument()
  })

  it('routes the health affordance to validation alerts with truthful labeling', async () => {
    const user = userEvent.setup()
    renderHeader()
    const alerts = screen.getByTestId('shell-health-alerts')
    expect(alerts).toHaveAttribute('aria-label', 'Open runtime health alerts')
    await user.click(alerts)
    expect(screen.getByTestId('location')).toHaveTextContent(SHELL_ALERTS_PATH)
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
    await user.click(toggle)
    expect(onMobileNavToggle).toHaveBeenCalled()
  })

  it('shows a calmer healthy runtime status label', () => {
    renderHeader()
    expect(screen.getByLabelText('Runtime status')).toHaveTextContent('Healthy')
    expect(screen.queryByText('RUN')).not.toBeInTheDocument()
  })
})
