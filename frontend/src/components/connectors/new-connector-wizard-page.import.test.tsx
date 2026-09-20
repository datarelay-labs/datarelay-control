import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NewConnectorWizardPage } from './new-connector-wizard-page'

vi.mock('../../api/gdcConnectors', () => ({
  createConnector: vi.fn(async () => ({ id: 42 })),
}))

vi.mock('../../api/gdcBackup', () => ({
  postCurlParse: vi.fn(),
  postPostmanParse: vi.fn(),
}))

function renderWithCurlDraft() {
  const draft = {
    name: 'Imported HTTP connector',
    description: 'from curl',
    source_type: 'HTTP_API_POLLING',
    base_url: 'https://api.example.com',
    auth_type: 'no_auth',
    status: 'STOPPED',
    common_headers: { Accept: 'application/json' },
  }
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: '/connectors/new',
          state: {
            curlDraft: draft,
            streamDraft: { name: 'Imported events', config_json: { method: 'GET', endpoint: '/v1/events' } },
          },
        },
      ]}
    >
      <Routes>
        <Route path="/connectors/new" element={<NewConnectorWizardPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NewConnectorWizardPage import hydration', () => {
  it('prefills connector fields from approved curl draft', async () => {
    renderWithCurlDraft()
    await waitFor(() => {
      expect(screen.getByDisplayValue('Imported HTTP connector')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('https://api.example.com')).toBeInTheDocument()
    expect(screen.getByText(/Imported events/i)).toBeInTheDocument()
  })

  it('shows import panels on the start screen', () => {
    render(
      <MemoryRouter>
        <NewConnectorWizardPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Parse cURL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parse collection' })).toBeInTheDocument()
  })
})
