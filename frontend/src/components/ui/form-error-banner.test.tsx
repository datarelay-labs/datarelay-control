import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormErrorBanner } from './form-error-banner'

describe('FormErrorBanner', () => {
  it('renders nothing without a message', () => {
    const { container } = render(<FormErrorBanner message={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('announces the message, moves focus to it and scrolls it into view', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    render(<FormErrorBanner message="API key location must be headers or query_params." />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('API key location must be headers or query_params.')
    expect(alert).toHaveFocus()
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
  })

  it('hides the HTTP status and internal error code from the displayed text', () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(<FormErrorBanner message="422: [CONNECTOR_VALIDATION_FAILED] Login base URL must not include a path." />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Login base URL must not include a path.')
    expect(alert.textContent).not.toMatch(/422|CONNECTOR_VALIDATION_FAILED/)
  })

  it('re-focuses when the same banner receives a new message', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const { rerender } = render(<FormErrorBanner message="First problem." />)
    screen.getByRole('alert').blur()
    rerender(<FormErrorBanner message="Second problem." />)
    expect(screen.getByRole('alert')).toHaveFocus()
  })
})
