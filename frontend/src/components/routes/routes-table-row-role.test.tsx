import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistSession } from '../../auth/session'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { RoutesTableRow } from './routes-table-row'
import type { RouteConsoleRow } from './routes-overview-helpers'

const row: RouteConsoleRow = {
  route: { id: 42, destination_id: 10, failure_policy: 'LOG_AND_CONTINUE' } as RouteConsoleRow['route'],
  stream: { id: 1, name: 'Finance collection' } as RouteConsoleRow['stream'],
  destination: { id: 10, name: 'Analytics sink', destination_type: 'WEBHOOK_POST' } as NonNullable<RouteConsoleRow['destination']>,
  metrics: null,
  uiStatus: 'Warning',
  routeLabel: 'R-0042',
}

function mount(onTestRoute = vi.fn()) {
  render(
    <MemoryRouter>
      <table><tbody>
        <RoutesTableRow
          row={row}
          selected={false}
          showRateLimitCol={false}
          testBusyId={null}
          moreMenuOpen
          moreMenuRef={undefined}
          onSelect={vi.fn()}
          onTestRoute={onTestRoute}
          onToggleMoreMenu={vi.fn()}
          onCloseMoreMenu={vi.fn()}
        />
      </tbody></table>
    </MemoryRouter>,
  )
  return onTestRoute
}

describe('Route operations table session capability actions', () => {
  afterEach(() => clearTestSession())

  it.each(['VIEWER', 'GOVERNANCE_AUDITOR'] as const)('offers %s diagnostics but not a write-only Route test', (role) => {
    persistTestSession(role)
    const onTest = mount()
    expect(screen.queryByRole('button', { name: 'Test route R-0042' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit Route' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Route settings' })).toHaveAttribute('href', '/routes/42/edit')
    expect(screen.getByRole('link', { name: 'View logs for route R-0042' })).toBeInTheDocument()
    expect(onTest).not.toHaveBeenCalled()
  })

  it.each(['ADMINISTRATOR', 'OPERATOR'] as const)('keeps %s Route tests and Edit Route available', async (role) => {
    persistTestSession(role)
    const user = userEvent.setup()
    const onTest = mount()
    await user.click(screen.getByRole('button', { name: 'Test route R-0042' }))
    expect(onTest).toHaveBeenCalledWith(42, 10)
    expect(screen.getByRole('link', { name: 'Edit Route' })).toHaveAttribute('href', '/routes/42/edit')
  })

  it('removes write actions immediately when the server capability downgrades an operator', () => {
    persistTestSession('OPERATOR')
    mount()
    expect(screen.getByRole('button', { name: 'Test route R-0042' })).toBeInTheDocument()
    act(() => persistSession({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      user: { username: 'operator', role: 'OPERATOR', status: 'ACTIVE', capabilities: { workspace_mutations: false } },
    }))
    expect(screen.queryByRole('button', { name: 'Test route R-0042' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Route settings' })).toBeInTheDocument()
  })
})
