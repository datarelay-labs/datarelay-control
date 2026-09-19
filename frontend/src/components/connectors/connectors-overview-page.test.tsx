import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GDC_AUTH_REQUIRED_MESSAGE } from '../../api/gdcConnectors'
import { CATALOG_CONNECTORS_LIST_KEY } from '../../api/catalogListCache'
import { clearSharedRequestCache } from '../../api/requestCache'
import { CONNECTORS_RETRY_BUTTON_MS, CONNECTORS_SLOW_LOADING_MS } from '../../hooks/use-connectors-overview-data'
import { clearConnectorsOverviewSnapshot } from './connectors-overview-cache'
import { ConnectorsOverviewPage } from './connectors-overview-page'

const fetchConnectorsListResultMock = vi.fn()
const fetchStreamsListMock = vi.fn()
const fetchConnectorOperationsSummaryMock = vi.fn()
const deleteConnectorMock = vi.fn()

vi.mock('../../api/gdcConnectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcConnectors')>()
  return {
    ...actual,
    fetchConnectorsListResult: () => fetchConnectorsListResultMock(),
    deleteConnector: () => deleteConnectorMock(),
  }
})

vi.mock('../../api/gdcConnectorsOperations', () => ({
  fetchConnectorOperationsSummary: () => fetchConnectorOperationsSummaryMock(),
  runConnectorAuthCheck: vi.fn(),
  runConnectorQueryTest: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsList: () => fetchStreamsListMock(),
}))

function fakeConnector(id: number, name: string, extras: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name,
    description: 'fixture',
    status: 'RUNNING',
    connector_type: 'generic_http',
    source_type: 'HTTP_API_POLLING',
    source_id: id,
    stream_count: 1,
    host: 'http://127.0.0.1:28080',
    base_url: 'http://127.0.0.1:28080',
    verify_ssl: false,
    http_proxy: null,
    common_headers: {},
    auth_type: 'no_auth',
    auth: { auth_type: 'no_auth' },
    created_at: '2026-05-11T12:49:13Z',
    updated_at: '2026-05-11T12:49:13Z',
    ...extras,
  }
}

function resetConnectorMocks() {
  fetchConnectorsListResultMock.mockReset()
  fetchStreamsListMock.mockReset()
  fetchConnectorOperationsSummaryMock.mockReset()
  deleteConnectorMock.mockReset()
  fetchStreamsListMock.mockResolvedValue([])
  fetchConnectorOperationsSummaryMock.mockResolvedValue({ window: '1h', generated_at: null, connectors: [] })
  clearSharedRequestCache('catalog-connectors', CATALOG_CONNECTORS_LIST_KEY)
  clearConnectorsOverviewSnapshot()
}

describe('ConnectorsOverviewPage — Dev Validation Lab visibility', () => {
  beforeEach(() => {
    resetConnectorMocks()
  })

  it('renders [DEV VALIDATION] connectors with the Dev lab badge', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [
        fakeConnector(1, '[DEV VALIDATION] Generic REST'),
        fakeConnector(2, '[DEV VALIDATION] Basic Auth'),
        fakeConnector(3, 'Production Okta'),
      ],
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('[DEV VALIDATION] Generic REST')).toBeInTheDocument()
    expect(screen.getByText('[DEV VALIDATION] Basic Auth')).toBeInTheDocument()
    expect(screen.getByText('Production Okta')).toBeInTheDocument()
    const badges = screen.getAllByText('Dev lab')
    expect(badges.length).toBe(2)
  })

  it('shows import from cURL / Postman entry', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({ ok: true, status: 200, data: [] })
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('connectors-empty-state')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import from cURL / Postman' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Import from cURL / Postman' }))
    expect(screen.getByRole('button', { name: 'Parse cURL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parse collection' })).toBeInTheDocument()
  })

  it('"Dev validation lab only" filter hides non-lab connectors', async () => {
    const user = userEvent.setup()
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [fakeConnector(1, '[DEV VALIDATION] Generic REST'), fakeConnector(2, 'Production Okta')],
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Production Okta')).toBeInTheDocument()
    const toggle = screen.getByLabelText('Dev validation lab only filter')
    await user.click(toggle)

    expect(screen.getByText('[DEV VALIDATION] Generic REST')).toBeInTheDocument()
    expect(screen.queryByText('Production Okta')).not.toBeInTheDocument()
  })
})

