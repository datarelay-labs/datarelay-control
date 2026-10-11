import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LogsDiagnosisOverview, type LogsDiagnosisSnapshot } from './logs-diagnosis-overview'

const emptyEvidence: LogsDiagnosisSnapshot = {
  loadedFailedDeliveries: 0,
  loadedSuccessfulDeliveries: 0,
  errorRows: 0,
  warningRows: 0,
  loadedRows: 0,
  globalFailed: null,
  globalSuccess: null,
  lifecycleRows: null,
  windowLabel: '1h',
}

describe('Logs delivery evidence truth', () => {
  it('does not label unavailable logs and totals as clear or healthy', () => {
    const { container } = render(<LogsDiagnosisOverview snapshot={emptyEvidence} />)

    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Not verified')
    expect(screen.getByTestId('logs-diagnosis-summary')).toHaveTextContent(/no delivery evidence/i)
    expect(container.querySelector('[data-testid="logs-diagnosis-overview"]')).not.toHaveClass('border-emerald-300/80')
  })

  it('does not assert a clear delivery result for known zero totals with unrelated logs', () => {
    render(
      <LogsDiagnosisOverview
        snapshot={{ ...emptyEvidence, loadedRows: 5, globalFailed: 0, globalSuccess: 0, lifecycleRows: 5 }}
      />,
    )

    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Not verified')
    expect(screen.getByTestId('logs-diagnosis-summary')).toHaveTextContent(/no confirmed delivery outcomes/i)
  })

  it('preserves a clear label only when successful delivery is actually recorded', () => {
    render(<LogsDiagnosisOverview snapshot={{ ...emptyEvidence, loadedRows: 1, loadedSuccessfulDeliveries: 1 }} />)

    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Clear')
  })

  it('preserves a warning when actual warning logs exist even without delivery outcomes', () => {
    render(<LogsDiagnosisOverview snapshot={{ ...emptyEvidence, loadedRows: 1, warningRows: 1 }} />)

    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Needs diagnosis')
  })
})
