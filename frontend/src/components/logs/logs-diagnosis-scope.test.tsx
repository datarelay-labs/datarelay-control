import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LogsDiagnosisOverview } from './logs-diagnosis-overview'
import { buildLogsDiagnosisSnapshot } from './logs-diagnosis-snapshot'

const emptySample = {
  loadedFailedDeliveries: 0,
  loadedSuccessfulDeliveries: 0,
  errorRows: 0,
  warningRows: 0,
  loadedRows: 0,
  lifecycleRows: null,
  windowLabel: '1h',
}

// F-161: the platform-wide observability totals reported 22 failed deliveries and were shown as the
// posture of a Stream that had none, because the active Stream filter was ignored.
describe('Logs diagnosis posture honours the active filter (F-161)', () => {
  it('does not show platform-wide failures for a scoped stream without failures', () => {
    const snapshot = buildLogsDiagnosisSnapshot({
      ...emptySample,
      loadedSuccessfulDeliveries: 3,
      loadedRows: 3,
      globalFailed: 22,
      globalSuccess: 400,
      scoped: true,
    })
    expect(snapshot.globalFailed).toBeNull()
    expect(snapshot.globalSuccess).toBeNull()
    render(<LogsDiagnosisOverview snapshot={snapshot} />)
    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Clear')
    expect(screen.getByTestId('logs-diagnosis-summary')).not.toHaveTextContent('22')
    expect(screen.getByTestId('logs-diagnosis-window-hint')).toHaveTextContent('Scoped to the active filter')
  })

  it('a scoped view without delivery evidence is Not verified, never Needs diagnosis from other streams', () => {
    const snapshot = buildLogsDiagnosisSnapshot({ ...emptySample, globalFailed: 22, globalSuccess: 400, scoped: true })
    render(<LogsDiagnosisOverview snapshot={snapshot} />)
    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Not verified')
  })

  it('an unscoped view keeps the full-window totals', () => {
    const snapshot = buildLogsDiagnosisSnapshot({ ...emptySample, globalFailed: 22, globalSuccess: 400, scoped: false })
    expect(snapshot.globalFailed).toBe(22)
    render(<LogsDiagnosisOverview snapshot={snapshot} />)
    expect(screen.getByTestId('logs-diagnosis-summary')).toHaveTextContent('22 failed delivery events in the full 1h window')
  })

  it('a scoped view still reports failures found in its own loaded sample', () => {
    const snapshot = buildLogsDiagnosisSnapshot({
      ...emptySample,
      loadedFailedDeliveries: 2,
      loadedRows: 2,
      globalFailed: 22,
      globalSuccess: 400,
      scoped: true,
    })
    render(<LogsDiagnosisOverview snapshot={snapshot} />)
    expect(screen.getByTestId('logs-diagnosis-posture')).toHaveTextContent('Needs recovery')
  })
})
