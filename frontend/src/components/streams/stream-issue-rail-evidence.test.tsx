import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StreamIssueRail } from './stream-issue-rail'
import type { StreamIssueContext } from '../../lib/stream-issue-context'

const baseline: StreamIssueContext = {
  id: '42',
  status: 'RUNNING',
  connectorName: 'Webhook',
  deliveryPctKnown: false,
  deliveryPct: 0,
  routesError: 0,
  lastActivityRelative: 'Unverified',
  recentErrors: [],
}

function panel(ctx: StreamIssueContext = baseline) {
  render(
    <MemoryRouter>
      <StreamIssueRail
        ctx={ctx}
        numericId={42}
        controlBusy={false}
        runOnceBusy={false}
        onRunOnce={vi.fn()}
        onStop={vi.fn()}
      />
    </MemoryRouter>,
  )
  return screen.getByTestId('stream-issue-rail')
}

describe('Stream Issue Rail evidence and lifecycle', () => {
  it('does not style missing delivery evidence as a healthy green state', () => {
    const root = panel()
    expect(root).toHaveTextContent('Not verified')
    expect(root).toHaveTextContent('Delivery outcomes not verified in loaded runtime evidence.')
    expect(root).not.toHaveTextContent('No active issues')
    expect(screen.getByText('Not verified').className).not.toMatch(/emerald/)
    expect(screen.getByText('RUNNING').className).not.toMatch(/emerald/)
  })

  it('keeps STOPPED visible neutrally and never reports Healthy', () => {
    const root = panel({ ...baseline, status: 'STOPPED', deliveryPctKnown: true, deliveryPct: 99 })
    expect(root).toHaveTextContent('Stopped')
    expect(root).not.toHaveTextContent('Healthy')
    expect(screen.getByText('STOPPED').className).not.toMatch(/emerald/)
  })

  it('uses a warning tone for a verified low delivery rate even if the lifecycle is running', () => {
    const root = panel({ ...baseline, deliveryPctKnown: true, deliveryPct: 80 })
    expect(root).toHaveTextContent('Low success rate')
    expect(screen.getByText('Low success rate').className).toMatch(/amber/)
    expect(root).not.toHaveTextContent('No active issues')
  })
})
