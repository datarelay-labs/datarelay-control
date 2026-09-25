import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GovernanceWorkspacePage } from './governance-workspace-page'

const fetchStreamsList = vi.fn()
const fetchRoutesList = vi.fn()
const fetchGovernanceWorkspaceSnapshot = vi.fn()

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: (...args: unknown[]) => fetchStreamsList(...args),
}))

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: (...args: unknown[]) => fetchRoutesList(...args),
}))

vi.mock('../../api/gdcGovernanceWorkspaceSnapshot', () => ({
  fetchGovernanceWorkspaceSnapshot: (...args: unknown[]) => fetchGovernanceWorkspaceSnapshot(...args),
}))

function mockWorkspaceSnapshot(streamId: number, routes: Array<{ id: number; name: string }>) {
  fetchGovernanceWorkspaceSnapshot.mockImplementation(async (id: number) => {
    const streamRoutes = routes.filter((route) => {
      if (id === 10) return route.id === 42 || route.id === 43
      if (id === 20) return route.id === 99
      return false
    })
    return {
      stream_id: id,
      route_count: streamRoutes.length,
      routes: streamRoutes.map((route) => ({
        route_id: route.id,
        route_name: route.name,
        transform: {
          route_id: route.id,
          stream_id: id,
          persisted_source: 'stream',
          mapping_source: 'stream',
          enrichment_source: 'stream',
          fallback_used: true,
          mapping_count: 2,
          enrichment_count: 1,
          processing_status: route.id === 42 ? 'Inherited' : 'Overridden',
          message: 'ok',
        },
        protection: {
          route_id: route.id,
          stream_id: id,
          persisted_source: 'stream',
          fallback_used: true,
          rule_count: 3,
          processing_status: route.id === 42 ? 'Inherited' : 'Mixed',
          message: 'ok',
        },
        classification: {
          route_id: route.id,
          stream_id: id,
          persisted_source: 'stream',
          fallback_used: true,
          rule_count: 4,
          processing_status: 'Inherited',
          message: 'ok',
        },
        policy: {
          route_id: route.id,
          stream_id: id,
          persisted_source: 'stream',
          fallback_used: true,
          rule_count: 5,
          processing_status: 'Inherited',
        },
      })),
    }
  })
}

