import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorDashboardRow } from '../../lib/connector-operational-health'
import { ConnectorRowActions } from './connector-row-actions'
import { GenericHttpCommonHeadersEditor } from './generic-http-common-headers-editor'

// F-225: controls repeated per row/entry must have a distinct accessible name, not a placeholder or a generic label.

describe('connector controls have distinct accessible names (F-225)', () => {
  it('names each header input and remove button by position', () => {
    render(<GenericHttpCommonHeadersEditor value={{ Accept: 'json', 'X-Trace': 'on' }} onChange={() => {}} />)
    expect(screen.getByRole('textbox', { name: 'Header 1 name' })).toHaveValue('Accept')
    expect(screen.getByRole('textbox', { name: 'Header 2 value' })).toHaveValue('on')
    expect(screen.getByRole('button', { name: 'Remove header 2' })).toBeInTheDocument()
  })

  it('names the row actions menu trigger and Edit link after the connector and exposes menu state', async () => {
    const user = userEvent.setup()
    const row = { id: 7, name: 'Orders API', connector_type: 'GENERIC_HTTP' } as unknown as ConnectorDashboardRow
    render(
      <MemoryRouter>
        <ConnectorRowActions row={row} onAuthCheckComplete={vi.fn()} onDelete={vi.fn()} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /connector Orders API$/ })).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Actions for connector Orders API' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
