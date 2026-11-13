import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { MetricTile } from './metric-tile'

function valueOf(tile: HTMLElement): HTMLElement {
  const value = tile.querySelector('[data-metric-value]')
  if (!(value instanceof HTMLElement)) throw new Error('metric value not rendered')
  return value
}

describe('MetricTile', () => {
  it('renders label, value, unit and caption with the semantic type roles', () => {
    render(
      <MetricTile label="Events / sec" value={12.4} unit="EPS" caption="Operational snapshot · 5m window" data-testid="tile" />,
    )
    const tile = screen.getByTestId('tile')
    expect(tile.tagName).toBe('DIV')
    expect(tile).toHaveClass('bg-surface-card', 'border-default')
    expect(screen.getByText('Events / sec')).toHaveClass('text-label', 'text-fg-secondary')
    const value = valueOf(tile)
    expect(value).toHaveTextContent('12.4')
    expect(value).toHaveClass('text-metric', 'tabular-nums', 'text-fg')
    expect(value).not.toHaveAttribute('data-unknown')
    expect(screen.getByText('EPS')).toBeInTheDocument()
    expect(screen.getByText('Operational snapshot · 5m window')).toHaveClass('text-caption', 'text-fg-muted')
  })

  it('renders a measured zero as 0', () => {
    render(<MetricTile label="Failed deliveries" value={0} data-testid="tile" />)
    expect(valueOf(screen.getByTestId('tile'))).toHaveTextContent(/^0$/)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['NaN', Number.NaN],
  ])('renders %s as a visible Unknown in the unknown style, never 0 or blank', (_name, raw) => {
    render(<MetricTile label="Delivery success" value={raw} unit="%" data-testid="tile" />)
    const value = valueOf(screen.getByTestId('tile'))
    expect(value).toHaveTextContent('Unknown')
    expect(value).toHaveAttribute('data-unknown', 'true')
    expect(value).toHaveClass('text-status-unknown', 'text-metric')
    expect(value).not.toHaveClass('text-fg')
    expect(screen.queryByText('%')).not.toBeInTheDocument()
    expect(screen.getByTestId('tile')).not.toHaveTextContent(/\b0\b/)
  })

  it('uses a caller-supplied unknown label', () => {
    render(<MetricTile label="Latency" value={null} unknownLabel="Not verified" data-testid="tile" />)
    expect(valueOf(screen.getByTestId('tile'))).toHaveTextContent('Not verified')
  })

  it('shows an optional status chip', () => {
    render(<MetricTile label="Routes" value={3} status="warning" data-testid="tile" />)
    const chip = screen.getByTestId('tile').querySelector('[data-status="warning"]')
    expect(chip).not.toBeNull()
    expect(chip).toHaveTextContent('Warning')
  })

  it('renders as a link when href is given', () => {
    render(<MetricTile label="Streams" value={4} href="/streams" data-testid="tile" />)
    const link = screen.getByRole('link', { name: /Streams/ })
    expect(link).toHaveAttribute('href', '/streams')
    expect(link).toBe(screen.getByTestId('tile'))
    expect(link).toHaveClass('focus-visible:ring-focus-ring')
  })

  it('renders as a button when only onClick is given', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<MetricTile label="Errors" value={2} onClick={onClick} data-testid="tile" />)
    const button = screen.getByRole('button', { name: /Errors/ })
    expect(button).toHaveAttribute('type', 'button')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('emits only semantic alias classes', () => {
    render(
      <>
        <MetricTile label="A" value={1} unit="u" caption="c" status="healthy" data-testid="known" href="/a" />
        <MetricTile label="B" value={null} caption="c" status="unknown" data-testid="unknown" />
      </>,
    )
    expectOnlySemanticClasses(screen.getByTestId('known'))
    expectOnlySemanticClasses(screen.getByTestId('unknown'))
  })
})
