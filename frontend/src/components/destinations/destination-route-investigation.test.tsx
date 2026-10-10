import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { RoutesTable } from './destination-detail-page'

type Props = Parameters<typeof RoutesTable>[0]

function route(overrides: Partial<Props['routes'][number]> = {}): Props['routes'][number] {
  return {
    routeId: '42', routeName: 'Route #42', streamId: 2,
    streamName: 'Finance stream', deliveryMode: 'Direct', status: 'ERROR',
    epsAvg: 0, successRate5m: null, ...overrides,
  }
}

function mount(routeRow: Props['routes'][number], destinationId: number = 10) {
  return render(
    <MemoryRouter>
      <RoutesTable routes={[routeRow]} destinationId={destinationId} />
    </MemoryRouter>,
  )
}

describe('Destination scoped Route evidence investigation', () => {
  it('identifies Route success rate as a 5-minute snapshot, never a 24-hour aggregate', () => {
    mount(route({ successRate5m: 97.2 }))
    expect(screen.getByRole('columnheader', { name: 'Success (5m snapshot)' })).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Success (24h)' })).not.toBeInTheDocument()
    expect(screen.getByText('97.2%')).toBeInTheDocument()
  })

  it('distinguishes measured 0% delivery success from unverified success samples', () => {
    const zero = mount(route({ successRate5m: 0, epsAvg: 2 }))
    expect(screen.getByText('0.0%')).toBeInTheDocument()
    zero.unmount()
    mount(route({ successRate5m: null }))
    const headers = screen.getAllByRole('columnheader')
    expect(headers[5]).toHaveTextContent('Success (5m snapshot)')
    const row = screen.getAllByRole('row')[1]
    expect(row?.querySelectorAll('td')[5]).toHaveTextContent('—')
  })

  it('provides a read-only Route delivery logs link scoped to existing Route, Stream and Destination IDs', () => {
    mount(route())
    const link = screen.getByRole('link', { name: 'Investigate Route #42 delivery logs' })
    expect(link).toHaveAttribute('href', '/logs?route_id=42&stream_id=2&destination_id=10')
    expect(link.getAttribute('href')).not.toContain('status=failed')
    expect(screen.getByRole('link', { name: 'View route' })).toHaveAttribute('href', '/routes/42/edit')
  })

  it('omits unverified optional IDs without silently scoping to another Stream or Destination', () => {
    mount(route({ streamId: -2 }), Number.NaN)
    expect(screen.getByRole('link', { name: 'Investigate Route #42 delivery logs' }))
      .toHaveAttribute('href', '/logs?route_id=42')
  })

  it.each(['', '42junk', '1.2', '0', '-2', String(Number.MAX_SAFE_INTEGER + 1)])(
    'does not create a false read-only Route identity for malformed ID %s',
    (id) => {
      const view = mount(route({ routeId: id }))
      expect(screen.queryByRole('link', { name: /Investigate Route .* delivery logs/ })).not.toBeInTheDocument()
      view.unmount()
    },
  )
})
