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
