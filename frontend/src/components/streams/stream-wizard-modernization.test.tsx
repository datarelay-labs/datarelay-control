import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NewStreamWizardPage } from './new-stream-wizard-page'
import { WIZARD_STAGE_PURPOSE } from './wizard/wizard-stage-guidance'

vi.mock('../../api/gdcStreams', () => ({
  createStream: vi.fn(),
}))

vi.mock('../../api/gdcRuntimeUi', () => ({
  saveStreamMappingUiConfigStrict: vi.fn(),
}))

vi.mock('../../api/gdcRoutes', () => ({
  createRoute: vi.fn(),
}))

vi.mock('../../api/gdcRuntime', () => ({
  startRuntimeStream: vi.fn(),
}))

vi.mock('../../api/gdcCatalog', () => ({
  fetchCatalogSnapshot: vi.fn(async () => ({ connectors: [], sources: [], apiBacked: false })),
}))

vi.mock('../../api/gdcConnectors', () => ({
  fetchConnectorsList: vi.fn(async () => []),
  fetchConnectorById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcSources', () => ({
  fetchSourceById: vi.fn(async () => null),
}))

vi.mock('../../api/gdcDestinations', () => ({
  fetchDestinationsList: vi.fn(async () => []),
}))

describe('Stream Wizard SaaS modernization', () => {
  it('keeps App Shell title ownership and shows the current-stage operator question', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')
    localStorage.removeItem('gdc-stream-wizard-draft-v1')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('new-stream-wizard')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Stream Onboarding Wizard' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Connect → Sample/)).not.toBeInTheDocument()
    expect(screen.getByTestId('wizard-stage-purpose')).toHaveTextContent(WIZARD_STAGE_PURPOSE.connect)
  })

  it('renders a readable five-stage stepper with primary Next action hierarchy', () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    const stepper = screen.getByTestId('wizard-stepper')
    expect(stepper.textContent).toContain('Connect')
    expect(stepper.textContent).toContain('Sample & Record Selection')
    expect(stepper.textContent).toContain('Destinations')
    expect(stepper.textContent).toContain('Route Processing')
    expect(stepper.textContent).toContain('Deploy')
    expect(screen.getByTestId('wizard-stepper-connect')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('wizard-action-bar')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-next')).toHaveTextContent('Next: Sample & Record Selection')
  })

  it('demotes Advanced Settings relative to required Connect tabs', async () => {
    localStorage.setItem('gdc-platform-persona', 'connector')
    localStorage.removeItem('gdc-stream-wizard-draft-v2')
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/streams/new']}>
        <NewStreamWizardPage />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('wizard-connect-tab-connector')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-request')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-tab-advanced')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard-connect-advanced-panel')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('wizard-connect-tab-advanced'))
    expect(screen.getByTestId('wizard-connect-advanced-panel')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-connect-advanced-panel')).toHaveTextContent(/Optional pagination/i)
  })
})
