import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRouteProcessingOverview } from './stream-route-processing-overview'
import { ROUTE_PROCESSING_COPY } from './route-processing/route-processing-labels'

const fetchRoutesList = vi.fn()
const fetchDestinationsList = vi.fn()
const fetchRouteTransformEffective = vi.fn()
const fetchRouteProtectionEffective = vi.fn()
const fetchRouteClassificationEffective = vi.fn()
const fetchRoutePolicyEffective = vi.fn()

vi.mock('../../api/gdcRoutes', () => ({
  fetchRoutesList: (...args: unknown[]) => fetchRoutesList(...args),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

vi.mock('../../api/gdcRouteTransform', () => ({
  fetchRouteMappingUiConfig: vi.fn(async () => ({ inherit_stream_mapping: true, mapping: {} })),
  fetchRouteEnrichmentUiConfig: vi.fn(async () => ({ inherit_stream_enrichment: true, enrichment: {} })),
  fetchRouteTransformEffective: (...args: unknown[]) => fetchRouteTransformEffective(...args),
  saveRouteMappingUiConfig: vi.fn(),
  saveRouteEnrichmentUiConfig: vi.fn(),
}))

vi.mock('../../api/gdcRouteProtection', () => ({
  fetchRouteProtectionEffective: (...args: unknown[]) => fetchRouteProtectionEffective(...args),
  fetchRouteProtectionRules: vi.fn(async () => ({ route_id: 42, stream_id: 10, protection_enabled: true, rules: [], rule_count: 0 })),
  patchRouteProtectionRule: vi.fn(),
}))

vi.mock('../../api/gdcRouteClassification', () => ({
  fetchRouteClassificationEffective: (...args: unknown[]) => fetchRouteClassificationEffective(...args),
  fetchRouteClassificationRules: vi.fn(async () => ({ route_id: 42, stream_id: 10, rules: [], rule_count: 0 })),
  patchRouteClassificationRule: vi.fn(),
}))

vi.mock('../../api/gdcRoutePolicy', () => ({
  fetchRoutePolicyEffective: (...args: unknown[]) => fetchRoutePolicyEffective(...args),
  fetchRoutePolicyRules: vi.fn(async () => ({ route_id: 42, stream_id: 10, rules: [], rule_count: 0 })),
  patchRoutePolicyRule: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', () => ({
  searchRuntimeDeliveryLogs: vi.fn(async () => ({ logs: [] })),
}))

vi.mock('../../utils/mappingSourceSample', () => ({
  loadMappingWorkspaceContext: vi.fn(async () => null),
}))

vi.mock('../mappings/mapping-workspace', () => ({
  MappingWorkspace: () => <div data-testid="mapping-workspace-stub" />,
}))

function mockEffectiveForRoute42() {
  fetchRouteTransformEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    persisted_source: 'stream',
    mapping_source: 'stream',
    enrichment_source: 'stream',
    fallback_used: true,
    mapping_count: 1,
    enrichment_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  }))
  fetchRouteProtectionEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    persisted_source: 'stream',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Inherited',
    message: 'ok',
  }))
  fetchRouteClassificationEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    persisted_source: 'route',
    fallback_used: false,
    rule_count: 1,
    processing_status: 'Overridden',
    message: 'ok',
  }))
  fetchRoutePolicyEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    persisted_source: 'mixed',
    fallback_used: true,
    rule_count: 0,
    processing_status: 'Mixed',
  }))
}

function mockEffectiveAllInherited() {
  const inherited = {
    persisted_source: 'stream',
    fallback_used: true,
    processing_status: 'Inherited' as const,
    message: 'ok',
  }
  fetchRouteTransformEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    mapping_source: 'stream',
    enrichment_source: 'stream',
    mapping_count: 1,
    enrichment_count: 0,
    ...inherited,
  }))
  fetchRouteProtectionEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    rule_count: 0,
    ...inherited,
  }))
  fetchRouteClassificationEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    rule_count: 0,
    ...inherited,
  }))
  fetchRoutePolicyEffective.mockImplementation(async (id: number) => ({
    route_id: id,
    stream_id: 10,
    rule_count: 0,
    ...inherited,
  }))
}

