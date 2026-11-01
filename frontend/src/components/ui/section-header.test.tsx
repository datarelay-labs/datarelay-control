import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { SectionHeader } from './section-header'

describe('SectionHeader', () => {
  it('renders an h2 title with the semantic title role by default', () => {
    render(<SectionHeader title="Route health" />)
    const heading = screen.getByRole('heading', { name: 'Route health', level: 2 })
    expect(heading).toHaveClass('text-title', 'text-fg')
  })

  it('supports a custom heading level and id for aria-labelledby', () => {
    render(
      <section aria-labelledby="dest-heading">
        <SectionHeader title="Destinations" as="h3" id="dest-heading" />
      </section>,
    )
    const heading = screen.getByRole('heading', { name: 'Destinations', level: 3 })
    expect(heading).toHaveAttribute('id', 'dest-heading')
    expect(screen.getByRole('region', { name: 'Destinations' })).toBeInTheDocument()
  })

  it('renders an optional description and actions', () => {
    render(
      <SectionHeader
        title="Streams"
        description="Streams that need attention first."
        actions={<button type="button">Refresh</button>}
      />,
    )
    expect(screen.getByText('Streams that need attention first.')).toHaveClass('text-body-sm', 'text-fg-muted')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('omits the description and actions containers when not provided', () => {
    const { container } = render(<SectionHeader title="Only title" />)
    expect(container.querySelectorAll('p')).toHaveLength(0)
    expect((container.firstElementChild as HTMLElement).children).toHaveLength(1)
  })

  it('wraps instead of overflowing on narrow widths', () => {
    const { container } = render(<SectionHeader title="T" actions={<button type="button">A</button>} className="mb-2" />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveClass('flex', 'flex-wrap', 'min-w-0', 'mb-2')
    expect(root.firstElementChild).toHaveClass('min-w-0')
    expect(root.lastElementChild).toHaveClass('flex-wrap', 'max-w-full')
  })

  it('emits only semantic alias classes', () => {
    const { container } = render(
      <SectionHeader title="T" description="D" actions={<span>A</span>} />,
    )
    expectOnlySemanticClasses(container.firstElementChild as Element)
  })
})
