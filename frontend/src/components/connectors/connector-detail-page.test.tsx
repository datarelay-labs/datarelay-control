import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorDetailPage } from './connector-detail-page'

const { fetchConnectorByIdMock, runConnectorAuthTestMock, updateConnectorMock } = vi.hoisted(() => ({
  fetchConnectorByIdMock: vi.fn(),
  runConnectorAuthTestMock: vi.fn(),
  updateConnectorMock: vi.fn(),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: fetchConnectorByIdMock,
  updateConnector: updateConnectorMock,
  deleteConnector: vi.fn(),
}))

vi.mock('../../api/gdcRuntimePreview', () => ({
  runConnectorAuthTest: runConnectorAuthTestMock,
}))

describe('ConnectorDetailPage auth test draft truth', () => {
  it('tests the visible unsaved bearer token instead of only the persisted connector id', async () => {
    fetchConnectorByIdMock.mockResolvedValue({
      id: 7,
      name: 'Draft truth connector',
      description: '',
      status: 'STOPPED',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      source_id: 11,
      stream_count: 0,
      host: 'https://draft.test',
      base_url: 'https://draft.test',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'bearer',
      auth: {
        auth_type: 'bearer',
        bearer_token: '********',
        bearer_token_configured: true,
      },
    })
    runConnectorAuthTestMock.mockResolvedValue({
      ok: false,
      auth_type: 'BEARER',
      response_status_code: 401,
      message: 'Unauthorized',
    })

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/connectors/7']}>
        <Routes>
          <Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const token = await screen.findByLabelText('Bearer Token')
    await user.clear(token)
    await user.type(token, 'visible-invalid-draft')
    await user.click(screen.getByRole('button', { name: 'Test Authentication' }))

    await waitFor(() => expect(runConnectorAuthTestMock).toHaveBeenCalledTimes(1))
    expect(runConnectorAuthTestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 7,
        inline_flat_source: expect.objectContaining({
          base_url: 'https://draft.test',
          auth_type: 'bearer',
          bearer_token: 'visible-invalid-draft',
        }),
      }),
    )
  })

  it('submits the edited HTTP base URL in both aliases so a stale host cannot override it', async () => {
    fetchConnectorByIdMock.mockResolvedValue({
      id: 7,
      name: 'HTTP source regression fixture',
      description: '',
      status: 'STOPPED',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      source_id: 11,
      stream_count: 0,
      host: 'https://old.example.invalid',
      base_url: 'https://old.example.invalid',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
    })
    updateConnectorMock.mockResolvedValue({ id: 7 })
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/connectors/7']}>
        <Routes>
          <Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    const baseUrl = await screen.findByLabelText('Host / Base URL *')
    await user.clear(baseUrl)
    await user.type(baseUrl, 'https://new.example.invalid/v1')
    await user.click(screen.getByRole('button', { name: 'Save', exact: true }))

    await waitFor(() =>
      expect(updateConnectorMock).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          base_url: 'https://new.example.invalid/v1',
          host: 'https://new.example.invalid/v1',
        }),
      ),
    )
    expect(baseUrl).toHaveValue('https://new.example.invalid/v1')
  })
})