describe('StreamRouteProcessingOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchRoutesList.mockResolvedValue([
      { id: 42, name: 'Route A', stream_id: 10, destination_id: 5, enabled: true },
      { id: 43, name: 'Route B', stream_id: 10, destination_id: 6, enabled: true },
      { id: 99, name: 'Other stream', stream_id: 20, destination_id: 5, enabled: true },
    ])
    fetchDestinationsList.mockResolvedValue([
      { id: 5, name: 'Dest A' },
      { id: 6, name: 'Dest B' },
    ])
    mockEffectiveForRoute42()
    fetchRouteTransformEffective.mockImplementation(async (id: number) => {
      if (id === 43) {
        return {
          route_id: id,
          stream_id: 10,
          persisted_source: 'stream',
          mapping_source: 'stream',
          enrichment_source: 'stream',
          fallback_used: true,
          mapping_count: 0,
          enrichment_count: 0,
          processing_status: 'Inherited',
          message: 'ok',
        }
      }
      return {
        route_id: id,
        stream_id: 10,
        persisted_source: 'stream',
        mapping_source: 'stream',
        enrichment_source: 'stream',
        fallback_used: true,
        mapping_count: 1,
        enrichment_count: 0,
        processing_status: 'Inherited',
        message: 'ok',
      }
    })
    fetchRouteProtectionEffective.mockImplementation(async (id: number) => ({
      route_id: id,
      stream_id: 10,
      persisted_source: 'stream',
      fallback_used: true,
      rule_count: 0,
      processing_status: 'Inherited',
      message: 'ok',
    }))
    fetchRouteClassificationEffective.mockImplementation(async (id: number) => {
      if (id === 42) {
        return {
          route_id: id,
          stream_id: 10,
          persisted_source: 'route',
          fallback_used: false,
          rule_count: 1,
          processing_status: 'Overridden',
          message: 'ok',
        }
      }
      return {
        route_id: id,
        stream_id: 10,
        persisted_source: 'stream',
        fallback_used: true,
        rule_count: 0,
        processing_status: 'Inherited',
        message: 'ok',
      }
    })
    fetchRoutePolicyEffective.mockImplementation(async (id: number) => {
      if (id === 42) {
        return {
          route_id: id,
          stream_id: 10,
          persisted_source: 'mixed',
          fallback_used: true,
          rule_count: 0,
          processing_status: 'Mixed',
        }
      }
      return {
        route_id: id,
        stream_id: 10,
        persisted_source: 'stream',
        fallback_used: true,
        rule_count: 0,
        processing_status: 'Inherited',
      }
    })
  })

  it('renders shared processing, routes table, and route detail with override workspace', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('route-processing-overview')).toBeInTheDocument()
    expect(screen.getByTestId('stream-shared-processing-section')).toBeInTheDocument()
    expect(screen.queryByText('Global Processing')).not.toBeInTheDocument()
    expect(await screen.findByTestId('route-processing-row-42')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-row-43')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-row-99')).not.toBeInTheDocument()
    expect(screen.getByTestId('route-processing-mode-override')).toHaveAttribute('aria-checked', 'true')
    expect(await screen.findByTestId('route-processing-transform-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-open-route-edit')).toBeInTheDocument()
  })

  it('loads effective processing status for routes', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(fetchRouteTransformEffective).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(fetchRouteClassificationEffective).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(fetchRoutePolicyEffective).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    const row42 = await screen.findByTestId('route-processing-row-42')
    expect(within(row42).getByText('Override')).toBeInTheDocument()
    expect(within(row42).getByText('Mixed')).toBeInTheDocument()
    expect(within(row42).getAllByText('Shared').length).toBeGreaterThan(0)
    expect(within(row42).getByText('Selected')).toBeInTheDocument()
    expect(screen.getByTestId('route-header-processing-statuses')).toBeInTheDocument()
    expect(screen.getByTestId('route-detail-destination')).toHaveTextContent('Destination: Dest A')
  })

  it('shows shared mode and delivery-only tabs when all concerns are inherited', async () => {
    mockEffectiveAllInherited()
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.getByTestId('stream-route-shared-mode-summary')).toHaveTextContent(ROUTE_PROCESSING_COPY.routeUsesShared)
    expect(screen.queryByTestId('stream-route-detail-tab-transform')).not.toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-delivery')).toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-transform-section')).not.toBeInTheDocument()
  })

  it('shows override concern tabs when route has overrides', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    // Wait for effective-status hydration before changing tabs. The transform workspace
    // is visible during the initial load and is not a readiness signal.
    await waitFor(() => {
      expect(screen.getByTestId('route-header-row-classification')).toHaveTextContent('Classification: Override')
      expect(screen.getByTestId('route-header-row-policy')).toHaveTextContent('Policy: Mixed')
    })
    fireEvent.click(screen.getByTestId('stream-route-detail-tab-data_protection'))
    expect(await screen.findByTestId('route-processing-data-protection-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-protection-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-classification-section')).toBeInTheDocument()
    expect(screen.getByTestId('route-processing-policy-section')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-route-inherit-classification')).not.toBeInTheDocument()
  })

  it('retains a selected protection tab after late route-effective hydration', async () => {
    let finishPolicy: () => void = () => {}
    const pendingPolicy = new Promise<void>((resolve) => { finishPolicy = resolve })
    fetchRoutePolicyEffective.mockImplementation(async (id: number) => {
      await pendingPolicy
      return {
        route_id: id,
        stream_id: 10,
        persisted_source: id === 42 ? 'mixed' : 'stream',
        fallback_used: true,
        rule_count: 0,
        processing_status: id === 42 ? 'Mixed' : 'Inherited',
      }
    })

    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('stream-route-detail-tab-data_protection'))
    expect(await screen.findByTestId('route-processing-data-protection-section')).toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-data_protection')).toHaveAttribute('aria-selected', 'true')

    finishPolicy()
    await waitFor(() => {
      expect(screen.getByTestId('route-header-row-policy')).toHaveTextContent('Policy: Mixed')
      expect(screen.getByTestId('stream-route-detail-tab-data_protection')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('route-processing-data-protection-section')).toBeInTheDocument()
    })
  })

  it('switches to shared mode workspace when selecting an all-inherited route', async () => {
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('route-processing-row-43'))
    await waitFor(() => {
      expect(screen.getByTestId('route-processing-mode-shared')).toHaveAttribute('aria-checked', 'true')
    })
    expect(screen.queryByTestId('route-processing-transform-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('stream-route-detail-tab-delivery')).toBeInTheDocument()
  })

  it('shows Unavailable in route list when effective API fails for a concern', async () => {
    fetchRouteTransformEffective.mockRejectedValue(new Error('network error'))
    render(
      <MemoryRouter>
        <StreamRouteProcessingOverview streamId={10} />
      </MemoryRouter>,
    )
    const row42 = await screen.findByTestId('route-processing-row-42')
    await waitFor(() => {
      expect(within(row42).getAllByText('Unavailable').length).toBeGreaterThan(0)
    })
    const transformCells = within(row42).getAllByTestId('route-processing-status-unavailable')
    expect(transformCells.length).toBeGreaterThanOrEqual(1)
  })
})
