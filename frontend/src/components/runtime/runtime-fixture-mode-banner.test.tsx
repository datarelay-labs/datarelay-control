import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtureMode = vi.hoisted(() => ({
  policyGranted: true,
  active: false,
  optIn: false,
}))

vi.mock('../../api/operationalSnapshot', () => ({
  clearOperationalSnapshotCache: vi.fn(),
}))

vi.mock('../../lib/runtime-operational-fixture-mode', () => ({
  DEFAULT_RUNTIME_FIXTURE_FILE: 'runtime-operational-snapshot-320x120.json',
  disableRuntimeFixtureMode: vi.fn(),
  enableRuntimeFixtureMode: vi.fn(),
  getRuntimeFixtureFileName: () => 'runtime-operational-snapshot-320x120.json',
  hasRuntimeFixtureUserOptIn: () => fixtureMode.optIn,
  isRuntimeFixtureModeActive: async () => fixtureMode.active,
  isRuntimeFixturePolicyGranted: async () => fixtureMode.policyGranted,
  loadOperationalSnapshotFixture: async () => ({}),
  summarizeRuntimeFixture: (_snapshot: unknown, fileName: string) => ({
    fileName,
    streamCount: 320,
    routeCount: 120,
    destinationCount: 4,
  }),
  syncRuntimeFixtureModeFromSearchParams: async () => undefined,
}))

import { RuntimeFixtureModeBanner } from './runtime-fixture-mode-banner'

function renderBanner() {
  render(
    <MemoryRouter>
      <RuntimeFixtureModeBanner surface="dashboard" />
    </MemoryRouter>,
  )
}

describe('RuntimeFixtureModeBanner', () => {
  beforeEach(() => {
    fixtureMode.policyGranted = true
    fixtureMode.active = false
    fixtureMode.optIn = false
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the inactive admin tooling as a collapsed one-line disclosure', async () => {
    renderBanner()
    const panel = await screen.findByTestId('runtime-fixture-mode-admin-panel')
    expect(panel.tagName).toBe('DETAILS')
    expect(panel).not.toHaveAttribute('open')
    expect(panel.querySelector('summary')).toHaveTextContent('Developer tools: runtime fixture mode')
    // The enable control stays in the DOM inside the disclosure.
    const enable = screen.getByTestId('runtime-fixture-mode-enable')
    expect(panel).toContainElement(enable)
    expect(enable).toHaveTextContent('Enable fixture mode')
    expect(panel).toHaveTextContent('Runtime fixture mode (admin / dev-validation)')
  })

  it('keeps the active fixture warning as a prominent alert', async () => {
    fixtureMode.active = true
    fixtureMode.optIn = true
    renderBanner()
    const banner = await screen.findByTestId('runtime-fixture-mode-active-banner')
    expect(banner.tagName).toBe('DIV')
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveTextContent('DEV FIXTURE MODE ACTIVE')
    expect(screen.getByTestId('runtime-fixture-mode-disable')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-fixture-mode-admin-panel')).not.toBeInTheDocument()
  })

  it('renders nothing without the fixture policy grant', async () => {
    fixtureMode.policyGranted = false
    renderBanner()
    await Promise.resolve()
    expect(screen.queryByTestId('runtime-fixture-mode-admin-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-fixture-mode-active-banner')).not.toBeInTheDocument()
  })
})
