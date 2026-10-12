import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorDetailPage } from './connector-detail-page'
import { clearTestSession, persistTestSession } from '../../lib/governance-rbac'
import { persistSession, readSession } from '../../auth/session'

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


describe('ConnectorDetailPage effective role/capability view', () => {
  afterEach(() => {
    clearTestSession()
    vi.clearAllMocks()
  })

  function showConnector() {
    fetchConnectorByIdMock.mockResolvedValue({
      id: 7,
      name: 'Observed connector',
      description: 'Read-only evidence',
      status: 'STOPPED',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      source_id: 11,
      stream_count: 0,
      host: 'https://example.invalid',
      base_url: 'https://example.invalid',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
    })
    render(
      <MemoryRouter initialEntries={['/connectors/7']}>
        <Routes><Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} /></Routes>
      </MemoryRouter>,
    )
  }

  it('lets a Viewer inspect connector details but does not offer editing, cloning, deletion or validation', async () => {
    persistTestSession('VIEWER')
    showConnector()
    expect(await screen.findByDisplayValue('Observed connector')).toBeDisabled()
    expect(screen.getByText('View connector')).toBeInTheDocument()
    for (const name of ['Save', 'Delete', 'Clone connector', 'Test Authentication']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('keeps editing but hides network tests when an Operator loses validation permission', async () => {
    persistTestSession('OPERATOR')
    const session = readSession()!
    persistSession({
      ...session,
      user: { ...session.user, capabilities: {
        ...session.user.capabilities, workspace_mutations: true, validation_mutations: false,
      } },
    })
    showConnector()
    expect(await screen.findByDisplayValue('Observed connector')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test Authentication' })).not.toBeInTheDocument()
  })

  it('reacts to an in-session permission downgrade without dropping observed connector data', async () => {
    persistTestSession('OPERATOR')
    showConnector()
    expect(await screen.findByDisplayValue('Observed connector')).toBeEnabled()
    const session = readSession()!
    act(() => persistSession({
      ...session,
      user: { ...session.user, capabilities: {
        ...session.user.capabilities, workspace_mutations: false, validation_mutations: false,
      } },
    }))
    expect(screen.getByDisplayValue('Observed connector')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test Authentication' })).not.toBeInTheDocument()
    expect(updateConnectorMock).not.toHaveBeenCalled()
  })
})
