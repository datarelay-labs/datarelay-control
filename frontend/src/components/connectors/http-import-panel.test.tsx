import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { CurlImportPanel, PostmanImportPanel } from './http-import-panel'

function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

const sampleDraft = {
  draft_kind: 'curl_http',
  connector: {
    name: 'Imported HTTP connector',
    base_url: 'https://api.example.com',
    auth_type: 'bearer',
    bearer_token: '',
    source_type: 'HTTP_API_POLLING',
    connector_type: 'generic_http',
    status: 'STOPPED',
    common_headers: {},
  },
  source_config_json: {},
  stream: {
    name: 'Imported stream',
    stream_type: 'HTTP_API_POLLING',
    enabled: false,
    status: 'STOPPED',
    config_json: { method: 'GET', endpoint: '/v1/events' },
    polling_interval: 60,
  },
  parsed: {
    method: 'GET',
    base_url: 'https://api.example.com',
    endpoint: '/v1/events',
    query_params: {},
    headers_masked: { Authorization: '********' },
    has_json_body: false,
    has_raw_body: false,
  },
  warnings: [],
  parse_errors: [],
  secrets_included: false,
}

const postCurlParseMock = vi.fn()
const postPostmanParseMock = vi.fn()

vi.mock('../../api/gdcBackup', () => ({
  postCurlParse: (...args: unknown[]) => postCurlParseMock(...args),
  postPostmanParse: (...args: unknown[]) => postPostmanParseMock(...args),
}))

describe('Http import panels', () => {
  beforeEach(() => {
    postCurlParseMock.mockReset()
    postPostmanParseMock.mockReset()
  })

  it('renders cURL import and shows parsed preview', async () => {
    const user = userEvent.setup()
    postCurlParseMock.mockResolvedValueOnce({ ok: true, draft: sampleDraft, warnings: [], parse_errors: [] })
    renderWithRouter(<CurlImportPanel onApprove={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Parse cURL' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), {
      target: { value: "curl https://api.example.com/v1/events -H 'Authorization: Bearer x'" },
    })
    await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    expect(await screen.findByText('Parsed request preview')).toBeInTheDocument()
    expect(screen.getByText('/v1/events')).toBeInTheDocument()
    expect(screen.getByText(/Authorization: \*\*\*\*\*\*\*\*/)).toBeInTheDocument()
  })

  it('approve cURL import calls onApprove with draft', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn()
    postCurlParseMock.mockResolvedValueOnce({ ok: true, draft: sampleDraft, warnings: [], parse_errors: [] })
    renderWithRouter(<CurlImportPanel onApprove={onApprove} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), {
      target: { value: 'curl https://api.example.com/v1/events' },
    })
    await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    await user.click(await screen.findByRole('button', { name: 'Approve and open wizard' }))
    expect(onApprove).toHaveBeenCalledWith(sampleDraft)
  })

  it('shows cURL parse error for invalid input', async () => {
    const user = userEvent.setup()
    postCurlParseMock.mockRejectedValueOnce(new Error('422: [CURL_PARSE_FAILED] No URL found in curl command.'))
    renderWithRouter(<CurlImportPanel onApprove={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), { target: { value: 'curl' } })
    await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No URL found/i)
  })

  it('only advises fixing the command when the server reported a parse failure (F-115)', async () => {
    const user = userEvent.setup()
    postCurlParseMock.mockRejectedValueOnce(new Error('422: [CURL_PARSE_FAILED] No URL found in curl command.'))
    renderWithRouter(<CurlImportPanel onApprove={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), { target: { value: 'curl' } })
    await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Check that the command starts with "curl"/)

    postCurlParseMock.mockRejectedValueOnce(new Error('422: Input should be a valid dictionary or object to extract fields from'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Curl command' }), {
      target: { value: 'curl https://api.example.com/v1/events' },
    })
    await user.click(screen.getByRole('button', { name: 'Parse cURL' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/valid dictionary/))
    expect(screen.getByRole('alert')).not.toHaveTextContent(/Check that the command starts with/)
  })

  it('renders Postman import button', () => {
    renderWithRouter(<PostmanImportPanel onApprove={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Parse collection' })).toBeInTheDocument()
  })

  it('shows Postman error for invalid JSON', async () => {
    const user = userEvent.setup()
    renderWithRouter(<PostmanImportPanel onApprove={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Postman collection JSON' }), { target: { value: 'not-json' } })
    await user.click(screen.getByRole('button', { name: 'Parse collection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid JSON/i)
  })

  it('lists Postman requests and approves selected draft', async () => {
    const user = userEvent.setup()
    const onApprove = vi.fn()
    const collection = { info: { name: 'API' }, item: [] }
    postPostmanParseMock
      .mockResolvedValueOnce({
        ok: true,
        items: [{ item_id: 'List_events', name: 'List events', folder_path: '', method: 'GET', url_preview: 'https://api.example.com/v1/events' }],
        draft: null,
        warnings: [],
        parse_errors: [],
      })
      .mockResolvedValueOnce({ ok: true, items: [], draft: sampleDraft, warnings: [], parse_errors: [] })

    renderWithRouter(<PostmanImportPanel onApprove={onApprove} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Postman collection JSON' }), {
      target: { value: JSON.stringify(collection) },
    })
    await user.click(screen.getByRole('button', { name: 'Parse collection' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Postman request' })).toBeInTheDocument())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Postman request' }), 'List_events')
    await user.click(screen.getByRole('button', { name: 'Preview request' }))
    await user.click(await screen.findByRole('button', { name: 'Approve and open wizard' }))
    expect(onApprove).toHaveBeenCalledWith(sampleDraft)
  })
})
