import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AppShell, MAIN_CONTENT_ID } from './app-shell'

describe('AppShell landmarks', () => {
  afterEach(() => {
    cleanup()
  })

  it('exposes a stable main landmark for routed workspace content', () => {
    render(
      <MemoryRouter>
        <AppShell sidebar={<aside>nav</aside>} header={<header>header</header>}>
          <p>Workspace body</p>
        </AppShell>
      </MemoryRouter>,
    )
    const main = screen.getByRole('main')
    expect(main).toHaveAttribute('id', MAIN_CONTENT_ID)
    expect(main).toHaveTextContent('Workspace body')
  })

  it('marks workspace content inert while the mobile drawer is open', () => {
    render(
      <MemoryRouter>
        <AppShell
          mobileNavOpen
          onMobileNavClose={() => undefined}
          sidebar={<aside>nav</aside>}
          header={<header>header</header>}
        >
          <button type="button">Inside workspace</button>
        </AppShell>
      </MemoryRouter>,
    )
    expect(screen.getByRole('main')).toHaveAttribute('inert')
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument()
  })
})
