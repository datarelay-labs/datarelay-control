import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchStreamMappingUiConfig = vi.fn()
const fetchRoutesList = vi.fn()
const fetchDestinationsList = vi.fn()

vi.mock('../../../api/gdcRuntimeUi', () => ({
  fetchStreamMappingUiConfig: (...args: unknown[]) => fetchStreamMappingUiConfig(...args),
}))

vi.mock('../../../api/gdcRoutes', () => ({
  fetchRoutesList: (...args: unknown[]) => fetchRoutesList(...args),
}))

vi.mock('../../../api/gdcDestinations', () => ({
  fetchDestinationsList: (...args: unknown[]) => fetchDestinationsList(...args),
}))

describe('refreshWizardDestinationsFromStream null catalog', () => {
  beforeEach(() => {
    fetchStreamMappingUiConfig.mockReset()
    fetchRoutesList.mockReset()
    fetchDestinationsList.mockReset()
    fetchStreamMappingUiConfig.mockResolvedValue({ routes: [] })
    fetchDestinationsList.mockResolvedValue([])
  })

  it('returns null when the route list fails instead of treating it as an empty catalog', async () => {
    fetchRoutesList.mockResolvedValue(null)
    const { refreshWizardDestinationsFromStream } = await import('./wizard-stream-hydrate')
    await expect(refreshWizardDestinationsFromStream(9)).resolves.toBeNull()
  })
})
