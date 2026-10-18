import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildInitialState, DEFAULT_ROUTE_PROCESSING_INHERIT, type WizardRouteDraft } from '../wizard/wizard-state'
import { WizardSharedRuleImpact } from './wizard-shared-rule-impact'

function route(key: string, destinationId: number, shared = true): WizardRouteDraft {
  return { key, destinationId, enabled: true, failurePolicy: 'LOG_AND_CONTINUE', rateLimitJson: {},
    inherit: { ...DEFAULT_ROUTE_PROCESSING_INHERIT, transform: shared } }
}
const destinations = [{ id: 1, name: 'Internal SIEM' }, { id: 2, name: 'External endpoint' }]

describe('M3-08 shared-rule impact uses existing Route intent', () => {
  it('distinguishes shared rules from destination-specific rules without claiming an apply', () => {
    render(<WizardSharedRuleImpact routes={[route('a', 1), route('b', 2, false)]}
      destinations={destinations} dataProtection={buildInitialState().dataProtection} concern="transform" />)
    fireEvent.click(screen.getByText('Review impact on 2 Routes'))
    const table = screen.getByRole('table', { name: 'Shared rule impact by Route' })
    expect(within(table).getByRole('row', { name: /Internal SIEM/ })).toHaveTextContent('Uses shared rules')
    expect(within(table).getByRole('row', { name: /External endpoint/ })).toHaveTextContent('Customized for this destination')
    expect(screen.getByText(/Draft configuration only/)).toBeInTheDocument()
    expect(screen.queryByText(/Applied to/)).not.toBeInTheDocument()
  })

  it('retains per-field override truth even when the general inherit flag is enabled', () => {
    const protection = buildInitialState().dataProtection
    protection.routeOverrides = [{ key: 'override-email', routeDraftKey: 'a', fieldPath: 'email',
      protectionAction: 'mask_full', deliveryBehavior: 'continue', enabled: true }]
    render(<WizardSharedRuleImpact routes={[route('a', 1)]} destinations={destinations}
      dataProtection={protection} concern="data_protection" />)
    fireEvent.click(screen.getByText('Review impact on 1 Route'))
    const table = screen.getByRole('table', { name: 'Shared rule impact by Route' })
    expect(table).toHaveTextContent('Customized for this destination')
    expect(screen.getByText(/Shared and field-customized rules require a Route preview/)).toBeInTheDocument()
  })

  it('does not call unloaded governance rules shared or verified', () => {
    const draft = route('a', 1)
    draft.governanceLoad = { protection: 'unavailable', classification: 'unloaded', policy: 'passthrough' }
    render(<WizardSharedRuleImpact routes={[draft]} destinations={destinations}
      dataProtection={buildInitialState().dataProtection} concern="data_protection" />)
    fireEvent.click(screen.getByText('Review impact on 1 Route'))
    expect(screen.getAllByText('Not verified')).toHaveLength(3)
    expect(screen.queryByText('Uses shared rules')).not.toBeInTheDocument()
  })

  it('selects the existing draft Route without changing configuration', () => {
    const select = vi.fn()
    const draft = Object.freeze(route('stable-b', 2, false))
    render(<WizardSharedRuleImpact routes={[draft]} destinations={destinations}
      dataProtection={buildInitialState().dataProtection} concern="transform" onSelectRoute={select} />)
    fireEvent.click(screen.getByText('Review impact on 1 Route'))
    fireEvent.click(screen.getByRole('button', { name: 'Review External endpoint' }))
    expect(select).toHaveBeenCalledWith('stable-b')
    expect(draft.inherit.transform).toBe(false)
  })

  it('keeps disabled Routes in configuration impact but labels them disabled', () => {
    const draft = { ...route('a', 1), enabled: false }
    render(<WizardSharedRuleImpact routes={[draft]} destinations={destinations}
      dataProtection={buildInitialState().dataProtection} concern="transform" />)
    fireEvent.click(screen.getByText('Review impact on 1 Route'))
    expect(screen.getByRole('table')).toHaveTextContent('Disabled')
    expect(screen.getByRole('table')).toHaveTextContent('Uses shared rules')
  })

  it('bounds a large impact table and retains the complete scope count', () => {
    const routes = Array.from({ length: 120 }, (_, index) => route(`r-${index}`, index + 1))
    render(<WizardSharedRuleImpact routes={routes} destinations={[]} dataProtection={buildInitialState().dataProtection} concern="transform" />)
    fireEvent.click(screen.getByText('Review impact on 120 Routes'))
    expect(screen.getByText('Showing 100 of 120 Routes.')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(101)
  })
})
