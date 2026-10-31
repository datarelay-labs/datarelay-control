import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { expectOnlySemanticClasses } from '../../test/semantic-class-contract'
import { Button, type ButtonSize, type ButtonVariant } from './button'
import { buttonClassName } from './button-classes'

describe('Button', () => {
  it('defaults to a secondary md type="button"', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('h-control-md', 'bg-surface-card', 'border-default', 'text-fg', 'text-body')
  })

  it('renders primary with the accent pair and a brightness hover, not bg-accent-hover', () => {
    render(<Button variant="primary">Deploy</Button>)
    const button = screen.getByRole('button', { name: 'Deploy' })
    expect(button).toHaveClass('bg-accent', 'text-on-accent', 'hover:brightness-90')
    expect(button.className).not.toContain('accent-hover')
  })

  it.each<[ButtonVariant, string[]]>([
    ['secondary', ['bg-surface-card', 'text-fg']],
    ['ghost', ['bg-transparent', 'text-fg-secondary']],
    ['danger', ['bg-status-critical-subtle', 'text-status-critical', 'border-status-critical-border']],
  ])('renders the %s variant from semantic aliases', (variant, classes) => {
    render(<Button variant={variant}>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(...classes)
  })

  it.each<[ButtonSize, string]>([
    ['sm', 'h-control-sm'],
    ['md', 'h-control-md'],
    ['touch', 'h-control-touch'],
  ])('maps size %s to %s', (size, height) => {
    render(<Button size={size}>Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass(height)
  })

  it('shows a visible focus ring', () => {
    render(<Button>Focus</Button>)
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-focus-ring')
  })

  it('renders leading and trailing icon slots hidden from assistive technology', () => {
    render(
      <Button leadingIcon={<svg data-testid="lead" />} trailingIcon={<svg data-testid="trail" />}>
        Next
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Next' })
    expect(button.firstElementChild).toContainElement(screen.getByTestId('lead'))
    expect(button.lastElementChild).toContainElement(screen.getByTestId('trail'))
    expect(button.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(button.lastElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('disables, sets aria-busy and shows a spinner while loading', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick} leadingIcon={<svg data-testid="lead" />}>
        Saving
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Saving' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('[data-button-spinner]')).not.toBeNull()
    expect(screen.queryByTestId('lead')).not.toBeInTheDocument()
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('is enabled without aria-busy when not loading', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Run</Button>)
    const button = screen.getByRole('button', { name: 'Run' })
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('forwards ref, type, className and HTML attributes', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button ref={ref} type="submit" className="w-full" data-testid="btn" aria-label="Submit form">
        Submit
      </Button>,
    )
    const button = screen.getByTestId('btn')
    expect(ref.current).toBe(button)
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toHaveClass('w-full')
    expect(screen.getByRole('button', { name: 'Submit form' })).toBe(button)
  })

  it('lets a caller className override the control height', () => {
    render(<Button size="sm" className="h-control-touch">Tap</Button>)
    const button = screen.getByRole('button', { name: 'Tap' })
    expect(button).toHaveClass('h-control-touch')
    expect(button).not.toHaveClass('h-control-sm')
  })

  it('exposes the same styling for router links', () => {
    expect(buttonClassName({ variant: 'primary', size: 'sm' }).split(' ')).toEqual(
      expect.arrayContaining(['bg-accent', 'text-on-accent', 'h-control-sm']),
    )
  })

  it.each<ButtonVariant>(['primary', 'secondary', 'ghost', 'danger'])('emits only semantic alias classes for %s', (variant) => {
    render(
      <Button variant={variant} loading>
        Go
      </Button>,
    )
    expectOnlySemanticClasses(screen.getByRole('button', { name: 'Go' }))
  })
})
