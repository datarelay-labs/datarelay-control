import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { StatusChip, type StatusChipStatus } from './status-chip'

const STATES: Array<[StatusChipStatus, string, string]> = [
  ['healthy', 'Healthy', 'text-status-success'],
  ['degraded', 'Degraded', 'text-status-warning'],
  ['warning', 'Warning', 'text-status-warning'],
  ['critical', 'Critical', 'text-status-critical'],
  ['unknown', 'Unknown', 'text-status-unknown'],
  ['stale', 'Stale', 'text-status-unknown'],
  ['neutral', 'Not applicable', 'text-fg-secondary'],
]

describe('StatusChip', () => {
  it.each(STATES)('renders %s with an icon, a visible default label and its status colour', (status, label, colour) => {
    const { container } = render(<StatusChip status={status} />)
    const chip = container.firstElementChild as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip).toHaveAttribute('data-status', status)
    expect(chip).toHaveTextContent(label)
    expect(chip).toHaveClass(colour)
    const icon = chip.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('data-status-icon', status)
  })

  it('never lets colour be the only signal: every state has a distinct icon and label', () => {
    const icons = new Set<string>()
    const labels = new Set<string>()
    for (const [status] of STATES) {
      const { container, unmount } = render(<StatusChip status={status} />)
      icons.add(container.querySelector('svg')?.innerHTML ?? '')
      labels.add(container.textContent ?? '')
      unmount()
    }
    expect(icons.size).toBe(STATES.length)
    expect(labels.size).toBe(STATES.length)
  })

  it('keeps unknown and stale visually distinct from healthy', () => {
    const { container } = render(
      <>
        <StatusChip status="healthy" />
        <StatusChip status="unknown" />
        <StatusChip status="stale" />
      </>,
    )
    const [healthy, unknown, stale] = Array.from(container.children) as HTMLElement[]
    for (const unmeasured of [unknown, stale]) {
      expect(unmeasured).toHaveClass('text-status-unknown', 'bg-status-unknown-subtle', 'border-dashed')
      expect(unmeasured).not.toHaveClass('text-status-success')
      expect(unmeasured).not.toHaveClass('bg-status-success-subtle')
    }
    expect(healthy).not.toHaveClass('border-dashed')
  })

  it('renders children as the visible label instead of the default', () => {
    render(<StatusChip status="neutral">Stopped</StatusChip>)
    expect(screen.getByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
  })

  it('forwards className, role, aria and data attributes on the span', () => {
    render(
      <StatusChip status="critical" className="ml-2" role="status" aria-label="Route health critical" data-testid="chip" title="t">
        Error
      </StatusChip>,
    )
    const chip = screen.getByTestId('chip')
    expect(chip.tagName).toBe('SPAN')
    expect(chip).toHaveClass('ml-2', 'text-status-critical')
    expect(chip).toHaveAttribute('title', 't')
    expect(screen.getByRole('status', { name: 'Route health critical' })).toBe(chip)
  })

  it('supports sm (default) and md sizes with semantic type roles', () => {
    const { rerender } = render(<StatusChip status="healthy" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveClass('text-caption')
    rerender(<StatusChip status="healthy" size="md" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveClass('text-body-sm')
    expect(screen.getByTestId('chip')).not.toHaveClass('text-caption')
  })

  it('keeps the type role when merged with the status colour', () => {
    render(<StatusChip status="warning" data-testid="chip" />)
    expect(screen.getByTestId('chip')).toHaveClass('text-caption', 'text-status-warning')
  })

  it.each(STATES)('emits only semantic alias classes for %s', (status) => {
    const { container } = render(<StatusChip status={status} size="md" />)
    expectOnlySemanticClasses(container.firstElementChild as Element)
  })
})
