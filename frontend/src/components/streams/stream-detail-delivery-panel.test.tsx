import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { StreamDetailDeliveryPanel } from './stream-detail-delivery-panel'

function mount(streamId: string, canConfigure: boolean) {
  return render(
    <MemoryRouter>
      <StreamDetailDeliveryPanel
        streamId={streamId}
        connectorName="Finance API"
        sourceLabel="Transactions"
        canConfigure={canConfigure}
      />
    </MemoryRouter>,
  )
}

describe('Stream schema delivery journey for read-only and editor roles', () => {
  it('offers a Viewer scoped read-only evidence path without links inviting configuration changes', () => {
    mount('42', false)
    expect(screen.getByRole('region', { name: 'Stream delivery path' })).toBeInTheDocument()
    const logs = screen.getByRole('link', { name: 'Inspect Stream delivery logs' })
    expect(logs).toHaveAttribute('href', '/logs?stream_id=42')
    expect(screen.getByRole('link', { name: 'Inspect Stream delivery trends (24h)' }))
      .toHaveAttribute('href', '/monitoring/analytics?window=24h&stream_id=42')
    expect(screen.queryByRole('link', { name: /Edit source connection|Edit delivery paths|Open mapping workspace|Open protection settings/ })).not.toBeInTheDocument()
    expect(screen.getByText(/configuration requires editor access/i)).toBeInTheDocument()
    expect(screen.getByText(/receiving endpoint ingestion is not verified/i)).toBeInTheDocument()
  })

  it('preserves existing authoring links for editors and keeps investigation read-only', () => {
    mount('42', true)
    expect(screen.getByRole('link', { name: /Edit source connection/ })).toHaveAttribute('href', '/streams/42/edit?section=source')
    expect(screen.getByRole('link', { name: /Edit delivery paths/ })).toHaveAttribute('href', '/streams/42/edit?section=delivery')
    expect(screen.getByRole('link', { name: 'Inspect Stream delivery logs' })).toHaveAttribute('href', '/logs?stream_id=42')
    expect(screen.getByRole('link', { name: 'Inspect Stream delivery trends (24h)' }))
      .toHaveAttribute('href', '/monitoring/analytics?window=24h&stream_id=42')
  })

  it.each(['0', '-2', '42junk', String(Number.MAX_SAFE_INTEGER + 1)])(
    'never invents delivery evidence links for invalid Stream identity %s',
    (id) => {
      mount(id, false)
      expect(screen.queryByRole('link', { name: 'Inspect Stream delivery logs' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Inspect Stream delivery trends (24h)' })).not.toBeInTheDocument()
    },
  )
})
