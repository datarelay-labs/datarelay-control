import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UnionSchemaStatusCard } from './union-schema-status-card'
import { buildInitialState } from './wizard-state'

function confirmedState(eventRootPath: string) {
  const state = buildInitialState()
  state.apiTest.status = 'success'
  state.apiTest.ok = true
  state.apiTest.parsedJson = { items: [{ id: 'a', owner: { name: 'x' } }] }
  state.apiTest.rawResponse = state.apiTest.parsedJson
  state.apiTest.finishedAt = 1_000
  state.stream.eventArrayPath = '$.items'
  state.stream.eventRootPath = eventRootPath
  state.stream.recordPathConfirmedForApiTestAt = 1_000
  state.stream.eventRootConfirmedForApiTestAt = 1_000
  return state
}

describe('UnionSchemaStatusCard terminal states (F-008)', () => {
  it('reaches a terminal empty state with a reason instead of generating forever', () => {
    render(<UnionSchemaStatusCard state={confirmedState('$.owner')} extractedEventCount={0} />)
    const empty = screen.getByTestId('union-schema-status-empty')
    expect(empty).toHaveTextContent('No records extracted')
    expect(empty).toHaveTextContent('Reset Event root')
    expect(screen.queryByText(/Generating Union Schema/)).toBeNull()
  })

  it('does not claim an empty result before the selections are confirmed', () => {
    const state = confirmedState('$.owner')
    state.stream.eventRootConfirmedForApiTestAt = null
    render(<UnionSchemaStatusCard state={state} extractedEventCount={0} />)
    expect(screen.queryByTestId('union-schema-status-empty')).toBeNull()
  })

  it('does not show the empty state while records are being extracted', () => {
    render(<UnionSchemaStatusCard state={confirmedState('')} extractedEventCount={1} />)
    expect(screen.queryByTestId('union-schema-status-empty')).toBeNull()
  })
})
