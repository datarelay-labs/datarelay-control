import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { StreamDetailTabNav } from './stream-detail-tab-nav'

describe('StreamDetailTabNav', () => {
  it('styles the active tab with theme-aware foreground instead of low-contrast light violet', () => {
    render(
      <MemoryRouter>
        <StreamDetailTabNav streamId="42" active="overview" />
      </MemoryRouter>,
    )
    const active = screen.getByTestId('stream-detail-tab-overview')
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(active).toHaveClass('text-fg', 'border-accent')
    expect(active.className).not.toMatch(/\btext-violet-(200|300|400)\b/)

    const inactive = screen.getByTestId('stream-detail-tab-metrics')
    expect(inactive).toHaveClass('text-fg-secondary')
    expect(inactive.className).not.toMatch(/hover:text-slate-300/)
  })
})
