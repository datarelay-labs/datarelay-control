import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamMappingPage } from './stream-mapping-page'

const loadMappingWorkspaceContext = vi.fn()
const saveStreamMappingUiConfigStrict = vi.fn()

vi.mock('../../utils/mappingSourceSample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/mappingSourceSample')>()
  return { ...actual, loadMappingWorkspaceContext: (...args: unknown[]) => loadMappingWorkspaceContext(...args) }
})

vi.mock('../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: (...args: unknown[]) => saveStreamMappingUiConfigStrict(...args),
}))

vi.mock('../mappings/mapping-workspace', () => ({
  MappingWorkspace: () => <div data-testid="mapping-workspace-stub" />,
}))

function context(status: string) {
  return {
    stream: { id: 10, name: 'Stream ten', status, stream_type: 'HTTP_API_POLLING', connector_id: null },
    cfg: {
      stream_name: 'Stream ten',
      stream_status: status,
      source_type: 'HTTP_API_POLLING',
      mapping: { field_mappings: { msg_copy: '$.message' }, event_array_path: null, event_root_path: null },
      enrichment: { enabled: true, exists: false, enrichment: {} },
    },
    connectorName: 'Conn',
    sample: { eventArrayPath: '', eventRootPath: '' },
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/streams/10/mapping']}>
      <Routes>
        <Route path="/streams/:streamId/mapping" element={<StreamMappingPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  loadMappingWorkspaceContext.mockReset()
  saveStreamMappingUiConfigStrict.mockReset()
  saveStreamMappingUiConfigStrict.mockResolvedValue({ message: 'Mapping UI configuration saved successfully' })
})

describe('legacy mapping page applies the stop-first gate (F-173)', () => {
  it('disables Save Mapping and says to stop the stream while it is RUNNING', async () => {
    loadMappingWorkspaceContext.mockResolvedValue(context('RUNNING'))
    renderPage()

    const note = await screen.findByTestId('mapping-stop-first-note')
    expect(note).toHaveTextContent(/stop the stream before saving/i)
    const save = screen.getByRole('button', { name: 'Save Mapping' })
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('aria-describedby', 'mapping-stop-first-note')
    expect(saveStreamMappingUiConfigStrict).not.toHaveBeenCalled()
  })

  it('saves normally once the stream is stopped', async () => {
    loadMappingWorkspaceContext.mockResolvedValue(context('STOPPED'))
    const user = userEvent.setup()
    renderPage()

    const save = await screen.findByRole('button', { name: 'Save Mapping' })
    expect(screen.queryByTestId('mapping-stop-first-note')).not.toBeInTheDocument()
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() => expect(saveStreamMappingUiConfigStrict).toHaveBeenCalledTimes(1))
    expect(saveStreamMappingUiConfigStrict.mock.calls[0][0]).toBe(10)
  })
})
