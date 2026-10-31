import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeRequestJsonResult } from '../api'
import { postCurlParse, postPostmanParse } from './gdcBackup'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function lastRequestHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const call = fetchMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return (call![1] as RequestInit).headers as Record<string, string>
}

describe('cURL / Postman import requests (F-115)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('postCurlParse sends its JSON body with Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, draft: null, warnings: [], parse_errors: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await postCurlParse("curl -H 'Accept: application/json' https://api.example.com/v1/events", 'My connector')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/backup/curl/parse')
    expect(init.method).toBe('POST')
    expect(lastRequestHeaders(fetchMock)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      curl_command: "curl -H 'Accept: application/json' https://api.example.com/v1/events",
      connector_name: 'My connector',
    })
  })

  it('postPostmanParse sends its JSON body with Content-Type: application/json', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, items: [], draft: null, warnings: [], parse_errors: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await postPostmanParse({ info: { name: 'c' }, item: [] }, { itemId: 'abc' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/backup/postman/parse')
    expect(lastRequestHeaders(fetchMock)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toMatchObject({ item_id: 'abc', collection: { info: { name: 'c' } } })
  })

  it('every safeRequestJsonResult caller that sends a string body gets the JSON content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await safeRequestJsonResult('/api/v1/anything', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(lastRequestHeaders(fetchMock)['Content-Type']).toBe('application/json')
    expect(lastRequestHeaders(fetchMock).Accept).toBe('application/json')
  })

  it('a body-less safeRequestJsonResult request (GET polling) stays header-minimal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await safeRequestJsonResult('/api/v1/streams/')
    const headers = lastRequestHeaders(fetchMock)
    expect(headers['Content-Type']).toBeUndefined()
    expect(headers.Accept).toBe('application/json')
  })

  it('surfaces the server rejection text instead of a generic message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ detail: { error_code: 'CURL_PARSE_FAILED', parse_errors: ['Only http:// and https:// URLs are supported.'] } }, 422),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(postCurlParse('curl file:///etc/passwd')).rejects.toThrow(/Only http/)
  })
})
