import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { buildInitialState } from './wizard-state'
import { StepApiTest } from './step-api-test'

function renderStep(state: ReturnType<typeof buildInitialState>) {
  return render(
    <MemoryRouter>
      <StepApiTest state={state} onChange={vi.fn()} />
    </MemoryRouter>,
  )
}

describe('StepApiTest copy', () => {
  it('renders HTTP-specific lead and idle copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'HTTP_API_POLLING'
    renderStep(state)
    expect(screen.getByText(/execute the configured HTTP request/i)).toBeInTheDocument()
    expect(
      screen.getByText(/complete the HTTP endpoint path on the Stream Configuration step/i),
    ).toBeInTheDocument()
  })

  it('does not show JSON tree or formatted response on Run Test', () => {
    const state = buildInitialState()
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.eventCount = 3
    state.apiTest.statusCode = 200
    state.apiTest.finishedAt = Date.now()
    state.apiTest.startedAt = state.apiTest.finishedAt - 120
    state.apiTest.parsedJson = { Records: [{ id: 1 }] }
    state.apiTest.rawResponse = state.apiTest.parsedJson

    renderStep(state)

    expect(screen.getByTestId('wizard-run-test-panel')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-run-test-metrics')).toBeInTheDocument()
    expect(screen.queryByText('Formatted JSON')).not.toBeInTheDocument()
    expect(screen.queryByText('Raw Response')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-record-selection-json-tree')).not.toBeInTheDocument()
  })

  it('renders remote-file-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'REMOTE_FILE_POLLING'
    renderStep(state)
    expect(screen.getByText(/SSH\/SFTP/i)).toBeInTheDocument()
    expect(screen.getByText(/matched files/i)).toBeInTheDocument()
  })

  it('renders database-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    renderStep(state)
    expect(screen.getByText(/SELECT-only/i)).toBeInTheDocument()
    expect(screen.getByText(/checkpoint fields/i)).toBeInTheDocument()
  })

  it('renders S3-specific lead copy', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'S3_OBJECT_POLLING'
    renderStep(state)
    expect(screen.getByText(/Verifies S3 connectivity for the configured bucket/i)).toBeInTheDocument()
    expect(screen.getByText(/how ordering aligns with the checkpoint field/i)).toBeInTheDocument()
  })

  it('shows the actual tested HTTP request beside a successful sample result without exposing raw auth secrets', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'HTTP_API_POLLING'
    state.connector.connectorId = 17
    state.connector.sourceId = 23
    state.connector.connectorName = 'Saved HTTP Connector'
    state.connector.authType = 'BEARER'
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.eventCount = 2
    state.apiTest.statusCode = 200
    state.apiTest.startedAt = 100
    state.apiTest.finishedAt = 220
    state.apiTest.actualRequestSent = {
      method: 'POST',
      url: 'https://api.example.test/events?tenant=acme',
      endpoint: '/events',
      queryParams: { tenant: 'acme', api_key: '***' },
      headersMasked: { Authorization: '***', 'X-Tenant': 'acme' },
      jsonBodyMasked: { query: 'alerts', access_token: '***' },
      timeoutSeconds: 30,
    }

    renderStep(state)

    const context = screen.getByTestId('wizard-run-test-http-context')
    expect(context).toHaveTextContent('POST')
    expect(context).toHaveTextContent('https://api.example.test/events?tenant=acme')
    expect(context).toHaveTextContent('tenant=acme')
    expect(context).toHaveTextContent('api_key=***')
    expect(context).toHaveTextContent('Authentication inherited from Saved HTTP Connector')
    const requestDetails = screen.getByTestId('wizard-run-test-http-request-details')
    expect(requestDetails).toHaveTextContent('2 headers')
    expect(requestDetails).toHaveTextContent('body configured')
    expect(requestDetails).toHaveTextContent('Authorization=***')
    expect(requestDetails).toHaveTextContent('X-Tenant=acme')
    expect(requestDetails).toHaveTextContent('"query": "alerts"')
    expect(requestDetails).toHaveTextContent('"access_token": "***"')
    expect(context).not.toHaveTextContent('Bearer secret-value')
  })

  it('shows bounded actual database rows, field types, and incremental checkpoint context without exposing bind values', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'DATABASE_QUERY'
    state.connector.connectorId = 51
    state.connector.sourceId = 61
    state.connector.connectorName = 'Saved PostgreSQL'
    state.stream.sqlQuery = 'SELECT "id", "event_ts" FROM "public"."events" WHERE "severity" = %(ui_filter_1)s'
    state.stream.dbQueryParams = { ui_filter_1: 'super-sensitive-filter-value' }
    state.stream.dbCheckpointMode = 'SINGLE_COLUMN'
    state.stream.dbCheckpointColumn = 'id'
    state.apiTest.status = 'success'
    state.apiTest.ok = true
    state.apiTest.statusCode = 200
    state.apiTest.eventCount = 2
    state.apiTest.startedAt = 100
    state.apiTest.finishedAt = 145
    state.apiTest.parsedJson = [
      { id: 1, event_ts: '2026-10-14T01:00:00Z' },
      { id: 2, event_ts: '2026-10-14T01:00:01Z' },
    ]
    state.apiTest.rawResponse = state.apiTest.parsedJson

    renderStep(state)

    const context = screen.getByTestId('wizard-run-test-database-context')
    expect(context).toHaveTextContent('Actual database query preview')
    expect(context).toHaveTextContent('2 returned rows')
    expect(context).toHaveTextContent('preview cap 25')
    expect(context).toHaveTextContent('1 bound parameter')
    expect(context).toHaveTextContent('Incremental · checkpoint id')
    expect(context).toHaveTextContent('45 ms')
    expect(context).toHaveTextContent('id number')
    expect(context).toHaveTextContent('event_ts string')
    expect(screen.getByTestId('wizard-run-test-database-rows')).toHaveTextContent('2026-10-14T01:00:01Z')
    expect(context).not.toHaveTextContent('super-sensitive-filter-value')
  })

  it('shows the saved webhook receiver identity and auth posture without exposing a secret', () => {
    const state = buildInitialState()
    state.connector.sourceType = 'WEBHOOK_RECEIVER'
    state.connector.connectorId = 31
    state.connector.sourceId = 41
    state.connector.webhookReceiverPath = '/api/v1/ingest/webhook/rx-safe'
    state.connector.webhookAuthMode = 'shared_secret_header'
    state.connector.webhookAuthHeaderName = 'X-Webhook-Secret'
    state.connector.webhookSharedSecretConfigured = true
    state.connector.webhookMaxRequestBytes = 2048

    renderStep(state)

    const context = screen.getByTestId('wizard-run-test-webhook-context')
    expect(context).toHaveTextContent('/api/v1/ingest/webhook/rx-safe')
    expect(context).toHaveTextContent('Shared secret header (X-Webhook-Secret) · configured')
    expect(context).toHaveTextContent('2,048 bytes')
    expect(context).toHaveTextContent(/waiting for producer/i)
    expect(context).not.toHaveTextContent('super-secret-value')
    expect(screen.getByTestId('wizard-webhook-waiting-state')).toHaveTextContent(/not a connector failure/i)
  })

  it('uses the saved webhook payload preview instead of fabricating a fixed sample', async () => {
    const state = buildInitialState()
    state.connector.sourceType = 'WEBHOOK_RECEIVER'
    state.connector.connectorId = 31
    state.connector.sourceId = 41
    state.connector.webhookReceiverPath = '/api/v1/ingest/webhook/rx-safe'
    state.connector.webhookPayloadPreview = '{"id":"evt-1","message":"first"}\n{"id":"evt-2","message":"second"}'
    const onChange = vi.fn()

    render(
      <MemoryRouter>
        <StepApiTest state={state} onChange={onChange} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }))

    await waitFor(() => {
      expect(onChange.mock.calls.some(([next]) => next.status === 'success')).toBe(true)
    })
    const success = onChange.mock.calls.map(([next]) => next).find((next) => next.status === 'success')
    expect(success?.apiBacked).toBe(false)
    expect(success?.eventCount).toBe(2)
    expect(success?.analysis?.responseSummary.root_type).toBe('ndjson')
    expect(success?.analysis?.flatPreviewFields).toEqual(expect.arrayContaining(['$.id', '$.message']))
    expect(success?.rawBody).toContain('evt-2')
    expect(success?.rawBody).not.toContain('webhook-receiver-ready')
  })

  it('keeps a saved webhook receiver in a non-error waiting state when no preview payload exists', async () => {
    const state = buildInitialState()
    state.connector.sourceType = 'WEBHOOK_RECEIVER'
    state.connector.connectorId = 31
    state.connector.sourceId = 41
    state.connector.webhookReceiverPath = '/api/v1/ingest/webhook/rx-safe'
    const onChange = vi.fn()

    render(
      <MemoryRouter>
        <StepApiTest state={state} onChange={onChange} onAdvanceToRecordSelection={vi.fn()} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run Test' }))

    await waitFor(() => {
      expect(onChange.mock.calls.some(([next]) => next.status === 'success')).toBe(true)
    })
    const success = onChange.mock.calls.map(([next]) => next).find((next) => next.status === 'success')
    expect(success?.eventCount).toBe(0)
    expect(success?.hint).toMatch(/waiting for a producer event is normal/i)
    expect(success?.errorCode).toBeNull()
  })

  it.each([
    ['connection_error', null, 'Connection'],
    ['oauth2_token_failed', 401, 'Authentication'],
    ['target_401_unauthorized', 401, 'Authentication'],
    ['invalid_json_response', 200, 'Response'],
    ['http_error', 500, 'Response'],
  ] as const)('labels %s with status %s as a %s-stage Run Test failure', (errorType, statusCode, expectedStage) => {
    const state = buildInitialState()
    state.connector.sourceType = 'HTTP_API_POLLING'
    state.apiTest.status = 'error'
    state.apiTest.ok = false
    state.apiTest.errorCode = errorType
    state.apiTest.errorType = errorType
    state.apiTest.errorMessage = 'Synthetic test failure'
    state.apiTest.targetStatusCode = statusCode
    state.apiTest.finishedAt = Date.now()

    renderStep(state)

    expect(screen.getByTestId('wizard-run-test-failure-stage')).toHaveTextContent(expectedStage)
  })
})
