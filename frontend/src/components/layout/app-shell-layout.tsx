import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { AppShell } from '../shell/app-shell'
import { Sidebar } from './sidebar'
import { TopHeader } from './top-header'
import { PAGE_TITLE, sidebarStructureForRole } from '../../config/app-navigation'
import { useIsMdUp } from '../../hooks/use-media-query'
import { usePersonaMode } from '../../hooks/use-persona-mode'
import { useGovernanceCapabilities } from '../../lib/governance-rbac'
import { NAV_PATH, appNavKeyFromPathname } from '../../config/nav-paths'
import { useShellRouteLabels } from '../../hooks/use-shell-route-labels'
import { useStreamSourceTypeForApiTestShell } from '../../hooks/use-stream-source-type-for-api-test-shell'
import { formatStreamLabel } from '../../utils/entityLabels'
import { resolveStreamSourceTestShellTitle } from '../../utils/sourceTypePresentation'
import { loadColorScheme, persistColorScheme, STORAGE_KEYS } from '../../localPreferences'
import { RouteErrorBoundary } from './route-error-boundary'

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section
      role="region"
      aria-label={`${title} workspace`}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card dark:ring-1 dark:ring-[rgba(120,150,220,0.07)]"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Workspace</p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-gdc-muted">
        This workspace placeholder will be replaced as screens migrate into the App Shell. Layout, navigation, and dashboard foundations are applied.
      </p>
    </section>
  )
}

function NotFoundPage() {
  return (
    <section
      role="region"
      aria-label="Page not found"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-gdc-border dark:bg-gdc-card dark:shadow-gdc-card dark:ring-1 dark:ring-[rgba(120,150,220,0.07)]"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gdc-muted">Error</p>
      <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">Page not found</h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-gdc-muted">
        The URL you opened does not match a known page. Use the sidebar to continue, or return to Streams.
      </p>
      <p className="mt-4">
        <Link
          to={NAV_PATH.streams}
          className="text-sm font-semibold text-violet-700 hover:underline dark:text-violet-300"
        >
          Go to Streams
        </Link>
      </p>
    </section>
  )
}

