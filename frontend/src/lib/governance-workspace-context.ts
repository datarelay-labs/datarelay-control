export type GovernanceWorkspaceContext =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | {
      kind: 'matched'
      streamId: number
      streamName: string
      routeId: number | null
      routeName: string | null
    }

type StreamRef = { id: number; name?: string | null }
type RouteRef = { id: number; name?: string | null; stream_id?: number | null }

function parseIdToken(raw: string | null): { supplied: boolean; id: number | null } {
  if (raw == null) return { supplied: false, id: null }
  const trimmed = raw.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return { supplied: true, id: null }
  const id = Number(trimmed)
  if (!Number.isSafeInteger(id)) return { supplied: true, id: null }
  return { supplied: true, id }
}

function streamLabel(stream: StreamRef): string {
  return stream.name?.trim() || `Stream #${stream.id}`
}

function routeLabel(route: RouteRef): string {
  return route.name?.trim() || `Route #${route.id}`
}

/** Resolve Governance Workspace `stream_id` / `route_id` against already loaded rows. */
export function resolveGovernanceWorkspaceContext(
  search: URLSearchParams | string,
  streams: StreamRef[],
  routes: RouteRef[],
): GovernanceWorkspaceContext {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const streamToken = parseIdToken(params.get('stream_id'))
  const routeToken = parseIdToken(params.get('route_id'))
  if (!streamToken.supplied && !routeToken.supplied) return { kind: 'none' }
  if ((streamToken.supplied && streamToken.id == null) || (routeToken.supplied && routeToken.id == null)) {
    return { kind: 'unavailable' }
  }

  if (routeToken.id != null) {
    const route = routes.find((row) => row.id === routeToken.id)
    const routeStreamId = route?.stream_id
    if (route == null || routeStreamId == null) return { kind: 'unavailable' }
    if (streamToken.id != null && streamToken.id !== routeStreamId) return { kind: 'unavailable' }
    const stream = streams.find((row) => row.id === routeStreamId)
    if (stream == null) return { kind: 'unavailable' }
    return {
      kind: 'matched',
      streamId: stream.id,
      streamName: streamLabel(stream),
      routeId: route.id,
      routeName: routeLabel(route),
    }
  }

  const stream = streams.find((row) => row.id === streamToken.id)
  if (stream == null) return { kind: 'unavailable' }
  return {
    kind: 'matched',
    streamId: stream.id,
    streamName: streamLabel(stream),
    routeId: null,
    routeName: null,
  }
}
