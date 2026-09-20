import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSession } from '../../auth/session'
import {
  disableRuntimeFixtureMode,
  enableRuntimeFixtureMode,
  resetRuntimeFixturePolicyCacheForTests,
} from '../../lib/runtime-operational-fixture-mode'
import testFixture from '../../../public/dev-fixtures/runtime-operational-snapshot-test.json'
import { buildOperationalSnapshotWithStreams } from '../../test/runtime-scale-fixtures'
import { RuntimeOverviewPage } from './runtime-overview-page'

const largeFixture = buildOperationalSnapshotWithStreams(320)

vi.mock('../../api/operationalSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/operationalSnapshot')>()
  return { ...actual }
})

vi.mock('../../api/gdcRuntime', () => ({
  fetchStreamRuntimeMetrics: vi.fn(),
  fetchRuntimeDashboardSummary: vi.fn(),
  fetchRuntimeStatus: vi.fn(),
  fetchRuntimeLogsPage: vi.fn(),
  fetchRuntimeAlertSummary: vi.fn(),
  fetchRuntimeSystemResources: vi.fn(),
  fetchStreamRuntimeStatsHealth: vi.fn(),
  fetchStreamRuntimeStats: vi.fn(),
  startRuntimeStream: vi.fn(),
  stopRuntimeStream: vi.fn(),
  runStreamOnce: vi.fn(),
}))

vi.mock('../../api/observabilitySummary', () => ({
  fetchObservabilitySummary: vi.fn(),
}))

vi.mock('../../api/gdcStreams', () => ({
  fetchStreamsListResult: vi.fn(),
}))

vi.mock('../../auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/session')>()
  return {
    ...actual,
    readSession: vi.fn(),
  }
})

vi.mock('../../api/gdcAdmin', () => ({
  getAdminDevValidationStatus: vi.fn(),
}))

describe('RuntimeOverviewPage fixture mode', () => {
  afterEach(() => {
    disableRuntimeFixtureMode()
    resetRuntimeFixturePolicyCacheForTests()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('renders small fixture without calling operational-snapshot API', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('MODE', 'production')
    vi.mocked(readSession).mockReturnValue({
      access_token: 't',
      refresh_token: 'r',
      expires_at: '2099-01-01T00:00:00Z',
      user: { username: 'admin', role: 'ADMINISTRATOR', status: 'ACTIVE' },
    })
    disableRuntimeFixtureMode()
    enableRuntimeFixtureMode('runtime-operational-snapshot-test.json')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/dev-fixtures/')) {
        return new Response(JSON.stringify(testFixture), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    const rawApi = await import('../../api')
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson')
    const runtime = await import('../../api/gdcRuntime')

    render(
      <MemoryRouter>
        <RuntimeOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByTestId('runtime-stream-flow-grid')).toBeInTheDocument())
    expect(screen.getByText(/All 5/)).toBeInTheDocument()
    expect(screen.getByTestId('runtime-stream-card-1')).toBeInTheDocument()

    expect(apiSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('operational-snapshot'),
      expect.anything(),
    )
    expect(runtime.fetchStreamRuntimeMetrics).not.toHaveBeenCalled()
  })

  it('virtualizes 320-stream fixture without backend snapshot API', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('MODE', 'production')
    vi.mocked(readSession).mockReturnValue({
      access_token: 't',
      refresh_token: 'r',
      expires_at: '2099-01-01T00:00:00Z',
      user: { username: 'admin', role: 'ADMINISTRATOR', status: 'ACTIVE' },
    })
    const { clearOperationalSnapshotCache } = await import('../../api/operationalSnapshot')
    disableRuntimeFixtureMode()
    clearOperationalSnapshotCache()
    enableRuntimeFixtureMode('runtime-operational-snapshot-320x120.json')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('runtime-operational-snapshot-320x120')) {
        return new Response(JSON.stringify(largeFixture), { status: 200 })
      }
      if (url.includes('/dev-fixtures/')) {
        return new Response(JSON.stringify(testFixture), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })

    const rawApi = await import('../../api')
    const apiSpy = vi.spyOn(rawApi, 'safeRequestJson')

    render(
      <MemoryRouter>
        <RuntimeOverviewPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/All 320/)).toBeInTheDocument())
    const cards = screen.queryAllByTestId(/^runtime-stream-card-/)
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.length).toBeLessThan(320)
    expect(apiSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('operational-snapshot'),
      expect.anything(),
    )
  })
})
