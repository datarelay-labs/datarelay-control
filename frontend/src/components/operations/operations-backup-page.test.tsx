import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { OperationsBackupPage } from './operations-backup-page'

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
})
