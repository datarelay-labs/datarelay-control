import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CapacityCell } from './destination-mini-charts'

describe('Destination capacity evidence truth', () => {
  it('keeps unavailable current EPS distinct from an observed zero EPS', () => {
    const unavailable = render(<CapacityCell currentEps={null} capacityLimitEps={100} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
    unavailable.unmount()

    render(<CapacityCell currentEps={0} capacityLimitEps={100} />)
    expect(screen.getByText('0%')).toBeInTheDocument()
  })
})
