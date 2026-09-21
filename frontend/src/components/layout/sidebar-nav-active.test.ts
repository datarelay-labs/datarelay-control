import { describe, expect, it } from 'vitest'
import { isNavKeyActive } from './sidebar-nav-active'

describe('isNavKeyActive', () => {
  it('marks dashboard for monitoring and runtime roots', () => {
    expect(isNavKeyActive('/monitoring', 'dashboard')).toBe(true)
    expect(isNavKeyActive('/monitoring/streams', 'dashboard')).toBe(true)
    expect(isNavKeyActive('/runtime', 'dashboard')).toBe(true)
    expect(isNavKeyActive('/streams', 'dashboard')).toBe(false)
  })

  it('scopes governance dashboard vs workspace', () => {
    expect(isNavKeyActive('/governance', 'governance')).toBe(true)
    expect(isNavKeyActive('/governance/violations', 'governance')).toBe(true)
    expect(isNavKeyActive('/governance/workspace', 'governance')).toBe(false)
    expect(isNavKeyActive('/governance/workspace', 'governanceWorkspace')).toBe(true)
  })

  it('treats validation and settings as administration', () => {
    expect(isNavKeyActive('/validation', 'administration')).toBe(true)
    expect(isNavKeyActive('/validation/alerts', 'administration')).toBe(true)
    expect(isNavKeyActive('/settings', 'administration')).toBe(true)
    expect(isNavKeyActive('/admin', 'administration')).toBe(true)
  })
})
