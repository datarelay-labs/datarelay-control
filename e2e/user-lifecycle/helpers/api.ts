import { redactValue } from './redact.js'
import { TIMEOUTS } from './types.js'

export type Json = Record<string, unknown>

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token
  }

  private headers(hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (hasBody) h['Content-Type'] = 'application/json'
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = TIMEOUTS.apiMs,
  ): Promise<{ status: number; json: any; text: string }> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let json: any = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = text
      }
      return { status: res.status, json, text }
    } finally {
      clearTimeout(t)
    }
  }

  async login(username = 'admin', password = 'admin'): Promise<void> {
    if ((process.env.REQUIRE_AUTH || 'false').toLowerCase() !== 'true') {
      this.token = null
      return
    }
    const { status, json } = await this.request('POST', '/api/v1/auth/login', { username, password })
    if (status >= 400 || !json?.access_token) throw new Error(`login failed: ${status}`)
    this.token = json.access_token
  }

  async listConnectors(): Promise<any[]> {
    const { status, json } = await this.request('GET', '/api/v1/connectors/?page_size=200')
    if (status >= 400) return []
    if (Array.isArray(json)) return json
    if (Array.isArray(json?.items)) return json.items
    if (Array.isArray(json?.connectors)) return json.connectors
    return []
  }

  async listStreams(): Promise<any[]> {
    const { status, json } = await this.request('GET', '/api/v1/streams/')
    if (status >= 400) return []
    if (Array.isArray(json)) return json
    if (Array.isArray(json?.items)) return json.items
    if (Array.isArray(json?.streams)) return json.streams
    return []
  }

  async listDestinations(): Promise<any[]> {
    const { status, json } = await this.request('GET', '/api/v1/destinations/')
    if (status >= 400) return []
    if (Array.isArray(json)) return json
    if (Array.isArray(json?.items)) return json.items
    if (Array.isArray(json?.destinations)) return json.destinations
    return []
  }

  async getConnector(id: number): Promise<any> {
    const { json } = await this.request('GET', `/api/v1/connectors/${id}`)
    return json
  }

  async getStream(id: number): Promise<any> {
    const { json } = await this.request('GET', `/api/v1/streams/${id}`)
    return json
  }

  async deleteConnector(id: number): Promise<number> {
    return (await this.request('DELETE', `/api/v1/connectors/${id}`)).status
  }

  async deleteStream(id: number): Promise<number> {
    return (await this.request('DELETE', `/api/v1/streams/${id}`)).status
  }

  async deleteDestination(id: number): Promise<number> {
    return (await this.request('DELETE', `/api/v1/destinations/${id}`)).status
  }

  async stopStream(id: number): Promise<{ status: number; json: any }> {
    return this.request('POST', `/api/v1/runtime/streams/${id}/stop`)
  }

  async startStream(id: number): Promise<{ status: number; json: any }> {
    return this.request('POST', `/api/v1/runtime/streams/${id}/start`)
  }

  async runOnce(id: number): Promise<{ status: number; json: any }> {
    return this.request('POST', `/api/v1/runtime/streams/${id}/run-once`, {})
  }

  async getCheckpoint(streamId: number): Promise<any> {
    const { json } = await this.request('GET', `/api/v1/runtime/streams/${streamId}/checkpoint`)
    return json
  }

  async getRuntimeConfiguration(streamId: number): Promise<{ status: number; json: any }> {
    return this.request('GET', `/api/v1/runtime/streams/${streamId}/configuration`)
  }

  /**
   * Update destination config via canonical PUT + optimistic concurrency.
   * Destinations API does not expose PATCH; callers must send expected_updated_at.
   */
  async patchDestination(
    id: number,
    body: Json,
  ): Promise<{ status: number; json: any }> {
    const current = await this.request('GET', `/api/v1/destinations/${id}`)
    if (current.status >= 400 || !current.json) {
      return current
    }
    const prevCfg =
      current.json.config_json && typeof current.json.config_json === 'object'
        ? { ...(current.json.config_json as Record<string, unknown>) }
        : {}
    const nextCfg =
      body.config_json && typeof body.config_json === 'object'
        ? { ...prevCfg, ...(body.config_json as Record<string, unknown>) }
        : prevCfg
    const payload: Json = {
      name: current.json.name,
      destination_type: current.json.destination_type,
      enabled: body.enabled !== undefined ? body.enabled : current.json.enabled,
      config_json: nextCfg,
      rate_limit_json: current.json.rate_limit_json || {},
      expected_updated_at: current.json.updated_at,
    }
    if (body.name !== undefined) payload.name = body.name
    if (body.destination_type !== undefined) payload.destination_type = body.destination_type
    return this.request('PUT', `/api/v1/destinations/${id}`, payload)
  }

  async getDestination(id: number): Promise<any> {
    const { json } = await this.request('GET', `/api/v1/destinations/${id}`)
    return json
  }

  async listRoutes(): Promise<any[]> {
    const { status, json } = await this.request('GET', '/api/v1/routes/')
    if (status >= 400) return []
    if (Array.isArray(json)) return json
    if (Array.isArray(json?.items)) return json.items
    return []
  }

  async listRoutesForStream(streamId: number): Promise<any[]> {
    const routes = await this.listRoutes()
    return routes.filter((r) => Number(r.stream_id ?? r.streamId) === streamId)
  }

  async deleteRoute(id: number): Promise<number> {
    return (await this.request('DELETE', `/api/v1/routes/${id}`)).status
  }

  async findByNamePrefix(prefix: string): Promise<{
    connectors: any[]
    streams: any[]
    destinations: any[]
    routes: any[]
  }> {
    const [connectors, streams, destinations, routes] = await Promise.all([
      this.listConnectors(),
      this.listStreams(),
      this.listDestinations(),
      this.listRoutes(),
    ])
    const match = (rows: any[]) => rows.filter((r) => String(r.name || '').includes(prefix))
    return {
      connectors: match(connectors),
      streams: match(streams),
      destinations: match(destinations),
      routes: match(routes),
    }
  }

  safeJson(data: unknown): unknown {
    return redactValue(data)
  }
}

