import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from './api'
import { formatApiErrorMessage } from './lib/api-error-message'

function stubErrorResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    ),
  )
}

async function failureMessage(): Promise<string> {
  try {
    await requestJson('/api/v1/backup/curl/parse', { method: 'POST', body: '{}' })
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected requestJson to reject')
}

describe('requestJson failure messages (F-010)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('names the invalid field for a FastAPI request-validation 422 instead of "Request failed"', async () => {
    stubErrorResponse(422, {
      detail: [{ type: 'string_too_short', loc: ['body', 'curl_command'], msg: 'String should have at least 1 character' }],
    })
    const message = await failureMessage()
    expect(message).toBe('422: curl_command: String should have at least 1 character')
    expect(message).not.toMatch(/Request failed/)
  })

  it('keeps the code and reason for a structured 422 detail without a message', async () => {
    stubErrorResponse(422, { detail: { error_code: 'CURL_PARSE_FAILED', reason: 'No URL found in curl command.' } })
    expect(await failureMessage()).toBe('422: [CURL_PARSE_FAILED] No URL found in curl command.')
  })

  it('keeps a bare error code when the backend sends nothing else, and the display helper explains it', async () => {
    stubErrorResponse(422, { detail: { error_code: 'CURL_PARSE_FAILED', warnings: [] } })
    const message = await failureMessage()
    expect(message).toBe('422: [CURL_PARSE_FAILED]')
    expect(formatApiErrorMessage(message)).toMatch(/rejected the request as invalid/i)
  })

  it('preserves the existing transport format used by other callers', async () => {
    stubErrorResponse(409, { detail: { error_code: 'ROUTE_STALE_WRITE', message: 'Route changed since you started editing.' } })
    expect(await failureMessage()).toBe('409: [ROUTE_STALE_WRITE] Route changed since you started editing.')
  })
})
