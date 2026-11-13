import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { fetchRouteById } from '../../api/gdcRoutes'
import { fetchStreamById } from '../../api/gdcStreams'
import { NAV_PATH } from '../../config/nav-paths'

/** A canonical positive integer id. "007", "1e3", "-4", "abc" and "" are all rejected. */
export function parseEntityIdParam(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

type EntityKind = 'stream' | 'route' | 'connector'

const KIND_LABEL: Record<EntityKind, string> = { stream: 'Stream', route: 'Route', connector: 'Connector' }
const KIND_LIST: Record<EntityKind, { path: string; label: string }> = {
  stream: { path: NAV_PATH.streams, label: 'Streams' },
  route: { path: NAV_PATH.routes, label: 'Routes' },
  connector: { path: NAV_PATH.connectors, label: 'Connectors' },
}

/**
 * Shared "this object does not exist" state (F-216, F-217, F-019). Used instead of rendering
 * an editable workspace for an id the backend does not know, or for a malformed id.
 */
export function EntityNotFound({ kind, rawId, malformed }: { kind: EntityKind; rawId: string; malformed: boolean }) {
  const label = KIND_LABEL[kind]
  const list = KIND_LIST[kind]
  return (
    <section
      role="region"
      aria-label={`${label} not found`}
      data-testid="entity-not-found"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Error</p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{label} not found</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-gdc-muted">
        {malformed
          ? `"${rawId}" is not a valid ${label.toLowerCase()} id. ${label} ids are positive whole numbers.`
          : `${label} #${rawId} does not exist, was deleted, or could not be loaded. Nothing was opened for editing.`}
      </p>
      <p className="mt-4">
        <Link to={list.path} className="text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300">
          Back to {list.label}
        </Link>
      </p>
    </section>
  )
}

type Lookup = 'pending' | 'found' | 'missing'

function useEntityLookup(id: number | null, load: (id: number) => Promise<unknown>): Lookup {
  const [state, setState] = useState<{ id: number | null; result: Lookup }>({ id: null, result: 'pending' })
  useEffect(() => {
    if (id == null) return undefined
    let cancelled = false
    void load(id)
      .then((row) => {
        if (!cancelled) setState({ id, result: row == null ? 'missing' : 'found' })
      })
      .catch(() => {
        if (!cancelled) setState({ id, result: 'missing' })
      })
    return () => {
      cancelled = true
    }
    // `load` is a stable module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return state.id === id ? state.result : 'pending'
}

function PendingLookup() {
  return (
    <section
      role="status"
      aria-label="Loading page"
      aria-live="polite"
      data-testid="entity-lookup-pending"
      className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:text-gdc-muted"
    >
      Loading…
    </section>
  )
}

/** Gate for `/streams/:streamId/...`-style pages (param name configurable, e.g. `mappingId`). */
export function RequireStreamParam({ param = 'streamId', children }: { param?: string; children: ReactNode }) {
  const raw = useParams()[param] ?? ''
  const id = parseEntityIdParam(raw)
  const lookup = useEntityLookup(id, fetchStreamById)
  if (id == null) return <EntityNotFound kind="stream" rawId={raw} malformed />
  if (lookup === 'missing') return <EntityNotFound kind="stream" rawId={raw} malformed={false} />
  if (lookup === 'pending') return <PendingLookup />
  return <>{children}</>
}

/** Gate for `/routes/:routeId/edit`. The literal id `new` is the create flow and passes through. */
export function RequireRouteParam({ children }: { children: ReactNode }) {
  const raw = useParams().routeId ?? ''
  const isCreate = raw === 'new'
  const id = isCreate ? null : parseEntityIdParam(raw)
  const lookup = useEntityLookup(id, fetchRouteById)
  if (isCreate) return <>{children}</>
  if (id == null) return <EntityNotFound kind="route" rawId={raw} malformed />
  if (lookup === 'missing') return <EntityNotFound kind="route" rawId={raw} malformed={false} />
  if (lookup === 'pending') return <PendingLookup />
  return <>{children}</>
}

/** Format-only gate for `/connectors/:connectorId`; the detail page already reports a missing connector. */
export function RequireConnectorParam({ children }: { children: ReactNode }) {
  const raw = useParams().connectorId ?? ''
  if (raw !== 'new' && parseEntityIdParam(raw) == null) return <EntityNotFound kind="connector" rawId={raw} malformed />
  return <>{children}</>
}
