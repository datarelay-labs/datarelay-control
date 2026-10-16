import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
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

const invalidateDestinationsListCache = vi.hoisted(() => vi.fn())
const testDestination = vi.hoisted(() => vi.fn())
const createDestination = vi.hoisted(() => vi.fn())
const sendDestinationTestEvents = vi.hoisted(() => vi.fn())

vi.mock('../../../api/gdcDestinations', () => ({
  createDestination: (...args: unknown[]) => createDestination(...args),
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
  invalidateDestinationsListCache: () => invalidateDestinationsListCache(),
  sendDestinationTestEvents: (...args: unknown[]) => sendDestinationTestEvents(...args),
  testDestination: (...args: unknown[]) => testDestination(...args),
}))

function WizardDestinationReturnStateProbe() {
  const location = useLocation()
  return <output data-testid="destination-return-state">{String((location.state as { returnToSavedWizardDraft?: boolean } | null)?.returnToSavedWizardDraft)}</output>
}

describe('StepDelivery', () => {

  beforeEach(() => {
    invalidateDestinationsListCache.mockClear()
    createDestination.mockReset()
    testDestination.mockReset()
    testDestination.mockResolvedValue({ success: true, message: 'Endpoint responded', latency_ms: 12.4, tested_at: '2026-10-09T07:00:00Z' })
    sendDestinationTestEvents.mockReset()
    sendDestinationTestEvents.mockResolvedValue({
      success: true,
      destination_id: 1,
      destination_name: 'Stellar Syslog',
      destination_type: 'SYSLOG_UDP',
      target: '10.0.0.1:514',
      transport_format: 'SYSLOG_UDP / json',
      logical_event_count: 10,
      test_delivery_id: 'td-default',
      tested_at: '2026-10-14T07:00:00Z',
      message: 'Sent 10 synthetic logical test events.',
    })
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

  it('offers in-context recovery after a destination catalog failure without dropping configured paths', async () => {
    fetchDestinationsList.mockResolvedValueOnce(null)
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'keep-retry-path',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={onChange} />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Failed to load destinations/i)).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry loading destinations' })
    await userEvent.setup().click(retry)
    expect((await screen.findAllByText('Stellar Syslog')).length).toBeGreaterThan(0)
    expect(fetchDestinationsList).toHaveBeenCalledTimes(2)
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: [] }))
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
    expect(screen.getAllByRole('button', { name: 'Create destination here' })).toHaveLength(1)
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

  it('keeps destination selection focused on one primary path instead of duplicate add cards', async () => {
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={vi.fn()} />
      </MemoryRouter>,
    )

    await screen.findByText('Stellar Syslog')
    expect(screen.getAllByRole('button', { name: 'Create destination here' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Add delivery path' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Open destination library' })).toBeInTheDocument()
    expect(screen.queryByText(/Add another delivery path for this stream/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Delivery concepts')).not.toBeInTheDocument()
  })

  it('renders a true read-only destination surface without mutation or validation affordances', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'read-only-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]

    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={vi.fn()} readOnly canValidate={false} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('wizard-destination-access-note')).toHaveTextContent(/Read-only access/i)
    await screen.findAllByText('Stellar Syslog')
    expect(screen.queryByRole('button', { name: 'Create destination here' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add delivery path' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reset delivery paths/i })).not.toBeInTheDocument()

    const prefixTemplate = document.querySelector('textarea')
    expect(prefixTemplate).toBeDisabled()

    const card = screen.getByTestId('destination-route-card-read-only-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    expect(within(card).queryByRole('menuitem', { name: 'Duplicate route' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('menuitem', { name: 'Remove route' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('menuitem', { name: 'Test destination' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('menuitem', { name: 'Send test events…' })).not.toBeInTheDocument()
    expect(within(card).getByRole('menuitem', { name: 'Open destination' })).toBeInTheDocument()
  })

  it('keeps workspace edits but hides destination validation when validation capability is absent', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'no-validation-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]

    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={vi.fn()} canValidate={false} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('wizard-destination-access-note')).toHaveTextContent(/validation actions are unavailable/i)
    await screen.findAllByText('Stellar Syslog')
    expect(screen.getByRole('button', { name: 'Create destination here' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add delivery path' })).toHaveLength(1)

    const card = screen.getByTestId('destination-route-card-no-validation-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    expect(within(card).getByRole('menuitem', { name: 'Duplicate route' })).toBeInTheDocument()
    expect(within(card).getByRole('menuitem', { name: 'Remove route' })).toBeInTheDocument()
    expect(within(card).queryByRole('menuitem', { name: 'Test destination' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('menuitem', { name: 'Send test events…' })).not.toBeInTheDocument()
  })

  it('supports Arrow/Home/End menu navigation and returns focus on Escape', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'keyboard-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)

    const card = await screen.findByTestId('destination-route-card-keyboard-route')
    const trigger = within(card).getByRole('button', { name: 'Actions for Stellar Syslog' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')

    const menu = within(card).getByRole('menu', { name: 'Actions for Stellar Syslog' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items[0]).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(items[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(items[items.length - 1]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(items[0]).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(within(card).queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('shows the destination connectivity check result without claiming Stream delivery', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'probe-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    const onChange = vi.fn()
    render(<MemoryRouter><StepDelivery state={state} onChange={onChange} /></MemoryRouter>)
    const card = await screen.findByTestId('destination-route-card-probe-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Test destination' }))

    expect(testDestination).toHaveBeenCalledWith(1)
    const result = await within(card).findByRole('status')
    expect(result).toHaveTextContent('Connection check passed')
    expect(result).toHaveTextContent('Endpoint responded')
    expect(result).toHaveTextContent('not end-to-end Stream delivery')
    expect(card).not.toHaveTextContent('Delivery proven')
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.anything() }))
  })

  it('surfaces an API-confirmed failed connectivity check as actionable failure, not success', async () => {
    const user = userEvent.setup()
    testDestination.mockResolvedValueOnce({
      success: false, message: 'Connection refused', latency_ms: 3.2, tested_at: '2026-10-09T07:00:00Z',
    })
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'failed-probe',
      destinationId: 2,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)
    const card = await screen.findByTestId('destination-route-card-failed-probe')
    await user.click(within(card).getByRole('button', { name: 'Actions for Backup Webhook' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Test destination' }))
    const result = await within(card).findByRole('alert')
    expect(result).toHaveTextContent('Connection check failed')
    expect(result).toHaveTextContent('Connection refused')
    expect(result).toHaveTextContent('Open destination')
    expect(result).not.toHaveTextContent('Connection check passed')
  })

  it('distinguishes test request failure from a failed endpoint check', async () => {
    const user = userEvent.setup()
    testDestination.mockRejectedValueOnce(new Error('private-secret-value'))
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'unavailable-probe',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)
    const card = await screen.findByTestId('destination-route-card-unavailable-probe')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Test destination' }))
    const result = await within(card).findByRole('alert')
    expect(result).toHaveTextContent('Connection check unavailable')
    expect(result).toHaveTextContent('Check authentication and API connectivity')
    expect(result).not.toHaveTextContent('private-secret-value')
    expect(result).not.toHaveTextContent('Connection check passed')
  })

  it('replaces stale positive probe feedback during a new test and shows the new failed result', async () => {
    const user = userEvent.setup()
    let releaseTest: (result: { success: boolean; message: string; latency_ms: number; tested_at: string }) => void = () => {}
    testDestination.mockResolvedValueOnce({
      success: true, message: 'Probe passed', latency_ms: 8, tested_at: '2026-10-09T07:00:00Z',
    }).mockImplementationOnce(() => new Promise((resolve) => { releaseTest = resolve }))
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'repeated-probe',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)
    const card = await screen.findByTestId('destination-route-card-repeated-probe')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Test destination' }))
    expect(await within(card).findByText(/Connection check passed/)).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Test destination' }))
    expect(within(card).getByTestId('destination-connectivity-loading-repeated-probe')).toHaveTextContent('Checking destination connectivity')
    expect(within(card).queryByText(/Connection check passed/)).not.toBeInTheDocument()
    releaseTest({ success: false, message: 'Connection timed out', latency_ms: 45, tested_at: '2026-10-09T07:01:00Z' })
    expect(await within(card).findByRole('alert')).toHaveTextContent('Connection timed out')
    expect(within(card).queryByTestId('destination-connectivity-loading-repeated-probe')).not.toBeInTheDocument()
    expect(testDestination).toHaveBeenCalledTimes(2)
  })

  it('preserves Stream setup before opening an existing destination detail from a Route card', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'route-open-detail',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    const onOpenDestinationPrerequisite = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={
            <StepDelivery state={state} onChange={vi.fn()} onOpenDestinationPrerequisite={onOpenDestinationPrerequisite} showCreateDraftReturnGuidance />
          } />
          <Route path="/destinations/:destinationId" element={<p>Destination details workspace</p>} />
        </Routes>
      </MemoryRouter>,
    )

    const card = await screen.findByTestId('destination-route-card-route-open-detail')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Open destination' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Destination details workspace')).not.toBeInTheDocument()
    expect(screen.getByTestId('destination-route-card-route-open-detail')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Open destination' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Destination details workspace')).toBeInTheDocument()
  })

  it('does not offer a second destination test while another test request is in flight', async () => {
    const user = userEvent.setup()
    let resolveFirst: (result: { success: boolean; message: string; latency_ms: number; tested_at: string }) => void = () => {}
    testDestination.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const state = buildInitialState()
    state.destinations.routeDrafts = [
      { key: 'busy-a', destinationId: 1, enabled: true, failurePolicy: 'RETRY_AND_BACKOFF', rateLimitJson: {} },
      { key: 'busy-b', destinationId: 2, enabled: true, failurePolicy: 'RETRY_AND_BACKOFF', rateLimitJson: {} },
    ]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)
    const a = await screen.findByTestId('destination-route-card-busy-a')
    const b = screen.getByTestId('destination-route-card-busy-b')
    await user.click(within(a).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(a).getByRole('menuitem', { name: 'Test destination' }))
    expect(within(a).getByTestId('destination-connectivity-loading-busy-a')).toBeInTheDocument()

    await user.click(within(b).getByRole('button', { name: 'Actions for Backup Webhook' }))
    expect(within(b).getByRole('menuitem', { name: 'Test destination' })).toBeDisabled()
    expect(testDestination).toHaveBeenCalledTimes(1)
    resolveFirst({ success: true, message: 'Endpoint responded', latency_ms: 4, tested_at: '2026-10-09T07:10:00Z' })
    await within(a).findByText(/Connection check passed/)
    expect(within(b).getByRole('menuitem', { name: 'Test destination' })).toBeEnabled()
    await user.click(within(b).getByRole('menuitem', { name: 'Test destination' }))
    expect(testDestination).toHaveBeenCalledTimes(2)
    expect(testDestination).toHaveBeenLastCalledWith(2)
  })

  it('confirms saved target, format and default count before bounded test delivery', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'bounded-test-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    const onChange = vi.fn()
    render(<MemoryRouter><StepDelivery state={state} onChange={onChange} /></MemoryRouter>)

    const card = await screen.findByTestId('destination-route-card-bounded-test-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Send test events…' }))

    const dialog = await screen.findByTestId('wizard-test-delivery-dialog')
    expect(dialog).toHaveTextContent('10.0.0.1:514')
    expect(dialog).toHaveTextContent('SYSLOG_UDP / json')
    expect(within(dialog).getByRole('spinbutton', { name: 'Test event count' })).toHaveValue(10)
    await user.click(within(dialog).getByRole('button', { name: 'Send 10 test events' }))

    expect(sendDestinationTestEvents).toHaveBeenCalledTimes(1)
    expect(sendDestinationTestEvents).toHaveBeenCalledWith(1, 10)
    const feedback = await within(dialog).findByTestId('wizard-test-delivery-feedback')
    expect(feedback).toHaveTextContent('Sent 10 synthetic logical test events')
    expect(feedback).toHaveTextContent('did not run or start the Stream or move its checkpoint')
    expect(feedback).toHaveTextContent('Test delivery ID: td-default')
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.any(Array) }))
  })

  it('blocks test delivery outside the 1-100 logical event bound', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'bounded-invalid-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)

    const card = await screen.findByTestId('destination-route-card-bounded-invalid-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Send test events…' }))
    const dialog = await screen.findByTestId('wizard-test-delivery-dialog')
    const count = within(dialog).getByRole('spinbutton', { name: 'Test event count' })
    await user.clear(count)
    await user.type(count, '101')

    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 100')
    expect(within(dialog).getByRole('button', { name: /Send .*test events/ })).toBeDisabled()
    expect(sendDestinationTestEvents).not.toHaveBeenCalled()
  })

  it('suppresses duplicate bounded sends while the first request is in flight', async () => {
    const user = userEvent.setup()
    let release: (value: {
      success: boolean
      destination_id: number
      destination_name: string
      destination_type: string
      target: string
      transport_format: string
      logical_event_count: number
      test_delivery_id: string
      tested_at: string
      message: string
    }) => void = () => {}
    sendDestinationTestEvents.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'bounded-duplicate-route',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)

    const card = await screen.findByTestId('destination-route-card-bounded-duplicate-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Stellar Syslog' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Send test events…' }))
    const dialog = await screen.findByTestId('wizard-test-delivery-dialog')
    const send = within(dialog).getByRole('button', { name: 'Send 10 test events' })
    fireEvent.click(send)
    fireEvent.click(send)

    expect(sendDestinationTestEvents).toHaveBeenCalledTimes(1)
    release({
      success: true,
      destination_id: 1,
      destination_name: 'Stellar Syslog',
      destination_type: 'SYSLOG_UDP',
      target: '10.0.0.1:514',
      transport_format: 'SYSLOG_UDP / json',
      logical_event_count: 10,
      test_delivery_id: 'td-once',
      tested_at: '2026-10-14T07:01:00Z',
      message: 'Sent 10 synthetic logical test events.',
    })
    expect(await within(dialog).findByText(/Test delivery ID: td-once/)).toBeInTheDocument()
  })

  it('shows a safe test-delivery failure without exposing raw transport errors', async () => {
    const user = userEvent.setup()
    sendDestinationTestEvents.mockRejectedValueOnce(new Error('https://user:secret@example.test/private token=hidden'))
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'bounded-failed-route',
      destinationId: 2,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    render(<MemoryRouter><StepDelivery state={state} onChange={vi.fn()} /></MemoryRouter>)

    const card = await screen.findByTestId('destination-route-card-bounded-failed-route')
    await user.click(within(card).getByRole('button', { name: 'Actions for Backup Webhook' }))
    await user.click(within(card).getByRole('menuitem', { name: 'Send test events…' }))
    const dialog = await screen.findByTestId('wizard-test-delivery-dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Send 10 test events' }))

    const feedback = await within(dialog).findByRole('alert')
    expect(feedback).toHaveTextContent('Test delivery failed')
    expect(feedback).not.toHaveTextContent('secret')
    expect(feedback).not.toHaveTextContent('token=hidden')
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

  it('refreshes destination choices after an integration is created in another tab', async () => {
    const state = buildInitialState()
    const onChange = vi.fn()
    fetchDestinationsList.mockResolvedValueOnce([])
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={onChange} />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No destinations configured yet/i)).toBeInTheDocument()

    fetchDestinationsList.mockResolvedValueOnce([{
      id: 21, name: 'New Webhook', destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://new.example.test/webhook' },
      rate_limit_json: {}, enabled: true, streams_using_count: 0, routes: [],
    }])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh destinations' }))

    expect(await screen.findByText('New Webhook')).toBeInTheDocument()
    expect(fetchDestinationsList).toHaveBeenCalledTimes(2)
    expect(invalidateDestinationsListCache).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      destinationApiBacked: true,
      destinationKindsById: { 21: 'WEBHOOK_POST' },
    }))
  })

  it('explains zero search results and clears filters without changing delivery paths', async () => {
    const user = userEvent.setup()
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'retained-filter-path',
      destinationId: 1,
      enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF',
      rateLimitJson: {},
    }]
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={state} onChange={onChange} />
      </MemoryRouter>,
    )
    await screen.findByText('Backup Webhook')
    await user.type(screen.getByPlaceholderText('Search destinations…'), 'not-an-existing-target')
    expect(screen.getByTestId('destination-library-empty')).toHaveTextContent('No destinations match')
    await user.click(screen.getByRole('button', { name: 'Clear destination filters' }))
    expect(screen.getByPlaceholderText('Search destinations…')).toHaveValue('')
    expect(screen.getByText('Backup Webhook')).toBeInTheDocument()
    expect(state.destinations.routeDrafts).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: [] }))
  })

  it('explains when every destination is disabled and guards the manage link', async () => {
    fetchDestinationsList.mockResolvedValueOnce([{
      id: 19,
      name: 'Disabled Webhook',
      destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://disabled.example.test' },
      enabled: false,
      rate_limit_json: {},
      streams_using_count: 0,
      routes: [],
    }])
    const onOpenDestinationPrerequisite = vi.fn(() => false)
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={
            <StepDelivery state={buildInitialState()} onChange={vi.fn()} onOpenDestinationPrerequisite={onOpenDestinationPrerequisite} showCreateDraftReturnGuidance />
          } />
          <Route path="/destinations" element={<p>Destination management workspace</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('No enabled destinations are available.')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('link', { name: 'Manage destinations' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()
  })

  it('checks for new destinations when the wizard tab regains focus', async () => {
    fetchDestinationsList.mockResolvedValueOnce([])
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={vi.fn()} />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/No destinations configured yet/i)).toBeInTheDocument()
    fetchDestinationsList.mockResolvedValueOnce([{
      id: 22, name: 'New Syslog UDP', destination_type: 'SYSLOG_UDP',
      config_json: { host: '127.0.0.1', port: 1514 },
      rate_limit_json: {}, enabled: true, streams_using_count: 0, routes: [],
    }])
    window.dispatchEvent(new Event('focus'))
    expect(await screen.findByText('New Syslog UDP')).toBeInTheDocument()
  })


  it('preserves already configured delivery paths if refreshed catalog is temporarily empty', async () => {
    const state = buildInitialState()
    state.destinations.routeDrafts = [{
      key: 'existing-path', destinationId: 1, enabled: true,
      failurePolicy: 'RETRY_AND_BACKOFF', rateLimitJson: {},
    }]
    const onChange = vi.fn()
    render(
      <MemoryRouter><StepDelivery state={state} onChange={onChange} /></MemoryRouter>,
    )
    expect(await screen.findByTestId('destination-route-card-existing-path')).toBeInTheDocument()
    fetchDestinationsList.mockResolvedValueOnce([])
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh destinations' }))
    expect(await screen.findByText(/No destinations configured yet/i)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: [] }))
    expect(state.destinations.routeDrafts).toHaveLength(1)
  })

  it('creates a Webhook Destination in the current Flow and attaches exactly one Route draft', async () => {
    createDestination.mockResolvedValue({
      id: 91,
      name: 'Inline receiver',
      destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://inline.example.test/events', payload_mode: 'SINGLE_EVENT_OBJECT' },
      rate_limit_json: {},
      enabled: true,
    })
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )

    await screen.findByText('Stellar Syslog')
    fetchDestinationsList.mockResolvedValueOnce([{
      id: 91,
      name: 'Inline receiver',
      destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://inline.example.test/events', payload_mode: 'SINGLE_EVENT_OBJECT' },
      rate_limit_json: {},
      enabled: true,
      streams_using_count: 0,
      routes: [],
    }])

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create destination here' }))
    const form = screen.getByTestId('wizard-inline-destination-form')
    await user.type(within(form).getByLabelText('Destination name'), 'Inline receiver')
    await user.type(within(form).getByLabelText('Webhook URL'), 'https://inline.example.test/events')
    await user.click(within(form).getByRole('button', { name: 'Create and add delivery path' }))

    await waitFor(() => {
      expect(createDestination).toHaveBeenCalledWith({
        name: 'Inline receiver',
        destination_type: 'WEBHOOK_POST',
        enabled: true,
        config_json: {
          url: 'https://inline.example.test/events',
          payload_mode: 'SINGLE_EVENT_OBJECT',
        },
        rate_limit_json: {},
      })
    })
    await waitFor(() => {
      const routeCalls = onChange.mock.calls
        .map(([patch]) => patch as { routeDrafts?: Array<{ destinationId: number }> })
        .filter((patch) => Array.isArray(patch.routeDrafts))
      expect(routeCalls).toHaveLength(1)
      expect(routeCalls[0]?.routeDrafts).toEqual([
        expect.objectContaining({ destinationId: 91, enabled: true }),
      ])
    })
    expect(await screen.findByTestId('wizard-inline-destination-created')).toHaveTextContent(
      'Destination Inline receiver created and delivery path added.',
    )
    expect(screen.queryByTestId('wizard-inline-destination-form')).not.toBeInTheDocument()
    expect(invalidateDestinationsListCache).toHaveBeenCalled()
  })

  it('uses strict verification and the TLS default port for an inline Syslog TLS Destination', async () => {
    createDestination.mockResolvedValue({
      id: 92,
      name: 'TLS receiver',
      destination_type: 'SYSLOG_TLS',
      config_json: {
        host: 'tls.receiver.internal',
        port: 6514,
        tls_enabled: true,
        tls_verify_mode: 'strict',
      },
      rate_limit_json: {},
      enabled: true,
    })
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )
    await screen.findByText('Stellar Syslog')
    fetchDestinationsList.mockResolvedValueOnce([])

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create destination here' }))
    const form = screen.getByTestId('wizard-inline-destination-form')
    await user.type(within(form).getByLabelText('Destination name'), 'TLS receiver')
    await user.selectOptions(within(form).getByLabelText('Destination type'), 'SYSLOG_TLS')
    expect(within(form).getByLabelText('Destination port')).toHaveValue('6514')
    await user.type(within(form).getByLabelText('Syslog host'), 'tls.receiver.internal')
    await user.click(within(form).getByRole('button', { name: 'Create and add delivery path' }))

    await waitFor(() => expect(createDestination).toHaveBeenCalledWith(expect.objectContaining({
      name: 'TLS receiver',
      destination_type: 'SYSLOG_TLS',
      config_json: {
        host: 'tls.receiver.internal',
        port: 6514,
        tls_enabled: true,
        tls_verify_mode: 'strict',
      },
    })))
  })

  it('keeps the inline form open on validation error and does not call the API', async () => {
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={vi.fn()} />
      </MemoryRouter>,
    )
    await screen.findByText('Stellar Syslog')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create destination here' }))
    const form = screen.getByTestId('wizard-inline-destination-form')
    await user.type(within(form).getByLabelText('Destination name'), 'Bad receiver')
    await user.type(within(form).getByLabelText('Webhook URL'), 'not-a-url')
    await user.click(within(form).getByRole('button', { name: 'Create and add delivery path' }))

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Webhook URL must start with http:// or https:// and include a host.',
    )
    expect(createDestination).not.toHaveBeenCalled()
    expect(screen.getByTestId('wizard-inline-destination-form')).toBeInTheDocument()
  })

  it('preserves inline input after an API save failure and does not attach a Route', async () => {
    createDestination.mockRejectedValueOnce(new Error('private backend detail'))
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )
    await screen.findByText('Stellar Syslog')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create destination here' }))
    const form = screen.getByTestId('wizard-inline-destination-form')
    await user.type(within(form).getByLabelText('Destination name'), 'Retry receiver')
    await user.type(within(form).getByLabelText('Webhook URL'), 'https://retry.example.test/events')
    await user.click(within(form).getByRole('button', { name: 'Create and add delivery path' }))

    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Destination save failed. Check required fields and API access, then retry.',
    )
    expect(within(form).getByLabelText('Destination name')).toHaveValue('Retry receiver')
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.any(Array) }))
  })

  it('cancels inline Destination creation without changing configured Route drafts', async () => {
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )
    await screen.findByText('Stellar Syslog')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create destination here' }))
    const form = screen.getByTestId('wizard-inline-destination-form')
    await user.type(within(form).getByLabelText('Destination name'), 'Cancelled receiver')
    await user.click(within(form).getAllByRole('button', { name: 'Cancel' })[0]!)

    expect(screen.queryByTestId('wizard-inline-destination-form')).not.toBeInTheDocument()
    expect(createDestination).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.any(Array) }))
  })

  it('preserves the current Stream draft before opening destination management from a populated library', async () => {
    const onOpenDestinationPrerequisite = vi.fn(() => true)
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={
            <StepDelivery state={buildInitialState()} onChange={vi.fn()} onOpenDestinationPrerequisite={onOpenDestinationPrerequisite} showCreateDraftReturnGuidance />
          } />
          <Route path="/destinations" element={<p>Destination management workspace</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await screen.findByText('Stellar Syslog')
    expect(screen.getByTestId('wizard-destination-resume-guidance')).toHaveTextContent('Opening Destinations saves this Stream draft first')
    expect(screen.getByTestId('wizard-destination-resume-guidance')).toHaveTextContent('Resume draft')
    await userEvent.setup().click(screen.getByRole('link', { name: 'Manage all destinations' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Destination management workspace')).toBeInTheDocument()
  })

  it('passes only contextual return intent when opening Destination creation', async () => {
    const onOpenDestinationPrerequisite = vi.fn(() => true)
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={
            <StepDelivery state={buildInitialState()} onChange={vi.fn()} onOpenDestinationPrerequisite={onOpenDestinationPrerequisite} showCreateDraftReturnGuidance />
          } />
          <Route path="/destinations" element={<WizardDestinationReturnStateProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('Stellar Syslog')
    await userEvent.setup().click(screen.getByRole('link', { name: 'Manage all destinations' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('destination-return-state')).toHaveTextContent('true')
  })

  it('keeps the populated Wizard open if saving the draft fails before destination creation', async () => {
    const onOpenDestinationPrerequisite = vi.fn(() => false)
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={
            <StepDelivery state={buildInitialState()} onChange={vi.fn()} onOpenDestinationPrerequisite={onOpenDestinationPrerequisite} showCreateDraftReturnGuidance />
          } />
          <Route path="/destinations" element={<p>Destination management workspace</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await screen.findByText('Stellar Syslog')
    await userEvent.setup().click(screen.getByRole('link', { name: 'Manage all destinations' }))
    expect(onOpenDestinationPrerequisite).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Destination management workspace')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage all destinations' })).toBeInTheDocument()
  })

  it('adds a Destination only once when Add delivery path is double-clicked before parent re-render', async () => {
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )

    const syslogLabel = await screen.findByText('Stellar Syslog')
    const syslogRow = syslogLabel.closest('li')
    expect(syslogRow).not.toBeNull()
    const add = within(syslogRow!).getByRole('button', { name: 'Add delivery path' })
    await userEvent.setup().dblClick(add)

    const routeCalls = onChange.mock.calls
      .map(([patch]) => patch as { routeDrafts?: Array<{ destinationId: number }> })
      .filter((patch) => Array.isArray(patch.routeDrafts))
    expect(routeCalls).toHaveLength(1)
    expect(routeCalls[0]?.routeDrafts).toEqual([
      expect.objectContaining({ destinationId: 1 }),
    ])
  })

  it('preserves two distinct Destination drafts across rapid sequential additions', async () => {
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} />
      </MemoryRouter>,
    )

    const syslogRow = (await screen.findByText('Stellar Syslog')).closest('li')
    const webhookRow = screen.getByText('Backup Webhook').closest('li')
    expect(syslogRow).not.toBeNull()
    expect(webhookRow).not.toBeNull()
    const user = userEvent.setup()
    await user.click(within(syslogRow!).getByRole('button', { name: 'Add delivery path' }))
    await user.click(within(webhookRow!).getByRole('button', { name: 'Add delivery path' }))

    const routeCalls = onChange.mock.calls
      .map(([patch]) => patch as { routeDrafts?: Array<{ destinationId: number }> })
      .filter((patch) => Array.isArray(patch.routeDrafts))
    expect(routeCalls.at(-1)?.routeDrafts?.map((draft) => draft.destinationId)).toEqual([1, 2])
  })

  it('refreshes a newly saved Destination and requires explicit operator Route attachment', async () => {
    fetchDestinationsList.mockResolvedValueOnce([{
      id: 91, name: 'Just created receiver', destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://example.test/receiver' },
      rate_limit_json: {}, enabled: true, streams_using_count: 0, routes: [],
    }])
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} recentlyCreatedDestinationId={91} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('wizard-returned-destination')).toHaveTextContent(
      'Destination #91 saved. Choose Add delivery path',
    )
    await waitFor(() => expect(invalidateDestinationsListCache).toHaveBeenCalledTimes(1))
    const add = await screen.findByRole('button', { name: 'Add delivery path to Just created receiver' })
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.any(Array) }))
    await userEvent.setup().click(add)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      routeDrafts: [expect.objectContaining({ destinationId: 91, enabled: true })],
    }))
  })

  it('keeps a missing or disabled returned Destination out of Route creation', async () => {
    fetchDestinationsList.mockResolvedValueOnce([{
      id: 92, name: 'Disabled receiver', destination_type: 'WEBHOOK_POST',
      config_json: { url: 'https://example.test/disabled' },
      rate_limit_json: {}, enabled: false, streams_using_count: 0, routes: [],
    }])
    const onChange = vi.fn()
    const view = render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} recentlyCreatedDestinationId={92} />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/This destination is disabled/)).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-add-returned-destination')).not.toBeInTheDocument()
    view.unmount()

    fetchDestinationsList.mockResolvedValueOnce([])
    render(
      <MemoryRouter>
        <StepDelivery state={buildInitialState()} onChange={onChange} recentlyCreatedDestinationId={93} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('wizard-refresh-returned-destination')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-add-returned-destination')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ routeDrafts: expect.any(Array) }))
  })

})
