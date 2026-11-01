import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ConnectorWritePayload } from '../../api/gdcConnectors'
import { DatabaseConnectorFields } from './database-connector-fields'

function renderWith(sslMode: string) {
  const form = { name: 'db', source_type: 'DATABASE_QUERY', db_type: 'POSTGRESQL', ssl_mode: sslMode } as ConnectorWritePayload
  return render(<DatabaseConnectorFields form={form} set={vi.fn()} />)
}

describe('DatabaseConnectorFields SSL verification modes (F-111)', () => {
  it.each(['VERIFY_CA', 'VERIFY_FULL'])('explains where the root certificate comes from for %s', (mode) => {
    renderWith(mode)
    const note = screen.getByTestId('db-ssl-verify-note')
    expect(note).toHaveTextContent(mode)
    expect(note).toHaveTextContent('root certificate installed on the DataRelay server')
    expect(note).toHaveTextContent('cannot upload a CA')
    expect(note).toHaveTextContent('REQUIRE')
  })

  it.each(['DISABLE', 'PREFER', 'REQUIRE'])('shows no certificate note for %s', (mode) => {
    renderWith(mode)
    expect(screen.queryByTestId('db-ssl-verify-note')).not.toBeInTheDocument()
  })
})
