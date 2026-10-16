import { describe, expect, it } from 'vitest'
import { SIDEBAR_STRUCTURE, sidebarItemsForPersona, sidebarStructureForRole } from './app-navigation'

describe('competitor-informed task-first navigation', () => {
  it('uses Connections, Streams, and Data Flows while retaining the canonical product paths', () => {
    const outline = SIDEBAR_STRUCTURE.map((entry) =>
      entry.type === 'item' ? entry.item.label : entry.group.label,
    )
    expect(outline).toEqual(['Dashboard', 'Connections', 'Streams', 'Data Flows', 'Governance', 'Administration'])
    const connections = SIDEBAR_STRUCTURE[1]
    expect(connections.type).toBe('group')
    if (connections.type !== 'group') throw new Error('Connections navigation group missing')
    expect(connections.group.items.map(({ key, path }) => ({ key, path }))).toEqual([
      { key: 'connectors', path: '/connectors' },
      { key: 'destinations', path: '/destinations' },
    ])
    expect(SIDEBAR_STRUCTURE[2]).toMatchObject({ type: 'item', item: { key: 'streams', path: '/streams' } })
    expect(SIDEBAR_STRUCTURE[3]).toMatchObject({ type: 'item', item: { key: 'routes', label: 'Data Flows', path: '/routes' } })
  })

  it('does not expose the Governance group without current Governance permission', () => {
    const visible = sidebarStructureForRole(false).map((entry) =>
      entry.type === 'item' ? entry.item.label : entry.group.label,
    )
    expect(visible).toEqual(['Dashboard', 'Connections', 'Streams', 'Data Flows', 'Administration'])
  })
})

describe('sidebarStructureForRole (DATA-RELAY-UX-CHARTER)', () => {
  it('hides Governance for connector persona', () => {
    const structure = sidebarStructureForRole(false)
    const keys = structure.flatMap((entry) =>
      entry.type === 'item' ? [entry.item.key] : entry.group.items.map((i) => i.key),
    )
    expect(keys).toEqual(['dashboard', 'connectors', 'destinations', 'streams', 'routes', 'administration'])
  })

  it('shows Dashboard, Connections, Streams, Data Flows, Governance, and Administration for governance persona', () => {
    const structure = sidebarStructureForRole(true)
    const keys = structure.flatMap((entry) =>
      entry.type === 'item' ? [entry.item.key] : entry.group.items.map((i) => i.key),
    )
    expect(keys).toEqual([
      'dashboard',
      'connectors',
      'destinations',
      'streams',
      'routes',
      'governance',
      'administration',
    ])
  })

  it('exposes grouped Connections and Governance sections', () => {
    const groups = SIDEBAR_STRUCTURE.filter((entry) => entry.type === 'group').map((entry) => entry.group.id)
    expect(groups).toEqual(['connections', 'governance'])
    const governance = SIDEBAR_STRUCTURE.find(
      (entry) => entry.type === 'group' && entry.group.id === 'governance',
    )
    expect(governance?.type).toBe('group')
    if (governance?.type !== 'group') throw new Error('Governance group missing')
    expect(governance.group.items).toHaveLength(1)
    expect(governance.group.items[0]).toMatchObject({
      key: 'governance',
      label: 'Governance Dashboard',
      path: '/governance',
    })
  })
})

describe('sidebarItemsForPersona M17.4', () => {
  it('hides Governance for connector persona', () => {
    const items = sidebarItemsForPersona(false)
    expect(items.map((i) => i.key)).toEqual(['dashboard', 'connectors', 'destinations', 'streams', 'routes', 'administration'])
    expect(items).toHaveLength(6)
  })

  it('shows full charter navigation for governance persona', () => {
    const items = sidebarItemsForPersona(true)
    expect(items.map((i) => i.key)).toEqual([
      'dashboard',
      'connectors',
      'destinations',
      'streams',
      'routes',
      'governance',
      'administration',
    ])
    expect(items).toHaveLength(7)
  })
})
