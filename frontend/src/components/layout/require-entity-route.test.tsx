import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseEntityIdParam, RequireConnectorParam, RequireRouteParam, RequireStreamParam } from './require-entity-route'

const fetchStreamById = vi.fn()
const fetchRouteById = vi.fn()

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: (...args: unknown[]) => fetchStreamById(...args),
}))
vi.mock('../../api/gdcRoutes', () => ({
  fetchRouteById: (...args: unknown[]) => fetchRouteById(...args),
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/streams/:streamId/mapping"
          element={
            <RequireStreamParam>
              <div data-testid="workspace">mapping editor</div>
            </RequireStreamParam>
          }
        />
        <Route
          path="/mappings/:mappingId/edit"
          element={
            <RequireStreamParam param="mappingId">
              <div data-testid="workspace">mapping edit</div>
            </RequireStreamParam>
          }
        />
        <Route
          path="/routes/:routeId/edit"
          element={
            <RequireRouteParam>
              <div data-testid="workspace">route form</div>
            </RequireRouteParam>
          }
        />
        <Route
          path="/connectors/:connectorId"
          element={
            <RequireConnectorParam>
              <div data-testid="workspace">connector</div>
            </RequireConnectorParam>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  fetchStreamById.mockReset()
  fetchRouteById.mockReset()
})

describe('parseEntityIdParam', () => {
  it('accepts only canonical positive integers', () => {
    expect(parseEntityIdParam('12')).toBe(12)
    for (const bad of ['', undefined, '0', '007', '-4', '1e3', 'abc', '1.5', '99999999999999999999']) {
      expect(parseEntityIdParam(bad as string | undefined)).toBeNull()
    }
  })
})

describe('entity route guards (F-216, F-217, F-019)', () => {
  it('shows a not-found state, not the editor, for an unknown stream id', async () => {
    fetchStreamById.mockResolvedValue(null)
    renderAt('/streams/99999/mapping')
    const state = await screen.findByTestId('entity-not-found')
    expect(state).toHaveTextContent('Stream not found')
    expect(state).toHaveTextContent('Stream #99999 does not exist')
    expect(screen.getByRole('link', { name: 'Back to Streams' })).toHaveAttribute('href', '/streams')
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
  })

  it('renders the workspace once the stream exists', async () => {
    fetchStreamById.mockResolvedValue({ id: 7, name: 's' })
    renderAt('/streams/7/mapping')
    expect(await screen.findByTestId('workspace')).toHaveTextContent('mapping editor')
    expect(fetchStreamById).toHaveBeenCalledWith(7)
  })

  it('treats the mapping id as a stream id', async () => {
    fetchStreamById.mockResolvedValue(null)
    renderAt('/mappings/99999/edit')
    expect(await screen.findByTestId('entity-not-found')).toHaveTextContent('Stream #99999')
  })

  it('rejects a malformed stream id without calling the API', async () => {
    renderAt('/streams/abc/mapping')
    expect(await screen.findByTestId('entity-not-found')).toHaveTextContent('"abc" is not a valid stream id')
    expect(fetchStreamById).not.toHaveBeenCalled()
  })

  it('shows a not-found state for an unknown route id instead of an editable form', async () => {
    fetchRouteById.mockResolvedValue(null)
    renderAt('/routes/99999/edit')
    const state = await screen.findByTestId('entity-not-found')
    expect(state).toHaveTextContent('Route not found')
    expect(screen.getByRole('link', { name: 'Back to Routes' })).toHaveAttribute('href', '/routes')
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
  })

  it('does not silently turn a mistyped route id into the create flow, but keeps /routes/new/edit', async () => {
    renderAt('/routes/abc/edit')
    expect(await screen.findByTestId('entity-not-found')).toHaveTextContent('"abc" is not a valid route id')
    expect(fetchRouteById).not.toHaveBeenCalled()
  })

  it('lets the create flow through without a lookup', async () => {
    renderAt('/routes/new/edit')
    expect(await screen.findByTestId('workspace')).toHaveTextContent('route form')
    expect(fetchRouteById).not.toHaveBeenCalled()
  })

  it('rejects a malformed connector id and passes a numeric one', async () => {
    const view = renderAt('/connectors/1x')
    expect(await screen.findByTestId('entity-not-found')).toHaveTextContent('"1x" is not a valid connector id')
    view.unmount()
    renderAt('/connectors/21')
    expect(await screen.findByTestId('workspace')).toBeInTheDocument()
  })
})
