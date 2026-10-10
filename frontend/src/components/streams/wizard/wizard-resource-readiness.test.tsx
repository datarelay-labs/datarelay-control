import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCatalogSnapshot } from '../../../api/gdcCatalog'
import { fetchDestinationsList, invalidateDestinationsListCache } from '../../../api/gdcDestinations'
import { WizardResourceReadiness } from './wizard-resource-readiness'
import { summarizeResourceReadiness } from './wizard-resource-readiness-model'

vi.mock('../../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(),
}))
vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(),
  invalidateDestinationsListCache: vi.fn(),
}))

const catalog = (sourceCount: number, connectorCount: number, apiBacked = true) => ({
  apiBacked,
  connectors: Array.from({ length: connectorCount }, (_, i) => ({
    id: i + 1,
    name: `Connector ${i + 1}`,
    status: 'STOPPED',
    description: null,
    source_count: sourceCount,
    stream_count: 0,
  })),
  sources: Array.from({ length: sourceCount }, (_, i) => ({
    id: i + 1,
    connector_id: 1,
    source_type: 'HTTP_API_POLLING',
    enabled: true,
    display_name: `Source ${i + 1}`,
    stream_count: 0,
  })),
})
const destination = (enabled: boolean) => ({
  id: 5,
  name: 'SIEM',
  destination_type: 'WEBHOOK_POST' as const,
  enabled,
  config_json: {},
  rate_limit_json: {},
  streams_using_count: 0,
  routes: [],
})

describe('Wizard first-run resource readiness', () => {
  beforeEach(() => {
    vi.mocked(fetchCatalogSnapshot).mockReset().mockResolvedValue(catalog(1, 1))
    vi.mocked(fetchDestinationsList).mockReset().mockResolvedValue([destination(true)])
    vi.mocked(invalidateDestinationsListCache).mockClear()
  })

  it('shows real reusable configuration counts without claiming end-to-end delivery', async () => {
    render(<WizardResourceReadiness />)
    expect(await within(screen.getByTestId('wizard-source-readiness')).findByText(/1 saved Connector/)).toBeInTheDocument()
    expect(within(screen.getByTestId('wizard-destination-readiness')).getByText(/1 enabled Destination/)).toBeInTheDocument()
    expect(screen.getByTestId('wizard-resource-readiness')).toHaveTextContent('Configuration does not prove a working connection')
    expect(screen.queryByText(/Successfully delivered|Runtime healthy/)).not.toBeInTheDocument()
  })

  it('distinguishes genuinely empty lists from unavailable API results', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue(catalog(0, 0))
    vi.mocked(fetchDestinationsList).mockResolvedValue([])
    render(<WizardResourceReadiness />)
    expect(await screen.findByText('No saved Connectors. Add one during Connect.')).toBeInTheDocument()
    expect(screen.getByText('No saved Destinations. You will need one before Route Processing.')).toBeInTheDocument()
    expect(screen.getAllByText('Needs setup')).toHaveLength(2)
  })

  it('does not treat partial source failure or destination API denial as zero configured resources', async () => {
    vi.mocked(fetchCatalogSnapshot).mockResolvedValue(catalog(0, 4, false))
    vi.mocked(fetchDestinationsList).mockResolvedValue(null)
    render(<WizardResourceReadiness />)
    await waitFor(() => expect(screen.getAllByText('Not verified')).toHaveLength(2))
    expect(screen.queryByText(/No saved Connectors/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No saved Destinations/)).not.toBeInTheDocument()
  })

  it('handles one failed call without discarding the other verified catalog', async () => {
    vi.mocked(fetchCatalogSnapshot).mockRejectedValue(new Error('connector timeout'))
    vi.mocked(fetchDestinationsList).mockResolvedValue([destination(true)])
    render(<WizardResourceReadiness />)
    expect(await within(screen.getByTestId('wizard-source-readiness')).findByText('Not verified')).toBeInTheDocument()
    expect(within(screen.getByTestId('wizard-destination-readiness')).getByText('Configured')).toBeInTheDocument()
  })

  it('shows disabled-only receivers as setup needed rather than selectable', async () => {
    vi.mocked(fetchDestinationsList).mockResolvedValue([destination(false)])
    render(<WizardResourceReadiness />)
    expect(await screen.findByText(/1 saved Destination, none enabled/)).toBeInTheDocument()
    expect(within(screen.getByTestId('wizard-destination-readiness')).getByText('Needs setup')).toBeInTheDocument()
  })

  it('allows in-place recheck without creating a Stream or changing draft state', async () => {
    vi.mocked(fetchDestinationsList).mockResolvedValueOnce(null).mockResolvedValueOnce([destination(true)])
    render(<WizardResourceReadiness />)
    expect(await within(screen.getByTestId('wizard-destination-readiness')).findByText('Not verified')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('wizard-recheck-resources'))
    await waitFor(() => expect(within(screen.getByTestId('wizard-destination-readiness')).getByText('Configured')).toBeInTheDocument())
    expect(invalidateDestinationsListCache).toHaveBeenCalledTimes(1)
    expect(fetchDestinationsList).toHaveBeenCalledTimes(2)
  })

  it('does not mark disabled or orphan Sources as available to the Wizard', () => {
    const disabled = catalog(1, 1)
    disabled.sources[0]!.enabled = false
    expect(summarizeResourceReadiness(disabled, [destination(true)]).source).toMatchObject({
      state: 'needs-setup',
    })
    const orphan = catalog(1, 1)
    orphan.sources[0]!.connector_id = 77
    expect(summarizeResourceReadiness(orphan, [destination(true)]).source).toMatchObject({
      state: 'needs-setup',
    })
  })

  it('does not claim a usable Source when catalog identities cannot pass Wizard ID validation', () => {
    const invalidConnector = catalog(1, 1)
    invalidConnector.connectors[0]!.id = 0
    invalidConnector.sources[0]!.connector_id = 0
    expect(summarizeResourceReadiness(invalidConnector, [destination(true)]).source).toMatchObject({
      state: 'not-verified',
    })

    const invalidSource = catalog(1, 1)
    invalidSource.sources[0]!.id = Number.MAX_SAFE_INTEGER + 1
    expect(summarizeResourceReadiness(invalidSource, [destination(true)]).source).toMatchObject({
      state: 'not-verified',
    })
  })

  it('only counts Destinations with selectable positive safe integer IDs', () => {
    const invalid = { ...destination(true), id: 0 }
    expect(summarizeResourceReadiness(catalog(1, 1), [invalid]).destination).toMatchObject({
      state: 'not-verified',
    })
    const mixed = [destination(true), { ...destination(true), id: Number.NaN }]
    expect(summarizeResourceReadiness(catalog(1, 1), mixed).destination).toMatchObject({
      state: 'available',
      description: '1 enabled Destination available for selection. Delivery is not yet verified.',
    })
  })

  it('classifies saved Connector without Source as still requiring setup', () => {
    expect(summarizeResourceReadiness(catalog(0, 2), [destination(true)]).source).toMatchObject({
      state: 'needs-setup',
    })
  })
})
