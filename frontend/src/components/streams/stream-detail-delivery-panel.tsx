import { Link } from 'react-router-dom'
import { logsExplorerPath, runtimeAnalyticsPath, streamEditPath, streamEnrichmentPath, streamMappingPath } from '../../config/nav-paths'
import { resolveSourceProductLabel } from '../../lib/source-product-group'

type DeliverySection = {
  key: string
  title: string
  body: string
  editLabel: string
  href: (streamId: string) => string
}

const DELIVERY_SECTIONS: DeliverySection[] = [
  {
    key: 'source',
    title: 'Source',
    body: 'Connection, ingest method, and polling schedule for this stream.',
    editLabel: 'Edit source connection',
    href: (id) => `${streamEditPath(id)}?section=source`,
  },
  {
    key: 'mapping',
    title: 'Mapping',
    body: 'Field mapping and record selection rules applied before delivery.',
    editLabel: 'Open mapping workspace',
    href: (id) => streamMappingPath(id),
  },
  {
    key: 'protection',
    title: 'Protection',
    body: 'Sensitive data handling, classification, and policy enforcement.',
    editLabel: 'Open protection settings',
    href: (id) => streamEnrichmentPath(id),
  },
  {
    key: 'destination',
    title: 'Destination',
    body: 'Delivery paths, targets, and failure handling for outbound events.',
    editLabel: 'Edit delivery paths',
    href: (id) => `${streamEditPath(id)}?section=delivery`,
  },
]

export function StreamDetailDeliveryPanel({
  streamId,
  connectorName,
  connectorProductGroup,
  sourceLabel,
  canConfigure,
}: {
  streamId: string
  connectorName: string | null
  connectorProductGroup?: string | null
  sourceLabel: string
  canConfigure: boolean
}) {
  const product = resolveSourceProductLabel(connectorName, { product_group: connectorProductGroup })
  const parsedId = /^[1-9]\d*$/.test(streamId) ? Number(streamId) : NaN
  const scopedId = Number.isSafeInteger(parsedId) && parsedId > 0 ? parsedId : null

  return (
    <section data-testid="stream-detail-delivery-panel" aria-label="Stream delivery path" className="space-y-3">
      <p className="text-[13px] text-slate-600 dark:text-gdc-muted">
        End-to-end delivery path for <span className="font-semibold text-slate-800 dark:text-slate-100">{product}</span>
        {' · '}
        {sourceLabel}
      </p>
      {!canConfigure ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 dark:border-gdc-border dark:bg-gdc-section dark:text-gdc-mutedStrong">
          Read-only monitoring; configuration requires editor access.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {DELIVERY_SECTIONS.map((sec) => (
            <article
              key={sec.key}
              className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm dark:border-gdc-border dark:bg-gdc-card"
            >
              <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{sec.title}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-600 dark:text-gdc-muted">{sec.body}</p>
              {canConfigure ? (
                <Link
                  to={sec.href(streamId)}
                  className="mt-3 inline-flex min-h-10 items-center text-[11px] font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
                >
                  {sec.editLabel} →
                </Link>
              ) : (
                <span className="mt-3 inline-flex min-h-10 items-center text-[11px] font-medium text-slate-500 dark:text-gdc-muted">
                  Configuration view only
                </span>
              )}
            </article>
        ))}
      </div>
      {scopedId != null ? (
        <nav aria-label="Stream delivery investigation" className="rounded-xl border border-violet-200/80 bg-violet-50/40 px-4 py-3 dark:border-gdc-border dark:bg-gdc-panel/60">
          <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Investigate delivery evidence</p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            <Link
              to={logsExplorerPath({ stream_id: scopedId })}
              className="inline-flex min-h-10 items-center text-xs font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
            >
              Inspect Stream delivery logs
            </Link>
            <Link
              to={runtimeAnalyticsPath({ window: '24h', stream_id: scopedId })}
              className="inline-flex min-h-10 items-center text-xs font-semibold text-violet-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-violet-300"
            >
              Inspect Stream delivery trends (24h)
            </Link>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-gdc-muted">
            These are historical delivery records; receiving endpoint ingestion is not verified by these links.
          </p>
        </nav>
      ) : null}
      <p className="text-[11px] text-slate-500 dark:text-gdc-muted">
        Delivery path operational metrics, sync position trace, and retry details are in the Settings tab (Advanced view).
      </p>
    </section>
  )
}
