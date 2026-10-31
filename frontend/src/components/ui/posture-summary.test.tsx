import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { PostureSummary } from './posture-summary'

function counter(group: HTMLElement, key: string): HTMLElement {
  const element = group.querySelector(`[data-posture-count="${key}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`counter ${key} not rendered`)
  return element
}

describe('PostureSummary', () => {
  it('renders a labelled group with every counter, including zeros, in order', () => {
    render(
      <PostureSummary label="Stream posture" counts={{ healthy: 1, warning: 0, critical: 0, unknown: 0 }} summary="No action needed" />,
    )
    const group = screen.getByRole('group', { name: 'Stream posture' })
    expect(group).toHaveTextContent('Healthy 1·Warning 0·Critical 0·Unknown 0')
    expect(counter(group, 'healthy')).toHaveTextContent('Healthy 1')
    expect(counter(group, 'warning')).toHaveTextContent('Warning 0')
    expect(counter(group, 'critical')).toHaveTextContent('Critical 0')
    expect(counter(group, 'unknown')).toHaveTextContent('Unknown 0')
    expect(group.querySelector('[data-posture-count="stale"]')).toBeNull()
  })

  it('renders each counter as a status chip with icon and status colour', () => {
    render(<PostureSummary label="Posture" counts={{ healthy: 2, warning: 1, critical: 3, unknown: 4 }} />)
    const group = screen.getByRole('group', { name: 'Posture' })
    const expected: Array<[string, string]> = [
      ['healthy', 'text-status-success'],
      ['warning', 'text-status-warning'],
      ['critical', 'text-status-critical'],
      ['unknown', 'text-status-unknown'],
    ]
    for (const [key, colour] of expected) {
      const chip = counter(group, key).querySelector('[data-status]')
      expect(chip).toHaveClass(colour)
      expect(chip?.querySelector('svg')).not.toBeNull()
    }
  })

  it('renders the optional stale counter, including zero', () => {
    render(<PostureSummary label="Posture" counts={{ healthy: 0, warning: 0, critical: 0, unknown: 0, stale: 0 }} />)
    const group = screen.getByRole('group', { name: 'Posture' })
    expect(counter(group, 'stale')).toHaveTextContent('Stale 0')
    expect(counter(group, 'stale').querySelector('[data-status]')).toHaveAttribute('data-status', 'stale')
  })

  it('shows the caller-supplied sentence verbatim and does not compute health', () => {
    render(
      <PostureSummary
        label="Posture"
        counts={{ healthy: 0, warning: 0, critical: 5, unknown: 0 }}
        summary="Caller says everything is fine"
      />,
    )
    const group = screen.getByRole('group', { name: 'Posture' })
    expect(within(group).getByText('Caller says everything is fine')).toHaveAttribute('data-posture-summary')
    expect(group.querySelector('[data-posture-summary][data-status]')).toBeNull()
  })

  it('shows the summary as a status chip when the caller supplies a posture', () => {
    render(
      <PostureSummary
        label="Posture"
        counts={{ healthy: 1, warning: 1, critical: 0, unknown: 0 }}
        summary="1 stream needs attention"
        posture="warning"
      />,
    )
    const summary = screen.getByRole('group', { name: 'Posture' }).querySelector('[data-posture-summary]')
    expect(summary).toHaveAttribute('data-status', 'warning')
    expect(summary).toHaveTextContent('1 stream needs attention')
  })

  it('hides separators from assistive technology', () => {
    render(<PostureSummary label="Posture" counts={{ healthy: 0, warning: 0, critical: 0, unknown: 0 }} />)
    const group = screen.getByRole('group', { name: 'Posture' })
    const separators = Array.from(group.querySelectorAll('li[aria-hidden="true"]'))
    expect(separators).toHaveLength(3)
    expect(within(group).getAllByRole('listitem')).toHaveLength(4)
  })

  it('emits only semantic alias classes', () => {
    render(
      <PostureSummary
        label="Posture"
        counts={{ healthy: 1, warning: 0, critical: 0, unknown: 0, stale: 1 }}
        summary="S"
        posture="healthy"
        data-testid="posture"
      />,
    )
    expectOnlySemanticClasses(screen.getByTestId('posture'))
  })
})
