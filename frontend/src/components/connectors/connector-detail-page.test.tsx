import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorDetailPage } from './connector-detail-page'

const { fetchConnectorByIdMock, updateConnectorMock, runConnectorAuthTestMock } = vi.hoisted(() => ({
  fetchConnectorByIdMock: vi.fn(),
  updateConnectorMock: vi.fn(),
  runConnectorAuthTestMock: vi.fn(),
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
})

describe('ConnectorDetailPage operator Base URL persistence regression (BFS-394)', () => {
  it('saves and reloads the edited URL instead of preserving a stale legacy host', async () => {
    fetchConnectorByIdMock.mockReset()
    updateConnectorMock.mockReset()

    // Regression from real browser E2E: backend resolves host before base_url.
    // A successful PUT with the old host would otherwise silently retain the old URL.
    let persisted = {
      id: 42,
      name: 'Browser-discovered URL persistence',
      description: '',
      status: 'STOPPED',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      source_id: 3,
      stream_count: 0,
      host: 'https://old.example.test/api',
      base_url: 'https://old.example.test/api',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
    }
    fetchConnectorByIdMock.mockImplementation(async () => ({ ...persisted }))
    updateConnectorMock.mockImplementation(async (_id: number, payload: { host?: string; base_url?: string }) => {
      // Mirror the previously observed host-priority backend behavior.
      const saved = String(payload.host ?? payload.base_url ?? '')
      persisted = { ...persisted, host: saved, base_url: saved }
      return { ...persisted }
    })

    const page = () => (
      <MemoryRouter initialEntries={['/connectors/42']}>
        <Routes>
          <Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    const user = userEvent.setup()
    const ui = render(page())
    const urlInput = await screen.findByLabelText('Host / Base URL *')
    await user.clear(urlInput)
    await user.type(urlInput, 'https://new.example.test/v2')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(updateConnectorMock).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          base_url: 'https://new.example.test/v2',
          host: 'https://new.example.test/v2',
        }),
      ),
    )
    expect(persisted.base_url).toBe('https://new.example.test/v2')
    ui.unmount()

    // A new page mount behaves like an operator returning/reloading after Save.
    render(page())
    const savedUrl = (await screen.findByLabelText('Host / Base URL *')) as HTMLInputElement
    expect(savedUrl.value).toBe('https://new.example.test/v2')
  })
})
