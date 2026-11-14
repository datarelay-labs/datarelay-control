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

  it('stores the Test path entered on this page with the connector and restores it (F-116)', async () => {
    fetchConnectorByIdMock.mockResolvedValue({
      id: 7,
      name: 'Test path fixture',
      description: '',
      status: 'STOPPED',
      connector_type: 'generic_http',
      source_type: 'HTTP_API_POLLING',
      source_id: 11,
      stream_count: 0,
      host: 'https://api.example.invalid',
      base_url: 'https://api.example.invalid',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
      auth_test_path: '/v1/me',
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

    const testPath = await screen.findByLabelText('Test path')
    expect(testPath).toHaveValue('/v1/me')
    expect(screen.getByTestId('auth-test-path-hint')).toHaveTextContent(/Test Auth in the Connectors list/i)

    await user.clear(testPath)
    await user.type(testPath, '/v2/ping')
    await user.click(screen.getByRole('button', { name: 'Save', exact: true }))

    await waitFor(() =>
      expect(updateConnectorMock).toHaveBeenCalledWith(7, expect.objectContaining({ auth_test_path: '/v2/ping' })),
    )
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

describe('ConnectorDetailPage Webhook Receiver surface', () => {
  afterEach(() => {
    clearTestSession()
    vi.clearAllMocks()
  })

  it('does not show outbound HTTP auth-test guidance for an inbound Webhook Receiver', async () => {
    persistTestSession('OPERATOR')
    fetchConnectorByIdMock.mockResolvedValue({
      id: 9,
      name: 'Webhook receiver',
      description: '',
      status: 'STOPPED',
      connector_type: 'webhook_receiver',
      source_type: 'WEBHOOK_RECEIVER',
      source_id: 13,
      stream_count: 0,
      host: '',
      base_url: '',
      verify_ssl: true,
      http_proxy: null,
      common_headers: {},
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
      receiver_key: 'receiver-fixture',
      webhook_auth_mode: 'no_auth',
      webhook_auth_header_name: 'X-GDC-Webhook-Secret',
      max_request_bytes: 1048576,
    })

    render(
      <MemoryRouter initialEntries={['/connectors/9']}>
        <Routes><Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} /></Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByDisplayValue('Webhook receiver')).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Webhook Receiver' })).toBeInTheDocument()
    expect(screen.queryByText('Auth Test Request')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test Authentication' })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('/connect/api/v1/alerts')).not.toBeInTheDocument()
    expect(runConnectorAuthTestMock).not.toHaveBeenCalled()
  })
})

describe('ConnectorDetailPage connectivity test reflects the visible draft for non-HTTP connectors (E-009)', () => {
  afterEach(() => {
    clearTestSession()
    vi.clearAllMocks()
  })

  function renderDetail(row: Record<string, unknown>) {
    fetchConnectorByIdMock.mockResolvedValue({
      id: 10,
      description: '',
      status: 'STOPPED',
      source_id: 11,
      stream_count: 0,
      auth_type: 'no_auth',
      auth: { auth_type: 'no_auth' },
      ...row,
    })
    runConnectorAuthTestMock.mockResolvedValue({ ok: false, auth_type: 'X', message: 'failed' })
    return render(
      <MemoryRouter initialEntries={['/connectors/10']}>
        <Routes>
          <Route path="/connectors/:connectorId" element={<ConnectorDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('sends the edited database host and password together with the saved connector id', async () => {
    renderDetail({
      name: 'bfs-b1-pg',
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      host: 'db.saved.example',
      port: 5432,
      database: 'audit',
      db_type: 'POSTGRESQL',
      db_username: 'bfs_reader',
      db_password_configured: true,
      ssl_mode: 'PREFER',
    })
    const user = userEvent.setup()

    const host = await screen.findByLabelText('Database host')
    await user.clear(host)
    await user.type(host, '203.0.113.9')
    const password = screen.getByLabelText('Password *')
    await user.clear(password)
    await user.type(password, 'typed-wrong-password')
    await user.click(screen.getByRole('button', { name: 'Test database connectivity' }))

    await waitFor(() => expect(runConnectorAuthTestMock).toHaveBeenCalledTimes(1))
    expect(runConnectorAuthTestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 10,
        inline_flat_source: expect.objectContaining({
          source_type: 'DATABASE_QUERY',
          host: '203.0.113.9',
          password: 'typed-wrong-password',
        }),
      }),
    )
  })

  it('keeps the masked saved database password as the mask so the server resolves it', async () => {
    renderDetail({
      name: 'bfs-b1-pg',
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      host: 'db.saved.example',
      port: 5432,
      database: 'audit',
      db_type: 'POSTGRESQL',
      db_username: 'bfs_reader',
      db_password_configured: true,
    })
    const user = userEvent.setup()

    await screen.findByLabelText('Database host')
    await user.click(screen.getByRole('button', { name: 'Test database connectivity' }))

    await waitFor(() => expect(runConnectorAuthTestMock).toHaveBeenCalledTimes(1))
    const sent = runConnectorAuthTestMock.mock.calls[0][0]
    expect(sent.connector_id).toBe(10)
    expect(sent.inline_flat_source.password).toBe('********')
  })

  it('sends the edited S3 secret key and region together with the saved connector id', async () => {
    renderDetail({
      name: 'bfs-b1-s3',
      connector_type: 's3_compatible',
      source_type: 'S3_OBJECT_POLLING',
      endpoint_url: 'http://s3.saved.example:9000',
      bucket: 'audit-bucket',
      region: 'us-east-1',
      access_key: 'AKSAVED',
      secret_key_configured: true,
    })
    const user = userEvent.setup()

    const secret = await screen.findByLabelText('S3 Secret key')
    await user.clear(secret)
    await user.type(secret, 'typed-wrong-secret')
    const region = screen.getByLabelText('S3 Region')
    await user.clear(region)
    await user.type(region, 'eu-west-9')
    await user.click(screen.getByRole('button', { name: 'Test S3 connectivity' }))

    await waitFor(() => expect(runConnectorAuthTestMock).toHaveBeenCalledTimes(1))
    expect(runConnectorAuthTestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 10,
        inline_flat_source: expect.objectContaining({
          source_type: 'S3_OBJECT_POLLING',
          secret_key: 'typed-wrong-secret',
          region: 'eu-west-9',
        }),
      }),
    )
  })

  it('sends the edited remote-file password together with the saved connector id', async () => {
    renderDetail({
      name: 'bfs-b1-sftp',
      connector_type: 'remote_file',
      source_type: 'REMOTE_FILE_POLLING',
      host: 'sftp.saved.example',
      port: 22,
      remote_username: 'bfs',
      remote_password_configured: true,
      remote_file_protocol: 'sftp',
    })
    const user = userEvent.setup()

    const password = await screen.findByLabelText(/^Password/)
    await user.clear(password)
    await user.type(password, 'typed-wrong-password')
    await user.type(screen.getByLabelText('Remote directory *'), '/incoming')
    await user.click(screen.getByRole('button', { name: 'Test remote file connectivity' }))

    await waitFor(() => expect(runConnectorAuthTestMock).toHaveBeenCalledTimes(1))
    expect(runConnectorAuthTestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connector_id: 10,
        inline_flat_source: expect.objectContaining({
          source_type: 'REMOTE_FILE_POLLING',
          remote_password: 'typed-wrong-password',
        }),
        remote_file_stream_config: expect.objectContaining({ remote_directory: '/incoming' }),
      }),
    )
  })

  it('explains what is missing instead of sending an unusable draft', async () => {
    renderDetail({
      name: 'bfs-b1-pg',
      connector_type: 'relational_database',
      source_type: 'DATABASE_QUERY',
      host: 'db.saved.example',
      port: 5432,
      database: 'audit',
      db_type: 'POSTGRESQL',
      db_username: 'bfs_reader',
      db_password_configured: true,
    })
    const user = userEvent.setup()

    await user.clear(await screen.findByLabelText('Database host'))
    await user.click(screen.getByRole('button', { name: 'Test database connectivity' }))

    expect(await screen.findByText(/Database host and database name are required/)).toBeInTheDocument()
    expect(runConnectorAuthTestMock).not.toHaveBeenCalled()
  })
})
