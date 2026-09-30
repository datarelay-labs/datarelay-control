import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { RouteEffectiveProcessingSummary } from './route-effective-processing-summary'

describe('RouteEffectiveProcessingSummary', () => {
  it('explains inherited, overridden and mixed effective deltas', () => {
    render(
      <RouteEffectiveProcessingSummary
        pending={false}
        statuses={{
          transform: 'Mixed',
          protection: 'Inherited',
          classification: 'Overridden',
          policy: 'Inherited',
        }}
      />,
    )

    expect(screen.getByTestId('route-effective-processing-summary')).toHaveTextContent('Runtime truth')
    expect(screen.getByTestId('route-effective-transform')).toHaveTextContent('Mixed effective state')
    expect(screen.getByTestId('route-effective-protection')).toHaveTextContent('No route delta')
    expect(screen.getByTestId('route-effective-classification')).toHaveTextContent('Route override replaces shared processing')
    expect(screen.getByText(/effective Final Event preview/i)).toBeInTheDocument()
  })
})
