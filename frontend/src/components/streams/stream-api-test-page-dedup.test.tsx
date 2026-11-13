import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamApiTestPage } from './stream-api-test-page'

const fetchStreamDeduplication = vi.fn()
const saveStreamDeduplication = vi.fn()

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamById: vi.fn(async () => ({
    id: 1,
    name: 'bfs-stream',
    stream_type: 'HTTP_API_POLLING',
    connector_id: null,
    config_json: { base_url: 'http://127.0.0.1:1', endpoint: '/events' },
  })),
}))

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamMappingUiConfig: vi.fn(async () => ({
    stream_name: 'bfs-stream',
    source_type: 'HTTP_API_POLLING',
    source_config: {},
    mapping: { event_array_path: '$.items', event_root_path: '' },
  })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcRuntimePreview', () => ({
  runHttpApiTest: vi.fn(),
  runExtractionValidate: vi.fn(),
}))

vi.mock('../../api/gdcRuntimeUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/gdcRuntimeUi')>()
  return {
    ...actual,
    fetchStreamDeduplication: (...args: unknown[]) => fetchStreamDeduplication(...args),
    saveStreamDeduplication: (...args: unknown[]) => saveStreamDeduplication(...args),
  }
})

function dedupStatus(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    key_field: 'severity',
    custom_jsonpath: null,
    duplicate_handling: 'skip_duplicate',
    scope: 'current_run',
    window_hours: null,
    last_runtime_duplicate_count: 13,
    last_runtime_dedup_summary: { duplicate_events: 13 },
    last_runtime_stats_degraded: false,
    ...over,
  }
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/streams/1/api-test']}>
      <Routes>
        <Route path="/streams/:streamId/api-test" element={<StreamApiTestPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  fetchStreamDeduplication.mockReset()
  saveStreamDeduplication.mockReset()
})

describe('StreamApiTestPage - deduplication control (F-131)', () => {
  it('shows the saved state and how many events the last poll dropped', async () => {
    fetchStreamDeduplication.mockResolvedValue(dedupStatus())
    renderPage()

    const status = await screen.findByTestId('dedup-status')
    await waitFor(() => expect(status).toHaveTextContent('Deduplication is ON (key severity)'))
    expect(screen.getByTestId('dedup-dropped')).toHaveTextContent('Last poll dropped 13 event(s) as duplicates.')
  })

  it('persists a cleared key on Save & Continue, verifies the read-back, then navigates', async () => {
    fetchStreamDeduplication.mockResolvedValueOnce(dedupStatus())
    renderPage()
    const input = await screen.findByPlaceholderText('e.g. id')
    await waitFor(() => expect(input).toHaveValue('severity'))

    fetchStreamDeduplication.mockResolvedValueOnce(dedupStatus({ enabled: false, last_runtime_duplicate_count: 0 }))
    saveStreamDeduplication.mockResolvedValue(dedupStatus({ enabled: false }))
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByTestId('dedup-status')).toHaveTextContent('Unsaved change')
    fireEvent.click(screen.getByRole('button', { name: /save & continue/i }))

    await waitFor(() => expect(saveStreamDeduplication).toHaveBeenCalledTimes(1))
    expect(saveStreamDeduplication.mock.calls[0][1]).toMatchObject({ enabled: false })
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/mapping'))
  })

  it('stays on the page with an error when the API still reports deduplication on', async () => {
    fetchStreamDeduplication.mockResolvedValueOnce(dedupStatus())
    renderPage()
    const input = await screen.findByPlaceholderText('e.g. id')
    await waitFor(() => expect(input).toHaveValue('severity'))

    fetchStreamDeduplication.mockResolvedValueOnce(dedupStatus({ enabled: true }))
    saveStreamDeduplication.mockResolvedValue(dedupStatus({ enabled: false }))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save & continue/i }))

    expect(await screen.findByText(/Deduplication was not disabled/i)).toBeInTheDocument()
    expect(screen.queryByTestId('where')).not.toBeInTheDocument()
  })

  it('navigates straight on when the key did not change', async () => {
    fetchStreamDeduplication.mockResolvedValue(dedupStatus({ enabled: false }))
    renderPage()
    await screen.findByPlaceholderText('e.g. id')
    await waitFor(() => expect(screen.getByRole('button', { name: /save & continue/i })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /save & continue/i }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/mapping'))
    expect(saveStreamDeduplication).not.toHaveBeenCalled()
  })
})