export function AppShellLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const isMdUp = useIsMdUp()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [isDark, setIsDark] = useState(() => loadColorScheme() === 'dark')

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEYS.colorScheme || e.newValue == null) return
      setIsDark(e.newValue === 'dark')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (isMdUp) setMobileNavOpen(false)
  }, [isMdUp])

  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!mobileNavOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileNavOpen])

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev
      persistColorScheme(next ? 'dark' : 'light')
      return next
    })
  }, [])

  const { persona, setPersona } = usePersonaMode()
  const govCaps = useGovernanceCapabilities()
  const sidebarStructure = useMemo(
    () => sidebarStructureForRole(govCaps.governance_read === true),
    [govCaps.governance_read],
  )

  const activeNav = useMemo(() => appNavKeyFromPathname(location.pathname), [location.pathname])

  const newStreamMatch = useMatch({ path: '/streams/new', end: true })
  const streamEditMatch = useMatch({ path: '/streams/:streamId/edit', end: true })
  const apiTestMatch = useMatch({ path: '/streams/:streamId/api-test', end: true })
  const enrichmentMatch = useMatch({ path: '/streams/:streamId/enrichment', end: true })
  const runtimeMatch = useMatch({ path: '/streams/:streamId/runtime', end: true })
  const mappingMatch = useMatch({ path: '/streams/:streamId/mapping', end: true })
  const routeEditMatch = useMatch({ path: '/routes/:routeId/edit', end: true })
  const mappingEditMatch = useMatch({ path: '/mappings/:mappingId/edit', end: true })
  const logsStreamMatch = useMatch({ path: '/logs/:streamId', end: true })
  const connectorMatch = useMatch({ path: '/connectors/:connectorId', end: true })
  const destinationMatch = useMatch({ path: '/destinations/:destinationId', end: true })
  const shellStreamId =
    runtimeMatch?.params.streamId ??
    mappingMatch?.params.streamId ??
    apiTestMatch?.params.streamId ??
    enrichmentMatch?.params.streamId ??
    streamEditMatch?.params.streamId ??
    logsStreamMatch?.params.streamId
  const shellLabels = useShellRouteLabels({
    streamId: shellStreamId,
    connectorId: connectorMatch?.params.connectorId,
    destinationId:
      destinationMatch?.params.destinationId && destinationMatch.params.destinationId !== 'new'
        ? destinationMatch.params.destinationId
        : undefined,
    routeId: routeEditMatch?.params.routeId,
    mappingEditId: mappingEditMatch?.params.mappingId,
  })
  const apiTestStreamId = apiTestMatch?.params.streamId
  const apiTestShellSourceType = useStreamSourceTypeForApiTestShell(apiTestStreamId)
  const apiTestShellTitle = useMemo(
    () => resolveStreamSourceTestShellTitle(apiTestStreamId, apiTestShellSourceType),
    [apiTestStreamId, apiTestShellSourceType],
  )
  const streamLabel = useMemo(
    () => formatStreamLabel(shellStreamId ?? '', shellLabels.stream?.name),
    [shellStreamId, shellLabels.stream?.name],
  )

  const breadcrumb = useMemo(() => {
    if (newStreamMatch) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">New Stream</span>
        </nav>
      )
    }
    if (apiTestMatch && apiTestMatch.params.streamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">{streamLabel}</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">{apiTestShellTitle}</span>
        </nav>
      )
    }
    if (enrichmentMatch && enrichmentMatch.params.streamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">{streamLabel}</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Enrichment</span>
        </nav>
      )
    }
    if (runtimeMatch && shellStreamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">
            {streamLabel} ({shellStreamId})
          </span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Monitoring</span>
        </nav>
      )
    }
    if (mappingMatch && shellStreamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">
            {streamLabel} ({shellStreamId})
          </span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Mapping</span>
        </nav>
      )
    }
    if (streamEditMatch?.params.streamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.streams} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Streams
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">{streamLabel}</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Edit</span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/monitoring/topology') || location.pathname.startsWith('/runtime/topology')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.dashboard} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Dashboard
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Topology</span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/monitoring/analytics') || location.pathname.startsWith('/runtime/analytics')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.dashboard} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Dashboard
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Delivery Analytics</span>
        </nav>
      )
    }
    if (location.pathname === '/monitoring/streams' || location.pathname === '/runtime') {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.dashboard} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Dashboard
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Stream monitoring</span>
        </nav>
      )
    }
    if (location.pathname === '/monitoring') {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <span className="font-semibold text-slate-800 dark:text-slate-200">Dashboard</span>
        </nav>
      )
    }
    if (location.pathname === '/admin') {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <span className="font-semibold text-slate-800 dark:text-slate-200">Administration</span>
        </nav>
      )
    }
    if (location.pathname === '/settings' || location.pathname.startsWith('/settings/')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.administration} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Administration
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {location.pathname.startsWith('/settings/audit-logs') ? 'Audit logs' : 'Settings'}
          </span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/governance/data-protection')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.governance} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Governance
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Data Protection</span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/governance/violations')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.governance} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Governance
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Violation Center</span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/governance/quarantine')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.governance} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Governance
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Quarantine</span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/governance/replay')) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.governance} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Governance
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Replay</span>
        </nav>
      )
    }
    if (routeEditMatch?.params.routeId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Delivery</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <Link to={NAV_PATH.routes} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Routes
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">
            {shellLabels.route?.name ?? routeEditMatch.params.routeId}
          </span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Edit</span>
        </nav>
      )
    }
    if (mappingEditMatch?.params.mappingId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.mappings} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Mappings
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">
            {shellLabels.mappingEdit?.name ?? mappingEditMatch.params.mappingId}
          </span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">Edit</span>
        </nav>
      )
    }
    if (logsStreamMatch?.params.streamId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.logs} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Logs
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">{streamLabel}</span>
        </nav>
      )
    }
    if (connectorMatch?.params.connectorId) {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Data Sources</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <Link to={NAV_PATH.connectors} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Connectors
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {shellLabels.connector?.name ?? connectorMatch.params.connectorId}
          </span>
        </nav>
      )
    }
    if (destinationMatch?.params.destinationId && destinationMatch.params.destinationId !== 'new') {
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <span className="font-medium text-slate-600 dark:text-gdc-mutedStrong">Delivery</span>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <Link to={NAV_PATH.destinations} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Destinations
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          <span className="font-semibold text-slate-800 dark:text-slate-200">
            {shellLabels.destination?.name ?? destinationMatch.params.destinationId}
          </span>
        </nav>
      )
    }
    if (location.pathname.startsWith('/validation')) {
      const rest = location.pathname.replace(/^\/validation\/?/, '')
      const seg = (rest.split('/')[0] || '').trim()
      const label =
        seg === 'alerts'
          ? 'Alerts'
          : seg === 'runs'
            ? 'Runs'
            : seg === 'failing'
              ? 'Failing'
              : seg === 'auth'
                ? 'Auth'
                : seg === 'delivery'
                  ? 'Delivery'
                  : seg === 'checkpoints'
                    ? 'Checkpoints'
                    : 'Overview'
      const healthChecksLabel = PAGE_TITLE.validation
      return (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Breadcrumb">
          <Link to={NAV_PATH.administration} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
            Administration
          </Link>
          <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
            /
          </span>
          {label !== 'Overview' ? (
            <>
              <Link to={NAV_PATH.validation} className="font-medium text-violet-700 hover:underline dark:text-violet-300">
                {healthChecksLabel}
              </Link>
              <span className="text-slate-400 dark:text-gdc-muted" aria-hidden>
                /
              </span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{label}</span>
            </>
          ) : (
            <span className="font-semibold text-slate-800 dark:text-slate-200">{healthChecksLabel}</span>
          )}
        </nav>
      )
    }
    return undefined
  }, [
    newStreamMatch,
    streamEditMatch,
    apiTestMatch,
    apiTestShellTitle,
    enrichmentMatch,
    runtimeMatch,
    shellStreamId,
    streamLabel,
    mappingMatch,
    routeEditMatch,
    shellLabels.route?.name,
    mappingEditMatch,
    shellLabels.mappingEdit?.name,
    logsStreamMatch,
    connectorMatch,
    shellLabels.connector?.name,
    destinationMatch,
    shellLabels.destination?.name,
    location.pathname,
  ])

  const headerTitle = location.pathname.startsWith('/validation')
    ? PAGE_TITLE.validation
    : newStreamMatch
        ? 'Stream Creation Wizard'
        : streamEditMatch
          ? 'Edit Stream'
          : apiTestMatch
            ? apiTestShellTitle
            : enrichmentMatch
              ? 'Enrichment Configuration'
              : runtimeMatch
                ? 'Stream monitoring'
                : mappingMatch
                  ? 'Mapping'
                  : routeEditMatch?.params.routeId
                    ? shellLabels.route?.name ?? 'Edit route'
                    : mappingEditMatch?.params.mappingId
                      ? shellLabels.mappingEdit?.name ?? 'Edit mapping'
                      : destinationMatch?.params.destinationId
                        ? shellLabels.destination?.name ?? PAGE_TITLE.destinations
                        : connectorMatch?.params.connectorId
                          ? shellLabels.connector?.name ?? PAGE_TITLE.connectors
                          : PAGE_TITLE[activeNav]

  useEffect(() => {
    document.title = `${headerTitle} · DataRelay`
  }, [headerTitle])

  const entityStatus = shellLabels.stream?.status ?? shellLabels.connector?.status
  const runtimeHealthy = (
    location.pathname.startsWith('/validation') ||
    newStreamMatch ||
    streamEditMatch ||
    apiTestMatch ||
    enrichmentMatch ||
    routeEditMatch ||
    mappingEditMatch ||
    logsStreamMatch ||
    destinationMatch
  )
    ? true
    : entityStatus
      ? entityStatus.toUpperCase() === 'RUNNING'
      : activeNav !== 'logs'
  const runtimeSummary = location.pathname.startsWith('/validation')
    ? 'Runtime verification runs on live configuration; use alongside stream runtime, logs, and delivery health.'
    : newStreamMatch
      ? 'Draft stream wizard — configuration is not applied to runtime until the stream is saved and enabled.'
      : streamEditMatch
        ? /^\d+$/.test(streamEditMatch.params.streamId ?? '')
          ? 'Edit stream configuration — loads saved stream from the API.'
          : 'Edit stream configuration — use a numeric stream id for full API-backed editing.'
        : apiTestMatch
          ? /^\d+$/.test(apiTestMatch.params.streamId ?? '')
            ? 'Source test and preview — stream and connector context from the API.'
            : 'Source test and preview — numeric stream id recommended for API-backed context.'
          : enrichmentMatch
            ? 'Enrichment rules for this stream — saved with the mapping workspace.'
            : routeEditMatch?.params.routeId
              ? 'Edit route delivery policy, formatter, and rate limits.'
              : mappingEditMatch?.params.mappingId
                ? 'Edit field mappings for the selected stream.'
                : logsStreamMatch
                  ? 'Delivery logs scoped to this stream.'
                  : destinationMatch?.params.destinationId
                    ? shellLabels.loading
                      ? 'Loading destination context…'
                      : `Destination · ${shellLabels.destination?.name ?? destinationMatch.params.destinationId}`
                    : connectorMatch?.params.connectorId
                      ? shellLabels.loading
                        ? 'Loading connector context…'
                        : `Connector · ${shellLabels.connector?.name ?? connectorMatch.params.connectorId}${
                            entityStatus ? ` · ${entityStatus}` : ''
                          }`
                      : mappingMatch && shellStreamId
                        ? `Mapping workspace · ${streamLabel}`
                        : runtimeMatch && shellStreamId
                          ? `Stream monitoring · ${streamLabel}${entityStatus ? ` · ${entityStatus}` : ''}`
                          : 'Operational overview — streams, routes, and delivery health from live APIs.'

  const rootClassName = useMemo(
    () =>
      [
        isDark ? 'dark bg-gdc-page' : 'bg-slate-100',
        'min-h-screen text-slate-950 transition-colors dark:text-slate-100',
      ].join(' '),
    [isDark],
  )

  return (
    <main className={rootClassName}>
      <AppShell
        mobileNavOpen={mobileNavOpen}
        onMobileNavClose={() => setMobileNavOpen(false)}
        sidebar={
          <Sidebar
            structure={sidebarStructure}
            collapsed={isMdUp ? collapsed : false}
            mobileOpen={mobileNavOpen}
            pathname={location.pathname}
            persona={persona}
            onPersonaChange={setPersona}
            onToggleCollapsed={() => setCollapsed((prev) => !prev)}
            onNavigate={(path) => navigate(path)}
            onMobileClose={() => setMobileNavOpen(false)}
          />
        }
        header={
          <TopHeader
            title={headerTitle}
            breadcrumb={breadcrumb}
            runtimeSummary={runtimeSummary}
            runtimeHealthy={runtimeHealthy}
            isDark={isDark}
            onToggleTheme={toggleTheme}
            mobileNavOpen={mobileNavOpen}
            onMobileNavToggle={() => setMobileNavOpen((prev) => !prev)}
          />
        }
      >
        <div className="w-full min-w-0 p-3 md:p-5 lg:p-6">
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </div>
      </AppShell>
    </main>
  )
}

export { PlaceholderPage, NotFoundPage }
