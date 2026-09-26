import { describe, expect, it } from 'vitest'
import { appNavKeyFromPathname, governanceWorkspacePath, legacyRuntimeRedirectTarget, NAV_PATH, runtimeOverviewPath, streamsExpandedGroupPath } from './nav-paths'

describe('nav-paths M17.1', () => {
  it('maps templates to templates nav key under Streams IA', () => {
    expect(appNavKeyFromPathname('/templates')).toBe('templates')
    expect(appNavKeyFromPathname('/streams')).toBe('streams')
  })

  it('maps canonical dashboard and legacy runtime paths to dashboard nav key', () => {
    expect(appNavKeyFromPathname('/monitoring')).toBe('dashboard')
    expect(appNavKeyFromPathname('/runtime')).toBe('dashboard')
    expect(appNavKeyFromPathname('/runtime/topology')).toBe('dashboard')
    expect(appNavKeyFromPathname('/monitoring/analytics')).toBe('dashboard')
    expect(appNavKeyFromPathname('/')).toBe('dashboard')
  })

  it('maps data sources and delivery paths to their nav keys', () => {
    expect(appNavKeyFromPathname('/connectors')).toBe('connectors')
    expect(appNavKeyFromPathname('/destinations')).toBe('destinations')
    expect(appNavKeyFromPathname('/routes')).toBe('routes')
  })

  it('maps administration enclave paths', () => {
    expect(appNavKeyFromPathname('/admin')).toBe('administration')
    expect(appNavKeyFromPathname('/settings')).toBe('settings')
    expect(appNavKeyFromPathname('/validation')).toBe('validation')
  })

  it('maps governance sub-routes', () => {
    expect(appNavKeyFromPathname('/governance')).toBe('governance')
    expect(appNavKeyFromPathname('/governance/workspace')).toBe('governanceWorkspace')
    expect(appNavKeyFromPathname('/governance/data-protection')).toBe('governanceDataProtection')
  })

  it('provides legacy runtime redirect targets', () => {
    expect(legacyRuntimeRedirectTarget('/runtime', '?stream_id=1', '')).toBe('/monitoring?stream_id=1')
    expect(legacyRuntimeRedirectTarget('/runtime/topology', '', '#x')).toBe('/monitoring#x')
    expect(legacyRuntimeRedirectTarget('/runtime/ai-gateway', '', '')).toBe('/streams')
    expect(legacyRuntimeRedirectTarget('/streams', '', '')).toBeNull()
  })

  it('uses /monitoring/streams for runtimeOverviewPath', () => {
    expect(runtimeOverviewPath({ stream_id: 3 })).toBe('/monitoring/streams?stream_id=3')
    expect(NAV_PATH.dashboard).toBe('/monitoring')
  })

  it('builds streams path with expand_group for dashboard drill-down', () => {
    expect(streamsExpandedGroupPath('Payment API')).toBe('/streams?expand_group=Payment+API')
    expect(streamsExpandedGroupPath('')).toBe('/streams')
  })

  it('builds governance workspace context paths', () => {
    expect(governanceWorkspacePath()).toBe('/governance/workspace')
    expect(governanceWorkspacePath({ stream_id: 10 })).toBe('/governance/workspace?stream_id=10')
    expect(governanceWorkspacePath({ route_id: 42, stream_id: 10 })).toBe(
      '/governance/workspace?stream_id=10&route_id=42',
    )
    expect(governanceWorkspacePath({ stream_id: 0, route_id: -1 })).toBe('/governance/workspace')
  })
})
