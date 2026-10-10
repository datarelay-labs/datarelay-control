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

  it('opens the existing Stream Wizard directly from step 03 only when reusable resources are registered', () => {
    setup({ connectors: 2, destinations: 3 })
    const steps = screen.getByRole('list', { name: 'First data flow setup steps' })
    expect(within(steps).getByRole('link', { name: 'Open Stream Wizard from setup checklist' }))
      .toHaveAttribute('href', '/streams/new')
    expect(steps).toHaveTextContent('Ready to start')
  })

  it.each([
    { connectors: 0, destinations: 2, reason: 'Register a Connector first' },
    { connectors: 2, destinations: 0, reason: 'Register a Destination first' },
    { connectors: null, destinations: 2, reason: 'Connector inventory not verified' },
    { connectors: 2, destinations: null, reason: 'Destination inventory not verified' },
  ])('does not start Stream setup when prerequisites are incomplete: $reason', ({ connectors, destinations, reason }) => {
    setup({ connectors, destinations })
    const steps = screen.getByRole('list', { name: 'First data flow setup steps' })
    expect(within(steps).queryByRole('link', { name: 'Open Stream Wizard from setup checklist' }))
      .not.toBeInTheDocument()
    expect(within(steps).getByText(reason)).toBeInTheDocument()
  })

  it('never offers checklist Wizard access to a read-only Viewer, even when catalogs are populated', () => {
    setup({ connectors: 2, destinations: 3, canConfigure: false })
    const steps = screen.getByRole('list', { name: 'First data flow setup steps' })
    expect(within(steps).queryByRole('link', { name: 'Open Stream Wizard from setup checklist' }))
      .not.toBeInTheDocument()
    expect(within(steps).getByText('Configuration permission required')).toBeInTheDocument()
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

describe('Competitor-informed first-run flow explanation', () => {
  it('shows the actual collection-to-delivery order, separate from prerequisite setup order', () => {
    setup({ connectors: 0, destinations: 0 })
    const panel = screen.getByTestId('dashboard-empty-state')
    const path = within(panel).getByRole('list', { name: 'Runtime event path' })
    const nodes = within(path).getAllByRole('listitem')
    expect(nodes).toHaveLength(4)
    expect(nodes.map((item) => item.getAttribute('data-flow-node'))).toEqual([
      'connector', 'stream', 'route', 'destination',
    ])
    expect(path).toHaveTextContent('Source access')
    expect(path).toHaveTextContent('Collection')
    expect(path).toHaveTextContent('Per-destination processing')
    expect(path).toHaveTextContent('Receiving endpoint')
    expect(within(panel).getByText(/One Stream can deliver through multiple Routes to different Destinations/i)).toBeInTheDocument()
    expect(within(panel).getByText(/Concept only.*not observed runtime delivery/i)).toBeInTheDocument()
    expect(within(panel).getByText(/Preparation checklist.*not the event path/i)).toBeInTheDocument()
    // A missing Connector/Destination remains a real prerequisite, not an invented runtime entity.
    expect(within(panel).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/connectors')
  })

  it('keeps the conceptual delivery path read-only for Viewer and unknown catalog evidence', () => {
    setup({ connectors: null, destinations: null, canConfigure: false })
    const panel = screen.getByTestId('dashboard-empty-state')
    expect(within(panel).getByRole('list', { name: 'Runtime event path' })).toBeInTheDocument()
    expect(within(panel).getByTestId('dashboard-first-flow-next')).toHaveAttribute('href', '/routes')
    expect(within(panel).queryByRole('button', { name: /Create|Deploy|Activate/ })).not.toBeInTheDocument()
    expect(within(panel).getByTestId('dashboard-first-flow-source-state')).toHaveTextContent('Not verified')
    expect(within(panel).getByTestId('dashboard-first-flow-destination-state')).toHaveTextContent('Not verified')
  })
})
