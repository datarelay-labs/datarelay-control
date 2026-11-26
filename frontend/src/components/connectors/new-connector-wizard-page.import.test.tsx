import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { postCurlParse, postPostmanParse, type CurlImportDraft } from '../../api/gdcBackup'
import { createConnector } from '../../api/gdcConnectors'
import { NewConnectorWizardPage } from './new-connector-wizard-page'

vi.mock('../../api/gdcConnectors', () => ({
  createConnector: vi.fn(async () => ({ id: 42 })),
}))

vi.mock('../../api/gdcBackup', () => ({
  postCurlParse: vi.fn(),
  postPostmanParse: vi.fn(),
}))

function renderWithCurlDraft() {
  const draft = {
    name: 'Imported HTTP connector',
    description: 'from curl',
    source_type: 'HTTP_API_POLLING',
    base_url: 'https://api.example.com',
    auth_type: 'no_auth',
    status: 'STOPPED',
    common_headers: { Accept: 'application/json' },
  }
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: '/connectors/new',
          state: {
            curlDraft: draft,
            streamDraft: { name: 'Imported events', config_json: { method: 'GET', endpoint: '/v1/events' } },
          },
        },
      ]}
    >
      <Routes>
        <Route path="/connectors/new" element={<NewConnectorWizardPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('NewConnectorWizardPage import hydration', () => {
  it('prefills connector fields from approved curl draft', async () => {
    renderWithCurlDraft()
    await waitFor(() => {
      expect(screen.getByDisplayValue('Imported HTTP connector')).toBeInTheDocument()
    })
    expect(screen.getByDisplayValue('https://api.example.com')).toBeInTheDocument()
    expect(screen.getByText(/Imported events/i)).toBeInTheDocument()
  })

  it.each(['cURL', 'Postman'] as const)('keeps the owning Data Flow mounted while approving a contextual %s import', async (kind) => {
    const streamDraft = {
      name: 'Imported finance events', stream_type: 'HTTP_API_POLLING', enabled: false,
      status: 'STOPPED', config_json: { method: 'GET', endpoint: '/v1/finance' }, polling_interval: 60,
    }
    const draft: CurlImportDraft = {
        draft_kind: kind === 'cURL' ? 'curl_http' : 'postman_http',
        connector: {
          name: 'Finance Connector', source_type: 'HTTP_API_POLLING', base_url: 'https://finance.example.net',
          auth_type: 'no_auth', status: 'STOPPED', common_headers: {},
        },
        stream: streamDraft, source_config_json: {}, parsed: {
          method: 'GET', base_url: 'https://finance.example.net', endpoint: '/v1/finance',
          query_params: {}, headers_masked: {},
        },
        warnings: [], parse_errors: [], secrets_included: false,
    }
    if (kind === 'cURL') {
      vi.mocked(postCurlParse).mockResolvedValueOnce({ ok: true, draft, warnings: [], parse_errors: [] })
    } else {
      const items = [{ item_id: 'finance', name: 'Finance', method: 'GET', folder_path: '' }]
      vi.mocked(postPostmanParse)
        .mockResolvedValueOnce({ ok: true, items, draft: null, warnings: [], parse_errors: [] } as Awaited<ReturnType<typeof postPostmanParse>>)
        .mockResolvedValueOnce({ ok: true, items, draft, warnings: [], parse_errors: [] } as Awaited<ReturnType<typeof postPostmanParse>>)
    }
    const onCreated = vi.fn()
    function Path() {
      const location = useLocation()
      return <span data-testid="context-path">{location.pathname}</span>
    }
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <Routes>
          <Route path="/streams/new" element={<><Path /><NewConnectorWizardPage onCreated={onCreated} /></>} />
          <Route path="/connectors/new" element={<p data-testid="unexpected-exit">Left Data Flow</p>} />
        </Routes>
      </MemoryRouter>,
    )
    // An approved import replaces the Connector draft, not the owning Data Flow.
    // Previously typed Connector credentials must not cross into a new import.
    await user.selectOptions(screen.getByLabelText('Authentication Type'), 'bearer')
    await user.type(screen.getByLabelText('Bearer Token'), 'previous-draft-token')
    if (kind === 'cURL') {
      fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), {
        target: { value: 'curl https://finance.example.net/v1/finance' },
      })
      await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    } else {
      fireEvent.change(screen.getByRole('textbox', { name: 'Postman collection JSON' }), {
        target: { value: '{"item":[]}' },
      })
      await user.click(screen.getByRole('button', { name: 'Parse collection' }))
      await user.click(await screen.findByRole('button', { name: 'Preview request' }))
    }
    await user.click(await screen.findByRole('button', { name: 'Approve and open wizard' }))
    expect(screen.getByTestId('context-path')).toHaveTextContent('/streams/new')
    expect(screen.queryByTestId('unexpected-exit')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('Finance Connector')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save Connector' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, streamDraft))
    expect(vi.mocked(createConnector).mock.lastCall?.[0]).not.toHaveProperty('bearer_token', 'previous-draft-token')
  })

  it('shows import panels on the start screen', () => {
    render(
      <MemoryRouter>
        <NewConnectorWizardPage />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'Parse cURL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parse collection' })).toBeInTheDocument()
  })
})
