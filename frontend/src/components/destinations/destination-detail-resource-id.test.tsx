import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestinationDetailPage } from './destination-detail-page'
import { useDestinationDetailData } from './use-destination-detail-data'

// Unit-only context: invalid URL IDs must never reach destination API reads.
vi.mock('./use-destination-detail-data', () => ({
  useDestinationDetailData: vi.fn(() => ({ destination: null, listRow: null, connectedRoutes: [], failed24h: 0, currentEps: null, loading: true })),
}))

function mount(destinationId: string) {
  return render(
    <MemoryRouter initialEntries={[`/destinations/${destinationId}`]}>
      <Routes>
        <Route path="/destinations/:destinationId" element={<DestinationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Destination detail exact URL identity gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['0', '000', '9007199254740992', '9999999999999999999999', '-2', '1.5', '42junk'])(
    'rejects invalid or unsafe Destination ID %s before any API read',
    (raw) => {
      mount(raw)
      expect(screen.getByText(/Invalid destination id. Open a destination from the Destinations list./i))
        .toBeInTheDocument()
      expect(useDestinationDetailData).toHaveBeenCalledWith(null)
      expect(screen.queryByText('Loading destination…')).not.toBeInTheDocument()
    },
  )

  it('retains a positive safe Destination ID without silently rounding or truncating', () => {
    mount('42')
    expect(useDestinationDetailData).toHaveBeenCalledWith(42)
    expect(screen.getByText('Loading destination…')).toBeInTheDocument()
  })
})
