import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepConnect } from './step-connect'
import { buildInitialState, type WizardState } from './wizard-state'

vi.mock('../../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({
    connectors: [{ id: 1, name: 'Test Connector', source_id: 1 }],
    sources: [],
    apiBacked: true,
  })),
}))

vi.mock('../../../api/gdcConnectorsRegistry', () => ({
  fetchConnectorsRegistryList: vi.fn(async () => ({ connectors: [] })),
}))

vi.mock('../../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async (id: number) => ({
    id,
    name: 'Cybereason',
    source_id: 1,
    auth_type: 'SESSION_LOGIN',
    config_json: { base_url: 'https://search1.cybereason.net' },
  })),
}))

function StepConnectHarness() {
  const [state, setState] = useState<WizardState>(buildInitialState())
  return (
    <StepConnect
      state={state}
      onConnectorChange={(patch) => setState((prev) => ({ ...prev, connector: { ...prev.connector, ...patch } }))}
      onStreamChange={vi.fn()}
    />
  )
}

describe('StepConnect UX simplification', () => {
  it('shows Connector, Request Configuration, and Advanced Settings tabs only', async () => {
    render(
      <MemoryRouter>
        <StepConnectHarness />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('wizard-connect-tab-connector')).toBeInTheDocument()
    })
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-advanced')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-tab-authentication')).not.toBeInTheDocument()
  })

  it('shows Required on Connector and Request Configuration tabs and Optional on Advanced Settings', async () => {
    render(
      <MemoryRouter>
        <StepConnectHarness />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('wizard-connect-tab-connector')).toBeInTheDocument()
    })

    expect(within(screen.getByTestId('wizard-connect-tab-connector')).getByText('Required')).toBeInTheDocument()
    expect(within(screen.getByTestId('wizard-connect-tab-request')).getByText('Required')).toBeInTheDocument()
    expect(within(screen.getByTestId('wizard-connect-tab-advanced')).getByText('Optional')).toBeInTheDocument()
  })

  it('keeps active tab styling separate from Required/Optional badges', async () => {
    render(
      <MemoryRouter>
        <StepConnectHarness />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('wizard-connect-tab-connector')).toHaveAttribute('aria-selected', 'true')
    })

    const connectorTab = screen.getByTestId('wizard-connect-tab-connector')
    const requestTab = screen.getByTestId('wizard-connect-tab-request')

    expect(connectorTab.className).toMatch(/text-slate-900|dark:text-slate-50/)
    expect(within(connectorTab).getByText('Required')).toBeInTheDocument()

    fireEvent.change(await screen.findByTestId('wizard-saved-connector-select'), { target: { value: '1' } })
    await waitFor(() => expect(requestTab).toBeEnabled())
    fireEvent.click(requestTab)

    expect(requestTab).toHaveAttribute('aria-selected', 'true')
    expect(connectorTab).toHaveAttribute('aria-selected', 'false')
    expect(requestTab.className).toMatch(/text-slate-900|dark:text-slate-50/)
    expect(within(requestTab).getByText('Required')).toBeInTheDocument()
  })

  it('shows Request Configuration CTA after connector is selected', async () => {
    render(
      <MemoryRouter>
        <StepConnectHarness />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('wizard-saved-connector-select')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByTestId('wizard-saved-connector-select'), { target: { value: '1' } })

    await waitFor(() => {
      expect(screen.getByTestId('wizard-connect-open-request-configuration')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('wizard-connect-open-request-configuration'))
    expect(screen.getByTestId('wizard-connect-tab-request')).toHaveAttribute('aria-selected', 'true')
  })
})


describe('Source-first configuration gates', () => {
  it('blocks source-specific SQL and advanced controls until a linked saved source is selected', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    render(<MemoryRouter><StepConnect state={state} activeTab="request" onConnectorChange={vi.fn()} onStreamChange={vi.fn()} /></MemoryRouter>)
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeDisabled()
    expect(screen.getByTestId('wizard-connect-tab-advanced')).toBeDisabled()
    expect(screen.getByTestId('wizard-connect-tab-connector')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /SQL query/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-database-sql-query')).not.toBeInTheDocument()
  })

  it('shows database queries only for a saved DATABASE_QUERY connector with its source link', () => {
    const state = buildInitialState()
    state.connector = { ...state.connector, connectorId: 7, sourceId: 9, sourceType: 'DATABASE_QUERY', connectorName: 'Local database' }
    render(<MemoryRouter><StepConnect state={state} activeTab="request" onConnectorChange={vi.fn()} onStreamChange={vi.fn()} /></MemoryRouter>)
    expect(screen.getByRole('tab', { name: /SQL query/ })).toBeEnabled()
    expect(screen.getByTestId('wizard-database-sql-query')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-database-source-context')).toHaveTextContent('Local database')
    expect(screen.queryByText(/Webhook receiver: runtime ingestion/)).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-database-sql-query')).not.toHaveAttribute('placeholder', expect.stringContaining('source_e2e_orders'))
  })

  it('returns to connector selection if the source link is removed while request settings are open', () => {
    const state = buildInitialState()
    state.connector = { ...state.connector, connectorId: 7, sourceId: 9, sourceType: 'DATABASE_QUERY' }
    const { rerender } = render(<MemoryRouter><StepConnect state={state} activeTab="request" onConnectorChange={vi.fn()} onStreamChange={vi.fn()} /></MemoryRouter>)
    expect(screen.getByTestId('wizard-database-sql-query')).toBeInTheDocument()
    rerender(<MemoryRouter><StepConnect state={{ ...state, connector: { ...state.connector, sourceId: null } }} activeTab="request" onConnectorChange={vi.fn()} onStreamChange={vi.fn()} /></MemoryRouter>)
    expect(screen.queryByTestId('wizard-database-sql-query')).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeDisabled()
  })
})
