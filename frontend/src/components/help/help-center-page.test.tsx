import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { HelpCenterPage } from './help-center-page'

function openGuide(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help" element={<HelpCenterPage />} />
        <Route path="/help/:topic" element={<HelpCenterPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Control in-product workflow help', () => {
  it('shows a stable help directory with links to actual in-product topics', () => {
    openGuide('/help')
    expect(screen.getByRole('heading', { name: 'Help Center' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Set up your first stream/i })).toHaveAttribute('href', '/help/start')
    expect(screen.getByRole('link', { name: /Investigate data flow/i })).toHaveAttribute('href', '/help/operations')
    expect(screen.getByRole('link', { name: /Route delivery and previews/i })).toHaveAttribute('href', '/help/delivery')
    expect(screen.getByRole('link', { name: /Governance investigations/i })).toHaveAttribute('href', '/help/governance')
    expect(screen.getByRole('link', { name: /Platform administration/i })).toHaveAttribute('href', '/help/administration')
  })

  it.each([
    ['/help/start', 'Set up your first stream', 'Choose destinations', '/streams/new'],
    ['/help/operations', 'Investigate data flow', 'Runtime truth', '/monitoring'],
    ['/help/delivery', 'Route delivery and previews', 'A preview is not delivery', '/routes'],
    ['/help/governance', 'Governance investigations', 'Governance Dashboard', '/governance'],
    ['/help/administration', 'Platform administration', 'Access & security', '/admin'],
  ])('provides a useful guide at %s with working UI links', (path, title, copy, link) => {
    openGuide(path)
    const guide = screen.getByTestId('help-guide')
    expect(within(guide).getByRole('heading', { name: title })).toBeInTheDocument()
    expect(guide).toHaveTextContent(copy)
    expect(within(guide).getAllByRole('link').some((a) => a.getAttribute('href') === link)).toBe(true)
    expect(within(guide).getByRole('link', { name: 'All guides' })).toHaveAttribute('href', '/help')
  })

  it('does not invent a guide for unknown topics', () => {
    openGuide('/help/does-not-exist')
    expect(screen.getByText('This guide is not available.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All guides' })).toHaveAttribute('href', '/help')
  })
})