describe('ConnectorsOverviewPage loading UX', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetConnectorMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows empty state when API succeeds with zero connectors', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({ ok: true, status: 200, data: [] })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('connectors-empty-state')).toBeInTheDocument()
    expect(screen.getByText('No connectors yet')).toBeInTheDocument()
    expect(screen.getByText('Create your first connector to start collecting data.')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Create Connector' }).length).toBeGreaterThan(0)
  })

  it('renders the table when API succeeds with connectors', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [fakeConnector(1, 'Production Okta')],
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Production Okta')).toBeInTheDocument()
    expect(screen.getByText('Health')).toBeInTheDocument()
    expect(screen.getByText('Affected')).toBeInTheDocument()
    expect(screen.getByText('Events Trend')).toBeInTheDocument()
    expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connectors-empty-state')).not.toBeInTheDocument()
  })

  it('stops loading and shows error with retry when API fails', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      message: 'Service unavailable',
      authRequired: false,
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('connectors-load-failed')).toHaveTextContent('Service unavailable')
    expect(screen.getByTestId('connectors-retry-button')).toBeInTheDocument()
    expect(screen.queryByText('No connectors found.')).not.toBeInTheDocument()
  })

  it('shows failed load message on timeout without showing no connectors found', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: false,
      status: 0,
      message: 'Request timed out. Check network or API availability and try again.',
      authRequired: false,
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('connectors-load-failed')).toHaveTextContent('Failed to load connectors')
    expect(screen.queryByText('No connectors found.')).not.toBeInTheDocument()
  })

  it('keeps prior connector rows when refresh fails', async () => {
    fetchConnectorsListResultMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: [fakeConnector(1, 'Production Okta')],
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        message: 'Request timed out. Check network or API availability and try again.',
        authRequired: false,
      })

    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Production Okta')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      expect(screen.getByTestId('connectors-stale-data-banner')).toBeInTheDocument()
    })
    expect(screen.getByText('Production Okta')).toBeInTheDocument()
    expect(screen.getByText('Using last successful data.')).toBeInTheDocument()
    expect(screen.queryByText('No connectors found.')).not.toBeInTheDocument()
  })

  it('shows long loading message after 5 seconds', async () => {
    vi.useFakeTimers()
    try {
      fetchConnectorsListResultMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  data: [],
                }),
              CONNECTORS_SLOW_LOADING_MS + 500,
            )
          }),
      )

      render(
        <MemoryRouter>
          <ConnectorsOverviewPage />
        </MemoryRouter>,
      )

      expect(screen.getByTestId('connectors-loading')).toBeInTheDocument()
      expect(screen.queryByTestId('connectors-slow-loading')).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECTORS_SLOW_LOADING_MS + 50)
      })

      expect(screen.getByTestId('connectors-slow-loading')).toBeInTheDocument()
      expect(screen.getByText('Still loading...')).toBeInTheDocument()
      expect(screen.getByText('This may take longer than expected.')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
        await Promise.resolve()
      })

      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows retry button while loading after 15 seconds', async () => {
    vi.useFakeTimers()
    try {
      fetchConnectorsListResultMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  status: 200,
                  data: [],
                }),
              CONNECTORS_RETRY_BUTTON_MS + 500,
            )
          }),
      )

      render(
        <MemoryRouter>
          <ConnectorsOverviewPage />
        </MemoryRouter>,
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECTORS_RETRY_BUTTON_MS + 50)
      })

      expect(screen.getByTestId('connectors-loading-retry-button')).toBeInTheDocument()
      expect(screen.getByText('Keep waiting')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
        await Promise.resolve()
      })

      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps connector list visible when supplementary streams API fails', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: [fakeConnector(1, 'Production Okta', { stream_count: 2 })],
    })
    fetchStreamsListMock.mockRejectedValueOnce(new Error('streams unavailable'))

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Production Okta')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('connectors-supplementary-error')).toBeInTheDocument()
    })
    expect(screen.getByText('Production Okta')).toBeInTheDocument()
  })

  it('does not warn when unmounted before API completes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveList: ((value: unknown) => void) | undefined
    fetchConnectorsListResultMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )

    const { unmount } = render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    unmount()

    await act(async () => {
      resolveList?.({
        ok: true,
        status: 200,
        data: [fakeConnector(1, 'Late Connector')],
      })
      await Promise.resolve()
    })

    const reactWarnings = consoleError.mock.calls.filter(([message]) =>
      String(message).includes('not wrapped in act'),
    )
    expect(reactWarnings).toHaveLength(0)
    consoleError.mockRestore()
  })

  it('stops loading and surfaces auth message on 401', async () => {
    fetchConnectorsListResultMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      message: GDC_AUTH_REQUIRED_MESSAGE,
      authRequired: true,
    })

    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('connectors-loading')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('connectors-auth-required')).toHaveTextContent(GDC_AUTH_REQUIRED_MESSAGE)
  })
})

describe('ConnectorsOverviewPage — Test Auth visibility', () => {
  beforeEach(() => {
    resetConnectorMocks()
  })

  it('shows list Test Auth success and failure in a visible status, not sr-only', async () => {
    const { runConnectorAuthCheck } = await import('../../api/gdcConnectorsOperations')
    vi.mocked(runConnectorAuthCheck)
      .mockResolvedValueOnce({
        success: true,
        status_code: 200,
        message: 'ok',
        error_code: null,
        last_auth_check_at: '2026-09-18T00:00:00Z',
        last_auth_check_status: 'success',
        last_auth_error: null,
        response_time_ms: 12,
      })
      .mockResolvedValueOnce({
        success: false,
        status_code: 401,
        message: 'unauthorized',
        error_code: 'unauthorized',
        last_auth_check_at: '2026-09-18T00:00:01Z',
        last_auth_check_status: 'failed',
        last_auth_error: 'Invalid bearer token',
        response_time_ms: 8,
      })
    fetchConnectorsListResultMock.mockResolvedValue({
      ok: true,
      status: 200,
      data: [fakeConnector(1, 'Production Okta')],
    })
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <ConnectorsOverviewPage />
      </MemoryRouter>,
    )
    expect(await screen.findByText('Production Okta')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Connector actions'))
    await user.click(screen.getByRole('menuitem', { name: 'Test Auth' }))
    const success = await screen.findByTestId('connector-row-auth-result')
    expect(success).toHaveTextContent('Auth test succeeded')
    expect(success.className).not.toMatch(/\bsr-only\b/)

    await user.click(screen.getByLabelText('Connector actions'))
    await user.click(screen.getByRole('menuitem', { name: 'Test Auth' }))
    const failure = await screen.findByText('Invalid bearer token')
    expect(failure).toHaveAttribute('data-testid', 'connector-row-auth-result')
    expect(failure.className).not.toMatch(/\bsr-only\b/)
  })
})
