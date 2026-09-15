import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StepDelivery } from './step-delivery'
import { buildInitialState } from './wizard-state'

const fetchDestinationsList = vi.hoisted(() =>
  vi.fn(async () => [
    {
      id: 1,
      name: 'Stellar Syslog',
      destination_type: 'SYSLOG_UDP',
      config_json: { host: '10.0.0.1', port: 514 },
      rate_limit_json: {},
      enabled: true,
      streams_using_count: 0,
      routes: [],
    },
    {
      id: 2,
      name: 'Backup Webhook',
      destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://hook.example.com' },
      rate_limit_json: {},
      enabled: true,
      streams_using_count: 0,
      routes: [],
    },
  ]),
)

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

describe('StepDelivery', () => {

  beforeEach(() => {
    fetchDestinationsList.mockReset()
    fetchDestinationsList.mockResolvedValue([
      {
        id: 1,
        name: 'Stellar Syslog',
        destination_type: 'SYSLOG_UDP',
        config_json: { host: '10.0.0.1', port: 514 },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 0,
        routes: [],
      },
      {
        id: 2,
        name: 'Backup Webhook',
        destination_type: 'WEBHOOK_POST',
        config_json: { url: 'https://hook.example.com' },
        rate_limit_json: {},
        enabled: true,
        streams_using_count: 0,
        routes: [],
      },
    ])
  })

  it('does not crash when destination list API returns null (failure != empty)', async () => {
    fetchDestinationsList.mockResolvedValueOnce(null)
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'keep-me',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'RETRY_AND_BACKOFF',
        rateLimitJson: {},
      },
    ]
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={onChange} />
      </MemoryRouter>,
    )

    expect(
      await screen.findByText(/Failed to load destinations/i),
    ).toBeInTheDocument()
    expect(screen.queryByText('No destinations configured yet')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationApiBacked: false,
        }),
      )
    })
    // Must not wipe existing drafts on transport failure.
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({
        routeDrafts: [],
      }),
    )
  })

  it('treats a successful empty destination list as empty catalog, not failure', async () => {
    fetchDestinationsList.mockResolvedValueOnce([])
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No destinations configured yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load destinations/i)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationApiBacked: true,
          routeDrafts: [],
        }),
      )
    })
  })
  it('loads real destinations from API and shows operational destinations copy', async () => {
    const state = buildInitialState()
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={onChange} />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Stellar Syslog')).toBeInTheDocument()
    expect(screen.getByText('Backup Webhook')).toBeInTheDocument()
    expect(
      screen.getByText(/Select where final events will be delivered/i),
    ).toBeInTheDocument()

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationApiBacked: true,
        }),
      )
    })
  })

  it('does not expose route delivery tuning controls', async () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      {
        key: 'r1',
        destinationId: 1,
        enabled: true,
        failurePolicy: 'RETRY_AND_BACKOFF',
        rateLimitJson: {},
      },
    ]
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={vi.fn()} />
      </MemoryRouter>,
    )

    await screen.findByTestId('destination-route-card-r1')
    expect(screen.queryByText('Delivery path settings')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-enabled-r1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('route-processing-failure-policy-r1')).not.toBeInTheDocument()
  })
})
