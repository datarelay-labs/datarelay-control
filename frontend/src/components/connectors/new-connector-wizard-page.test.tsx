import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NewConnectorWizardPage } from './new-connector-wizard-page'
import { createConnector } from '../../api/gdcConnectors'

vi.mock('../../api/gdcConnectors', () => ({
  createConnector: vi.fn(async () => ({ id: 1 })),
}))

describe('NewConnectorWizardPage', () => {
  it('toggles auth fields by auth type', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <NewConnectorWizardPage />
      </MemoryRouter>,
    )

    const select = screen.getByLabelText('Authentication Type')
    expect(screen.queryByLabelText('Basic Username')).not.toBeInTheDocument()

    await user.selectOptions(select, 'basic')
    expect(screen.getByLabelText('Basic Username')).toBeInTheDocument()
    expect(screen.getByLabelText('Basic Password')).toBeInTheDocument()

    await user.selectOptions(select, 'bearer')
    expect(screen.getByLabelText('Bearer Token')).toBeInTheDocument()

    await user.selectOptions(select, 'api_key')
    expect(screen.getByLabelText('API Key Name')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key Value')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key Location')).toBeInTheDocument()

    await user.selectOptions(select, 'vendor_jwt_exchange')
    expect(screen.getByLabelText('User ID')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key')).toBeInTheDocument()
    expect(screen.getByLabelText('Token exchange URL')).toBeInTheDocument()
  })

  it('completes contextual Connector creation without losing the parent Wizard', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    const onCancel = vi.fn()
    render(
      <MemoryRouter>
        <NewConnectorWizardPage onCreated={onCreated} onCancel={onCancel} />
      </MemoryRouter>,
    )
    await user.type(screen.getByLabelText('Connector Name *'), 'Inline source')
    await user.type(screen.getByLabelText('Host / Base URL *'), 'https://example.net')
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))
    expect(onCreated).toHaveBeenCalledWith(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('returns to the parent on contextual cancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(
      <MemoryRouter>
        <NewConnectorWizardPage onCancel={onCancel} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('shows remote file source option', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <NewConnectorWizardPage />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('radio', { name: /Remote file polling \(SFTP/i }))
    expect(screen.getByLabelText('Protocol')).toBeInTheDocument()
    expect(screen.getByLabelText('Host *')).toBeInTheDocument()
  })

  it('does not present a malformed Connector create response as an accepted saved resource', async () => {
    vi.mocked(createConnector).mockResolvedValueOnce({ id: 0 } as Awaited<ReturnType<typeof createConnector>>)
    const user = userEvent.setup()
    const onCreated = vi.fn()
    render(<MemoryRouter><NewConnectorWizardPage onCreated={onCreated} /></MemoryRouter>)
    await user.type(screen.getByLabelText('Connector Name *'), 'Unverified source')
    await user.type(screen.getByLabelText('Host / Base URL *'), 'https://example.net')
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))
    expect(await screen.findByText(/Connector creation response could not be verified/i)).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save Connector' })).toBeEnabled()
  })

  it('shows required validation before save', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <NewConnectorWizardPage />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))
    expect(screen.getByText(/Connector name is required/i)).toBeInTheDocument()
  })
})
