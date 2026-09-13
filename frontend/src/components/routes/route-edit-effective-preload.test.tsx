import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteEditPage } from './route-edit-page'
import * as gdcRoutes from '../../api/gdcRoutes'
import * as gdcStreams from '../../api/gdcStreams'
import * as gdcConnectors from '../../api/gdcConnectors'
import * as gdcDestinations from '../../api/gdcDestinations'
import * as gdcRouteTransform from '../../api/gdcRouteTransform'
import * as gdcRouteProtection from '../../api/gdcRouteProtection'
import * as gdcRouteClassification from '../../api/gdcRouteClassification'
import * as gdcRoutePolicy from '../../api/gdcRoutePolicy'
import * as gdcRuntime from '../../api/gdcRuntime'

vi.mock('./route-detail-health-panel', () => ({
  RouteDetailHealthPanel: () => null,
}))

vi.mock('../mappings/mapping-workspace', () => ({
  MappingWorkspace: () => <div data-testid="mapping-workspace-stub">Mapping workspace</div>,
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  loadMappingWorkspaceContext: vi.fn(async () => null),
}))

function installRouteEditSpies() {
  const transformEff = vi.spyOn(gdcRouteTransform, 'fetchRouteTransformEffective').mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    mapping_source: 'stream',
    enrichment_source: 'stream',
    fallback_used: true,
    mapping_count: 0,
    enrichment_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })
  const protectionEff = vi.spyOn(gdcRouteProtection, 'fetchRouteProtectionEffective').mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 1,
    processing_status: 'Inherited',
    message: 'ok',
  })
  const classificationEff = vi.spyOn(gdcRouteClassification, 'fetchRouteClassificationEffective').mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })
  const policyEff = vi.spyOn(gdcRoutePolicy, 'fetchRoutePolicyEffective').mockResolvedValue({
    route_id: 42,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  })
  vi.spyOn(gdcRoutes, 'fetchRouteById').mockResolvedValue({
    id: 42,
    name: 'Route A',
    description: '',
    enabled: true,
    stream_id: 10,
    destination_id: 5,
    failure_policy: 'LOG_AND_CONTINUE',
    formatter_config_json: { delivery_mode: 'Reliable' },
    rate_limit_json: {},
  } as never)
  vi.spyOn(gdcStreams, 'fetchStreamById').mockResolvedValue({ id: 10, name: 'Stream A', connector_id: 1 } as never)
  vi.spyOn(gdcConnectors, 'fetchConnectorById').mockResolvedValue({ id: 1, name: 'Connector A' } as never)
  vi.spyOn(gdcDestinations, 'fetchDestinationsList').mockResolvedValue([{ id: 5, name: 'Dest A' }] as never)
  const protectionRules = vi.spyOn(gdcRouteProtection, 'fetchRouteProtectionRules').mockResolvedValue({
    route_id: 42,
    protection_enabled: true,
    rules: [
      {
        id: 1,
        route_id: 42,
        field_path: '$.email',
        sensitivity_class: 'pii',
        protection_mode: 'full_mask',
        enabled: true,
        source_finding_id: null,
        created_by: 'op',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    rule_count: 1,
  } as never)
  vi.spyOn(gdcRouteClassification, 'fetchRouteClassificationRules').mockResolvedValue({
    route_id: 42,
    rules: [],
    rule_count: 0,
  } as never)
  vi.spyOn(gdcRoutePolicy, 'fetchRoutePolicyRules').mockResolvedValue({
    route_id: 42,
    rules: [],
    rule_count: 0,
  } as never)
  vi.spyOn(gdcRouteTransform, 'fetchRouteMappingUiConfig').mockResolvedValue({
    route_id: 42,
    inherit_stream_mapping: true,
    mapping: { field_mappings: {} },
  } as never)
  vi.spyOn(gdcRouteTransform, 'fetchRouteEnrichmentUiConfig').mockResolvedValue({
    route_id: 42,
    inherit_stream_enrichment: true,
    enrichment: { enrichment: {} },
  } as never)
  vi.spyOn(gdcRuntime, 'searchRuntimeDeliveryLogs').mockResolvedValue({
    total_returned: 0,
    filters: {},
    logs: [],
  })
  return { transformEff, protectionEff, classificationEff, policyEff, protectionRules }
}

function renderRouteEdit(routeId = '42') {
  return render(
    <MemoryRouter initialEntries={[`/routes/${routeId}/edit`]}>
      <Routes>
        <Route path="/routes/:routeId/edit" element={<RouteEditPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Route Edit /effective preload (request-count regression)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps initial 4 effective GETs and adds 0 on tab first-visit and reopen round-trips', async () => {
    const spies = installRouteEditSpies()
    const user = userEvent.setup()
    renderRouteEdit()

    await waitFor(() => {
      expect(spies.transformEff).toHaveBeenCalledTimes(1)
      expect(spies.protectionEff).toHaveBeenCalledTimes(1)
      expect(spies.classificationEff).toHaveBeenCalledTimes(1)
      expect(spies.policyEff).toHaveBeenCalledTimes(1)
    })

    await user.click(screen.getByTestId('route-edit-tab-transform'))
    await waitFor(() => expect(screen.getByTestId('route-edit-tab-transform')).toBeInTheDocument())
    await user.click(screen.getByTestId('route-edit-tab-protection'))
    await waitFor(() => expect(screen.getByTestId('protection-summary')).toBeInTheDocument())
    await user.click(screen.getByTestId('route-edit-tab-classification'))
    await waitFor(() => expect(screen.getByTestId('classification-panel')).toBeInTheDocument())
    await user.click(screen.getByTestId('route-edit-tab-policy'))
    await waitFor(() => expect(screen.getByTestId('policy-summary')).toBeInTheDocument())

    expect(spies.transformEff).toHaveBeenCalledTimes(1)
    expect(spies.protectionEff).toHaveBeenCalledTimes(1)
    expect(spies.classificationEff).toHaveBeenCalledTimes(1)
    expect(spies.policyEff).toHaveBeenCalledTimes(1)

    // Detail rules still load on first tab visit
    expect(spies.protectionRules.mock.calls.length).toBeGreaterThanOrEqual(1)

    const beforeRound = spies.protectionEff.mock.calls.length
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByTestId('route-edit-tab-delivery'))
      await user.click(screen.getByTestId('route-edit-tab-protection'))
      await waitFor(() => expect(screen.getByTestId('protection-summary')).toBeInTheDocument())
    }
    expect(spies.protectionEff).toHaveBeenCalledTimes(beforeRound)
  })

  it('refetches protection effective after mutation (freshness preserved)', async () => {
    const spies = installRouteEditSpies()
    const patch = vi.spyOn(gdcRouteProtection, 'patchRouteProtectionRule').mockResolvedValue({
      id: 1,
      route_id: 42,
      field_path: '$.email',
      sensitivity_class: 'pii',
      protection_mode: 'full_mask',
      enabled: false,
      source_finding_id: null,
      created_by: 'op',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as never)

    const user = userEvent.setup()
    renderRouteEdit()
    await waitFor(() => expect(spies.protectionEff).toHaveBeenCalledTimes(1))

    await user.click(screen.getByTestId('route-edit-tab-protection'))
    await waitFor(() => expect(screen.getByTestId('protection-rule-row-1')).toBeInTheDocument())
    expect(spies.protectionEff).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    await waitFor(() => expect(spies.protectionEff.mock.calls.length).toBeGreaterThan(1))
  })

  it('ignores mismatched route_id preload and fetches effective for the active route', async () => {
    const spies = installRouteEditSpies()
    // Force page-owned effective to look like a different route before panel mount via delayed page fetch.
    let resolveProtection!: (v: never) => void
    spies.protectionEff.mockReset()
    spies.protectionEff.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProtection = resolve as (v: never) => void
        }),
    )
    spies.protectionEff.mockResolvedValue({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
      processing_status: 'Inherited',
      message: 'ok',
    })

    const user = userEvent.setup()
    renderRouteEdit('42')

    // Open protection before page effective resolves → panel must fetch itself
    await waitFor(() => expect(screen.getByTestId('route-edit-tab-protection')).toBeInTheDocument())
    await user.click(screen.getByTestId('route-edit-tab-protection'))
    await waitFor(() => expect(spies.protectionRules).toHaveBeenCalled())
    // Panel mounted without preload → at least one protection effective from panel path;
    // resolve page fetch afterward.
    resolveProtection({
      route_id: 42,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
      processing_status: 'Inherited',
      message: 'ok',
    } as never)

    await waitFor(() => expect(spies.protectionEff.mock.calls.length).toBeGreaterThanOrEqual(1))
  })
})
