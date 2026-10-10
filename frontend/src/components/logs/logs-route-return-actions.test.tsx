import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { LogsRouteReturnActions } from './logs-route-return-actions'

function show(routeId: number | undefined, canConfigure: boolean, destinationId?: number) {
  return render(
    <MemoryRouter>
      <LogsRouteReturnActions routeId={routeId} canConfigure={canConfigure} destinationId={destinationId} />
    </MemoryRouter>,
  )
}

describe('Kibana-style contextual Route investigation return', () => {
  it('retains the exact Route identity and links mutating operators to the existing Route settings', () => {
    show(42, true)
    const region = screen.getByRole('region', { name: 'Route investigation next actions' })
    expect(region).toHaveTextContent('Route #42')
    expect(screen.getByRole('link', { name: 'Review Route #42 configuration' }))
      .toHaveAttribute('href', '/routes/42/edit')
    expect(screen.getByRole('link', { name: 'Back to Data Flows' }))
      .toHaveAttribute('href', '/routes')
    expect(region).toHaveTextContent('Opening settings does not resend or verify events')
  })

  it('shows a non-mutating path to viewers without inviting forbidden configuration', () => {
    show(42, false)
    expect(screen.getByRole('link', { name: 'Back to Data Flows' }))
      .toHaveAttribute('href', '/routes')
    expect(screen.queryByRole('link', { name: /Review Route #42 configuration/ })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Route investigation next actions' }))
      .toHaveTextContent('Read-only access')
  })

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'does not invent a Route return link for invalid identity %s',
    (id) => {
      show(id, true)
      expect(screen.queryByRole('region', { name: 'Route investigation next actions' }))
        .not.toBeInTheDocument()
    },
  )
})

describe('Receiver investigation next action', () => {
  it('allows read-only and operator users to inspect the exact positively identified Destination', () => {
    show(42, false, 10)
    expect(screen.getByRole('link', { name: 'Inspect Destination #10' }))
      .toHaveAttribute('href', '/destinations/10')
    expect(screen.queryByRole('link', { name: /Review Route #42 configuration/ })).not.toBeInTheDocument()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'never synthesizes a destination detail link for invalid ID %s',
    (id) => {
      show(42, true, id)
      expect(screen.queryByRole('link', { name: /Inspect Destination/ })).not.toBeInTheDocument()
    },
  )
})