export async function stubWiremock(
  wiremockBase: string,
  pathName: string,
  body: unknown,
  opts: { status?: number; bearer?: string; method?: string } = {},
): Promise<void> {
  const method = opts.method || 'GET'
  // Replace prior mappings for this path; otherwise seed stubs (ids 1-12) keep matching first.
  try {
    const listed = await fetch(`${wiremockBase}/__admin/mappings`)
    if (listed.ok) {
      const payload = (await listed.json()) as { mappings?: Array<{ id?: string; request?: { urlPath?: string; method?: string } }> }
      for (const mapping of payload.mappings || []) {
        const samePath = mapping.request?.urlPath === pathName
        const sameMethod = String(mapping.request?.method || 'GET').toUpperCase() === method
        if (samePath && sameMethod && mapping.id) {
          await fetch(`${wiremockBase}/__admin/mappings/${mapping.id}`, { method: 'DELETE' }).catch(() => null)
        }
      }
    }
  } catch {
    /* continue and POST the new mapping */
  }
  const request: Json = {
    method,
    urlPath: pathName,
  }
  if (opts.bearer) {
    request.headers = { Authorization: { equalTo: `Bearer ${opts.bearer}` } }
  }
  await fetch(`${wiremockBase}/__admin/mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request,
      response: {
        status: opts.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: body,
      },
    }),
  })
}

export async function echoHasMarker(echoUrl: string, pathSuffix: string, marker: string): Promise<boolean> {
  // Prefer collector if available; else docker logs via optional helper endpoint.
  try {
    const res = await fetch(`${echoUrl}${pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`}`, {
      method: 'GET',
    })
    const text = await res.text()
    if (text.includes(marker)) return true
  } catch {
    /* fall through */
  }
  // Fallback: request echo admin dump if present
  try {
    const res = await fetch(`${echoUrl}/__echo/recent?limit=500`)
    if (res.ok) {
      const text = await res.text()
      return text.includes(marker) && text.includes(pathSuffix)
    }
  } catch {
    /* ignore */
  }
  return false
}
