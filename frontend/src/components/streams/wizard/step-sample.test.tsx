import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { StepSample } from './step-sample'
import { buildInitialState } from './wizard-state'

describe('StepSample UX simplification', () => {
  it('supports Arrow/Home/End tab navigation with linked tabpanel semantics', () => {
    render(
      <MemoryRouter>
        <StepSample
          state={buildInitialState()}
          onApiTestChange={vi.fn()}
          onStreamPatch={vi.fn()}
          onSetEventArrayPath={vi.fn()}
          onSetEventRootPath={vi.fn()}
          onSetCheckpoint={vi.fn()}
        />
      </MemoryRouter>,
    )

    const runTest = screen.getByTestId('wizard-sample-tab-run_test')
    const records = screen.getByTestId('wizard-sample-tab-record_selection')
    expect(screen.getByTestId('wizard-sample-tabs')).toHaveAttribute('role', 'tablist')
    expect(runTest).toHaveAttribute('tabindex', '0')
    expect(records).toHaveAttribute('tabindex', '-1')

    runTest.focus()
    fireEvent.keyDown(runTest, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(records)
    expect(records).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'wizard-sample-tab-record_selection')

    fireEvent.keyDown(records, { key: 'Home' })
    expect(document.activeElement).toBe(runTest)
    expect(runTest).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(runTest, { key: 'End' })
    expect(document.activeElement).toBe(records)
  })

  it('shows Run Test and Record Selection tabs only', () => {
    render(
      <MemoryRouter>
        <StepSample
          state={buildInitialState()}
          onApiTestChange={vi.fn()}
          onStreamPatch={vi.fn()}
          onSetEventArrayPath={vi.fn()}
          onSetEventRootPath={vi.fn()}
          onSetCheckpoint={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-sample-tab-run_test')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-sample-tab-record_selection')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-sample-tab-response')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-sample-tab-record_path')).not.toBeInTheDocument()
  })
})