describe('GovernanceWorkspacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchStreamsList.mockResolvedValue([
      { id: 10, name: 'Stream A', status: 'RUNNING' },
      { id: 20, name: 'Stream B', status: 'ERROR' },
    ])
    fetchRoutesList.mockResolvedValue([
      { id: 42, name: 'Route A', stream_id: 10, destination_id: 5, enabled: true },
      { id: 43, name: 'Route B', stream_id: 10, destination_id: 6, enabled: true },
      { id: 99, name: 'Other', stream_id: 20, destination_id: 5, enabled: true },
    ])
    mockWorkspaceSnapshot(10, [
      { id: 42, name: 'Route A' },
      { id: 43, name: 'Route B' },
      { id: 99, name: 'Other' },
    ])
  })

  it('renders three-panel layout with stream selection and route governance table', async () => {
    render(
      <MemoryRouter>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-page')).toBeInTheDocument()
    expect(screen.getByTestId('governance-workspace-streams-panel')).toBeInTheDocument()
    expect(screen.getByTestId('governance-workspace-summary-panel')).toBeInTheDocument()
    expect(screen.getByTestId('governance-workspace-routes-panel')).toBeInTheDocument()

    const row42 = await screen.findByTestId('governance-workspace-route-row-42')
    expect(within(row42).getAllByText('Inherited').length).toBeGreaterThan(0)
    expect(screen.getByTestId('governance-workspace-route-row-43')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-route-row-99')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-context-fallback')).not.toBeInTheDocument()
  })

  it('updates summary and routes when another stream is selected', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    await screen.findByTestId('governance-workspace-stream-row-10')
    await user.click(within(screen.getByTestId('governance-workspace-stream-row-20')).getByRole('button'))
    await waitFor(() => {
      expect(screen.getByTestId('governance-workspace-route-row-99')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('governance-workspace-route-row-42')).not.toBeInTheDocument()
  })

  it('loads one workspace snapshot per selected stream (no 4xR fan-out)', async () => {
    render(
      <MemoryRouter>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledWith(10, expect.anything())
    })
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    expect(fetchStreamsList).toHaveBeenCalledTimes(1)
    expect(fetchRoutesList).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate snapshot fetch when selecting an already-loaded stream', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    })
    await user.click(within(screen.getByTestId('governance-workspace-stream-row-20')).getByRole('button'))
    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledWith(20, expect.anything())
    })
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(2)
    await user.click(within(screen.getByTestId('governance-workspace-stream-row-10')).getByRole('button'))
    await screen.findByTestId('governance-workspace-route-row-42')
    expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(2)
  })

  it('selects the stream from a stream query and leaves route focus unset', async () => {
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=20']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-active-context')).toHaveTextContent('Stream B')
    expect(await screen.findByTestId('governance-workspace-route-row-99')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-route-row-42')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-context-fallback')).not.toBeInTheDocument()
    expect(document.querySelector('[data-context-focus="route"]')).not.toBeInTheDocument()
  })

  it('selects the route stream and focuses the matching route', async () => {
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=10&route_id=42']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-active-context')).toHaveTextContent('Stream A · Route A')
    const row = await screen.findByTestId('governance-workspace-route-row-42')
    expect(row).toHaveAttribute('data-context-focus', 'route')
    expect(screen.queryByTestId('governance-workspace-route-row-99')).not.toBeInTheDocument()
  })

  it('falls back when the route does not belong to the requested stream', async () => {
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=20&route_id=42']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-context-fallback')).toHaveTextContent(
      'Requested governance context is not available',
    )
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    const row = await screen.findByTestId('governance-workspace-route-row-42')
    expect(row).not.toHaveAttribute('data-context-focus')
  })

  it('falls back for a stale stream id without claiming that context', async () => {
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=999']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-context-fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    expect(await screen.findByTestId('governance-workspace-route-row-42')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-stream-row-999')).not.toBeInTheDocument()
  })

  it('falls back for a stale route id', async () => {
    render(
      <MemoryRouter initialEntries={['/governance/workspace?route_id=777']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-context-fallback')).toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    expect(document.querySelector('[data-context-focus="route"]')).not.toBeInTheDocument()
    expect(await screen.findByTestId('governance-workspace-route-row-42')).toBeInTheDocument()
  })

  it('reports a list-load failure instead of stale context when streams fail to load', async () => {
    fetchStreamsList.mockResolvedValue(null)
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=20']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load governance workspace')
    expect(screen.queryByTestId('governance-workspace-context-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-stream-row-20')).not.toBeInTheDocument()
    expect(fetchGovernanceWorkspaceSnapshot).not.toHaveBeenCalled()
  })

  it('reports a list-load failure instead of stale context when routes fail to load', async () => {
    fetchRoutesList.mockResolvedValue(null)
    render(
      <MemoryRouter initialEntries={['/governance/workspace?route_id=42']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load governance workspace')
    expect(screen.queryByTestId('governance-workspace-context-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
    expect(document.querySelector('[data-context-focus="route"]')).not.toBeInTheDocument()
    expect(fetchGovernanceWorkspaceSnapshot).not.toHaveBeenCalled()
  })

  it('keeps stale fallback when successful empty lists prove the requested stream is absent', async () => {
    fetchStreamsList.mockResolvedValue([])
    fetchRoutesList.mockResolvedValue([])
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=20']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('governance-workspace-context-fallback')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
  })

  it('reports a thrown list-load error without labeling the query context stale', async () => {
    fetchStreamsList.mockRejectedValue(new Error('streams unavailable'))
    render(
      <MemoryRouter initialEntries={['/governance/workspace?stream_id=20&route_id=42']}>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('streams unavailable')
    expect(screen.queryByTestId('governance-workspace-context-fallback')).not.toBeInTheDocument()
    expect(screen.queryByTestId('governance-workspace-active-context')).not.toBeInTheDocument()
  })

  it('refresh clears cache and refetches workspace snapshot', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <GovernanceWorkspacePage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    })
    await user.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => {
      expect(fetchGovernanceWorkspaceSnapshot).toHaveBeenCalledTimes(2)
    })
  })
})
