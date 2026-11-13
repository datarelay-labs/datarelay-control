import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge, type StatusTone } from './status-badge'

const TONES: Array<[StatusTone, string]> = [
  ['success', 'status-success'],
  ['warning', 'status-warning'],
  ['error', 'status-critical'],
  ['neutral', 'status-unknown'],
  ['info', 'status-info'],
]

describe('StatusBadge', () => {
  it.each(TONES)('renders the %s tone from the %s semantic aliases', (tone, family) => {
    render(<StatusBadge tone={tone}>Label</StatusBadge>)
    const badge = screen.getByText('Label')
    expect(badge.tagName).toBe('SPAN')
    expect(badge).toHaveClass(`text-${family}`, `bg-${family}-subtle`, `border-${family}-border`)
  })

  it.each(TONES)('uses no raw palette or dark: pair classes for %s', (tone) => {
    render(<StatusBadge tone={tone}>Label</StatusBadge>)
    const className = screen.getByText('Label').className
    for (const fragment of ['dark:', 'emerald-', 'amber-', 'red-', 'slate-', 'sky-']) {
      expect(className).not.toContain(fragment)
    }
  })

  it('keeps the existing shape, size and attribute passthrough', () => {
    render(
      <StatusBadge tone="success" className="uppercase" data-testid="badge" title="state" role="status">
        RUNNING
      </StatusBadge>,
    )
    const badge = screen.getByTestId('badge')
    expect(badge).toHaveClass('inline-flex', 'rounded', 'border', 'px-1.5', 'py-px', 'text-[11px]', 'font-medium', 'tabular-nums', 'uppercase')
    expect(badge).toHaveAttribute('title', 'state')
    expect(screen.getByRole('status')).toHaveTextContent('RUNNING')
  })

  it('still lets a caller className override the default size', () => {
    render(<StatusBadge tone="info" className="text-sm">Big</StatusBadge>)
    const badge = screen.getByText('Big')
    expect(badge).toHaveClass('text-sm', 'text-status-info')
    expect(badge).not.toHaveClass('text-[11px]')
  })
})
