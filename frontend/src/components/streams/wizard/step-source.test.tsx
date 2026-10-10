import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StepSource } from './step-source'
import { buildInitialState } from './wizard-state'
import { clearWizardCatalogSnapshot } from './wizard-catalog-cache'
import { fetchCatalogSnapshot } from '../../../api/gdcCatalog'

vi.mock('../../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({ connectors: [], sources: [], apiBacked: false })),
}))

vi.mock('../../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../../api/gdcSources', () => ({
  fetchSourceById: vi.fn(async () => null),
}))

describe('StepSource', () => {
  beforeEach(() => {
    clearWizardCatalogSnapshot()
    vi.mocked(fetchCatalogSnapshot).mockReset().mockResolvedValue({
      connectors: [], sources: [], apiBacked: true,
    })
  })

  it('shows create connector CTA when no connector exists', async () => {
    const state = buildInitialState()
    render(
      <MemoryRouter>
        <StepSource state={state} onChange={() => {}} />
      </MemoryRouter>,
    )

    expect(await screen.findByText('No connectors available')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Connector Create Page' })).toHaveAttribute('href', '/connectors/new')
  })

  it('does not mistake a failed Connector/Source catalog for an empty catalog', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValueOnce({
      connectors: [], sources: [], apiBacked: false,
    })
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepSource state={buildInitialState()} onChange={onChange} onCreateConnector={vi.fn()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Connector catalog unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-add-connector')).not.toBeInTheDocument()
    expect(screen.getByText(/does not mean zero Connectors/i)).toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ apiBacked: false }))
    await userEvent.click(screen.getByTestId('wizard-retry-connector-catalog'))
    await waitFor(() => expect(screen.getByText('No connectors available')).toBeInTheDocument())
    expect(screen.getByTestId('wizard-add-connector')).toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ apiBacked: true }))
  })

  it('opens connector creation in the parent Data Flow without navigating away', async () => {
    const user = userEvent.setup()
    const onCreateConnector = vi.fn()
    render(
      <MemoryRouter>
        <StepSource state={buildInitialState()} onChange={() => {}} onCreateConnector={onCreateConnector} />
      </MemoryRouter>,
    )
    await user.click(await screen.findByTestId('wizard-add-connector'))
    expect(onCreateConnector).toHaveBeenCalledOnce()
    expect(screen.queryByRole('link', { name: 'Go to Connector Create Page' })).not.toBeInTheDocument()
  })
})
