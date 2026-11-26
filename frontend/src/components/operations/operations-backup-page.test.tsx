import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { OperationsBackupPage } from './operations-backup-page'
import { downloadBackupUrl, postImportApply, postImportPreview } from '../../api/gdcBackup'

const emptyCounts = {
  connectors: 0,
  sources: 0,
  streams: 0,
  mappings: 0,
  enrichments: 0,
  destinations: 0,
  routes: 0,
  checkpoints: 0,
}

vi.mock('../../api/gdcBackup', () => ({
  buildWorkspaceExportPath: () => 'http://localhost/api/v1/backup/workspace/export',
  downloadBackupUrl: vi.fn(async () => {}),
  postCurlParse: vi.fn(),
  postPostmanParse: vi.fn(),
  postImportPreview: vi.fn(async () => ({
    ok: false,
    export_kind: null,
    counts: emptyCounts,
    conflicts: [{ code: 'MISSING_CONNECTORS', message: 'Import bundle must include a non-empty connectors array.' }],
    warnings: [],
    unsupported_items: [],
    preview_token: '',
  })),
  postImportApply: vi.fn(),
}))

describe('OperationsBackupPage', () => {
  it('renders recovery hierarchy and additive/clone authority wording', () => {
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('operations-backup-page')).toBeInTheDocument()
    expect(screen.getByTestId('backup-authority-banner')).toHaveTextContent(/additive or clone only/i)
    expect(screen.getByTestId('backup-authority-banner')).toHaveTextContent(/not database disaster recovery/i)
    expect(screen.getByTestId('backup-export-section')).toBeInTheDocument()
    expect(screen.getByTestId('backup-import-section')).toBeInTheDocument()
    expect(screen.getByTestId('backup-postgres-dr-note')).toBeInTheDocument()
    const mode = screen.getByRole('combobox', { name: 'Import mode' })
    expect(mode).toHaveValue('additive')
    expect(screen.queryByRole('option', { name: /full restore/i })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /additive/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /clone/i })).toBeInTheDocument()
  })

  it('keeps cURL and Postman helpers behind progressive disclosure', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('button', { name: 'Parse cURL' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /cURL \/ Postman connector import/i }))
    expect(screen.getByRole('button', { name: 'Parse cURL' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Parse collection' })).toBeInTheDocument()
  })

  it('runs preview and shows conflict summary with alert semantics', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    const ta = screen.getByRole('textbox', { name: 'Import JSON payload' })
    fireEvent.change(ta, { target: { value: '{"version":2,"connectors":[]}' } })
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    expect(await screen.findByText('Conflicts')).toBeInTheDocument()
    expect(screen.getByText(/MISSING_CONNECTORS/i)).toBeInTheDocument()
    expect(screen.getByTestId('backup-preview-result')).toBeInTheDocument()
  })

  it('explains an empty import and never prints raw JSON engine messages (F-215)', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('backup-import-empty-hint')).toHaveTextContent(/choose a file or paste json/i)
    const ta = screen.getByRole('textbox', { name: 'Import JSON payload' })
    fireEvent.change(ta, { target: { value: 'this is not json {' } })
    expect(screen.queryByTestId('backup-import-empty-hint')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    const alert = await screen.findByText(/not valid JSON, or the file is incomplete/i)
    expect(alert).toBeInTheDocument()
    expect(screen.queryByText(/Unexpected token/i)).not.toBeInTheDocument()

    fireEvent.change(ta, { target: { value: '[]' } })
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    expect(await screen.findByText(/must be a JSON object/i)).toBeInTheDocument()
  })

  it('lists the secrets to re-enter after apply instead of redirecting past them (F-210)', async () => {
    const user = userEvent.setup()
    vi.mocked(postImportPreview).mockResolvedValueOnce({
      ok: true,
      export_kind: 'workspace',
      counts: { ...emptyCounts, connectors: 1 },
      conflicts: [],
      warnings: [],
      unsupported_items: [],
      preview_token: 'tok-1',
    })
    vi.mocked(postImportApply).mockResolvedValueOnce({
      ok: true,
      created: { connector_ids: [7], source_ids: [7], stream_ids: [9], destination_ids: [] },
      redirect_path: '/connectors/7',
      secrets_to_reenter: [
        {
          entity_type: 'connector',
          entity_id: 7,
          name: 'Webhook receiver A',
          source_type: 'WEBHOOK_RECEIVER',
          fields: ['Shared secret'],
          blocks_operation: true,
          message: 'm',
          edit_path: '/connectors/7',
        },
      ],
    })
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Import JSON payload' }), {
      target: { value: '{"version":2,"connectors":[{"id":1,"name":"x"}]}' },
    })
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    await screen.findByText('Preview OK')
    await user.click(screen.getByLabelText(/I reviewed the preview/i))
    await user.click(screen.getByTestId('backup-apply-open'))
    const dialog = await screen.findByTestId('backup-apply-dialog')
    expect(dialog).not.toHaveTextContent(/Secrets remain masked/i)
    expect(dialog).toHaveTextContent(/never contain secrets/i)
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))

    const panel = await screen.findByTestId('backup-secrets-reentry')
    expect(panel).toHaveTextContent('Webhook receiver A')
    expect(panel).toHaveTextContent('Shared secret')
    expect(panel).toHaveTextContent(/cannot work until you do/i)
    expect(screen.getByRole('link', { name: /Connector: Webhook receiver A/ })).toHaveAttribute('href', '/connectors/7')
    expect(screen.getByRole('status')).toHaveTextContent(/1 connector, 1 stream, 0 destinations created/)
  })

  it('states what the export masked and warns when a file reports unmasked secrets (E-123)', async () => {
    const user = userEvent.setup()
    vi.mocked(downloadBackupUrl).mockResolvedValueOnce({ secretsMasked: true, maskedFieldCount: 7, issues: [] })
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: 'Download JSON' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Secrets were masked \(7 fields\)/)

    vi.mocked(downloadBackupUrl).mockResolvedValueOnce({
      secretsMasked: false,
      maskedFieldCount: 0,
      issues: ['sources[0].auth_json.token_body contains a stored secret value that must be masked'],
    })
    await user.click(screen.getByRole('button', { name: 'Download JSON' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/NOT masked/)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows name conflicts and sends the explicit skip / rename choice on apply (E-124)', async () => {
    const user = userEvent.setup()
    vi.mocked(postImportPreview).mockResolvedValueOnce({
      ok: true,
      export_kind: 'workspace',
      counts: { ...emptyCounts, connectors: 1 },
      conflicts: [],
      warnings: [],
      unsupported_items: [],
      name_conflicts: [
        { entity_type: 'connector', name: 'bfs-b1-http-bearer', export_id: 4, existing_ids: [4, 21], message: 'm' },
      ],
      requires_name_conflict_choice: true,
      preview_token: 'tok-2',
    })
    vi.mocked(postImportApply).mockResolvedValueOnce({
      ok: true,
      created: { connector_ids: [], source_ids: [], stream_ids: [], destination_ids: [] },
      skipped: [
        { entity_type: 'connector', name: 'bfs-b1-http-bearer', export_id: 4, reason: 'NAME_EXISTS', existing_ids: [4, 21] },
      ],
      renamed: [],
      redirect_path: null,
    })
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Import JSON payload' }), {
      target: { value: '{"version":2,"connectors":[{"id":4,"name":"bfs-b1-http-bearer"}]}' },
    })
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    const box = await screen.findByTestId('backup-name-conflicts')
    expect(box).toHaveTextContent(/bfs-b1-http-bearer/)
    expect(box).toHaveTextContent(/already exists \(id 4, 21\)/)
    const choice = within(box).getByRole('combobox', { name: 'When a name already exists' })
    expect(choice).toHaveValue('skip') // the non-destructive, idempotent default
    await user.click(screen.getByLabelText(/I reviewed the preview/i))
    await user.click(screen.getByTestId('backup-apply-open'))
    const dialog = await screen.findByTestId('backup-apply-dialog')
    expect(dialog).toHaveTextContent(/1 name conflict\(s\): those entities are skipped and nothing is duplicated/)
    await user.click(within(dialog).getByRole('button', { name: 'Apply import' }))

    await screen.findByText(/1 skipped/)
    expect(postImportApply).toHaveBeenLastCalledWith(
      expect.anything(),
      'additive',
      'tok-2',
      expect.objectContaining({ on_name_conflict: 'skip' }),
    )
  })

  it('sends rename when the operator chooses to create a conflicting name under a new one', async () => {
    const user = userEvent.setup()
    vi.mocked(postImportPreview).mockResolvedValueOnce({
      ok: true,
      export_kind: 'workspace',
      counts: { ...emptyCounts, connectors: 1 },
      conflicts: [],
      warnings: [],
      unsupported_items: [],
      name_conflicts: [{ entity_type: 'destination', name: 'd1', export_id: 1, existing_ids: [3], message: 'm' }],
      requires_name_conflict_choice: true,
      preview_token: 'tok-3',
    })
    vi.mocked(postImportApply).mockResolvedValueOnce({
      ok: true,
      created: { connector_ids: [], source_ids: [], stream_ids: [], destination_ids: [9] },
      renamed: [{ entity_type: 'destination', name: 'd1', new_name: 'd1 (2)', entity_id: 9 }],
      redirect_path: null,
    })
    render(
      <MemoryRouter>
        <OperationsBackupPage />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Import JSON payload' }), {
      target: { value: '{"version":2,"connectors":[{"id":4,"name":"x"}]}' },
    })
    await user.click(screen.getByRole('button', { name: 'Validate & preview' }))
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'When a name already exists' }),
      'rename',
    )
    await user.click(screen.getByLabelText(/I reviewed the preview/i))
    await user.click(screen.getByTestId('backup-apply-open'))
    await user.click(within(await screen.findByTestId('backup-apply-dialog')).getByRole('button', { name: 'Apply import' }))
    await screen.findByText(/1 created under a new name/)
    expect(postImportApply).toHaveBeenLastCalledWith(
      expect.anything(),
      'additive',
      'tok-3',
      expect.objectContaining({ on_name_conflict: 'rename' }),
    )
  })
})
