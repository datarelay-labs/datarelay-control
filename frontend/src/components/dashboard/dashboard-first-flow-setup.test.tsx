import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { DashboardFirstFlowSetup } from './dashboard-first-flow-setup'

function setup(options: { connectors: number | null; destinations: number | null; canConfigure?: boolean }) {
  return render(
    <MemoryRouter>
      <DashboardFirstFlowSetup
        connectorCount={options.connectors}
        destinationCount={options.destinations}
        canConfigure={options.canConfigure !== false}
      />
    </MemoryRouter>,
  )
}

describe('Data Flow first-run onboarding', () => {
  it('routes missing prerequisites to reusable Connections before a Stream draft exists', () => {
    setup({ connectors: 0, destinations: 0 })
    const region = screen.getByTestId('dashboard-empty-state')
    expect(within(region).getByRole('heading', { name: /Set up your first data flow/i })).toBeInTheDocument()
    expect(within(region).getByTestId('dashboard-first-flow-source-state')).toHaveTextContent('Not configured')
    expect(within(region).getByTestId('dashboard-first-flow-destination-state')).toHaveTextContent('Not configured')
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/connectors')
    expect(within(region).queryByRole('link', { name: /Start Stream setup/i })).not.toBeInTheDocument()
  })

  it('guides to missing destination after registering a reusable Connector', () => {
    setup({ connectors: 2, destinations: 0 })
    const region = screen.getByTestId('dashboard-empty-state')
    expect(within(region).getByTestId('dashboard-first-flow-source-state')).toHaveTextContent('2 registered')
    expect(within(region).getByTestId('dashboard-first-flow-destination-state')).toHaveTextContent('Not configured')
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/destinations')
    expect(within(region).getByRole('link', { name: 'Review Connectors' })).toHaveAttribute('href', '/connectors')
  })

  it('opens existing Stream wizard only when both resource catalogs are populated', () => {
    setup({ connectors: 1, destinations: 3 })
    const region = screen.getByTestId('dashboard-empty-state')
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/streams/new')
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveTextContent('Start Stream setup')
    expect(within(region)).toBeTruthy()
    expect(within(region).getByText(/registered resources do not prove that data is flowing/i)).toBeInTheDocument()
  })

  it('never presents failed or pending catalog evidence as zero installed resources', () => {
    setup({ connectors: null, destinations: null })
    const region = screen.getByTestId('dashboard-empty-state')
    expect(within(region).getByTestId('dashboard-first-flow-source-state')).toHaveTextContent('Not verified')
    expect(within(region).getByTestId('dashboard-first-flow-destination-state')).toHaveTextContent('Not verified')
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/connectors')
    expect(within(region)).not.toBeNull()
    expect(within(region).queryByText('Not configured')).not.toBeInTheDocument()
  })

  it('preserves read-only role boundaries without implying a Stream can be created', () => {
    setup({ connectors: 0, destinations: 0, canConfigure: false })
    const region = screen.getByTestId('dashboard-empty-state')
    expect(within(region).getByText(/read-only access/i)).toBeInTheDocument()
    expect(within(region).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/routes')
    expect(within(region).queryByRole('link', { name: /Start Stream setup/i })).not.toBeInTheDocument()
    expect(within(region).queryByRole('link', { name: /Create First Stream/i })).not.toBeInTheDocument()
  })
})
