import type { LucideIcon } from 'lucide-react'
import { Cable, Database, Home, LayoutDashboard, Route, Settings, Shield, Truck, Workflow } from 'lucide-react'

/** Primary sidebar leaf keys (DATA-RELAY-UX-CHARTER navigation). */
export type SidebarNavKey =
  | 'dashboard'
  | 'connectors'
  | 'streams'
  | 'destinations'
  | 'routes'
  | 'governance'
  | 'governanceWorkspace'
  | 'administration'

export type SidebarGroupId = 'dataSources' | 'delivery' | 'governance'

/** All routable workspace keys (includes legacy + in-page governance/admin sections). */
export type AppNavKey =
  | SidebarNavKey
  | 'logs'
  | 'alerts'
  | 'mappings'
  | 'runtime'
  | 'topology'
  | 'analytics'
  | 'aiGateway'
  | 'aiGatewayProviders'
  | 'aiGatewayStreams'
  | 'aiGatewayTraffic'
  | 'aiGatewayGovernance'
  | 'validation'
  | 'templates'
  | 'connectorCatalog'
  | 'backup'
  | 'settings'
  | 'governanceDataProtection'
  | 'governanceOperations'
  | 'governanceViolations'
  | 'governanceQuarantine'
  | 'governanceAudit'
  | 'governanceApprovals'
  | 'governanceReplay'
  | 'governanceNotifications'
  | 'governanceWorkspace'
  /** @deprecated Use dashboard — kept for path helpers during migration. */
  | 'monitoring'

export type SidebarTopItem = {
  key: SidebarNavKey
  label: string
  path: string
  icon: LucideIcon
}

export type SidebarGroupItem = {
  id: SidebarGroupId
  label: string
  icon: LucideIcon
  items: readonly SidebarTopItem[]
}

export type SidebarNavEntry =
  | { type: 'item'; item: SidebarTopItem }
  | { type: 'group'; group: SidebarGroupItem }

const DASHBOARD_ITEM: SidebarTopItem = {
  key: 'dashboard',
  label: 'Dashboard',
  path: '/monitoring',
  icon: Home,
}

const DATA_SOURCES_GROUP: SidebarGroupItem = {
  id: 'dataSources',
  label: 'Data Sources',
  icon: Cable,
  items: [
    { key: 'connectors', label: 'Connectors', path: '/connectors', icon: Cable },
    { key: 'streams', label: 'Streams', path: '/streams', icon: Workflow },
  ],
}

const DELIVERY_GROUP: SidebarGroupItem = {
  id: 'delivery',
  label: 'Delivery',
  icon: Truck,
  items: [
    { key: 'destinations', label: 'Destinations', path: '/destinations', icon: Database },
    { key: 'routes', label: 'Routes', path: '/routes', icon: Route },
  ],
}

const GOVERNANCE_GROUP: SidebarGroupItem = {
  id: 'governance',
  label: 'Governance',
  icon: Shield,
  items: [
    { key: 'governance', label: 'Dashboard', path: '/governance', icon: LayoutDashboard },
    { key: 'governanceWorkspace', label: 'Governance Workspace', path: '/governance/workspace', icon: Shield },
  ],
}

const ADMINISTRATION_ITEM: SidebarTopItem = {
  key: 'administration',
  label: 'Administration',
  path: '/admin',
  icon: Settings,
}

/** Grouped sidebar structure (DATA-RELAY-UX-CHARTER). */
export const SIDEBAR_STRUCTURE: readonly SidebarNavEntry[] = [
  { type: 'item', item: DASHBOARD_ITEM },
  { type: 'group', group: DATA_SOURCES_GROUP },
  { type: 'group', group: DELIVERY_GROUP },
  { type: 'group', group: GOVERNANCE_GROUP },
  { type: 'item', item: ADMINISTRATION_ITEM },
] as const

/** @deprecated Use SIDEBAR_STRUCTURE. Flat list for tests and gradual migration. */
export const SIDEBAR_TOP_ITEMS: readonly SidebarTopItem[] = [
  DASHBOARD_ITEM,
  ...DATA_SOURCES_GROUP.items,
  ...DELIVERY_GROUP.items,
  ...GOVERNANCE_GROUP.items,
  ADMINISTRATION_ITEM,
] as const

export function sidebarStructureForRole(canViewGovernance: boolean): readonly SidebarNavEntry[] {
  if (canViewGovernance) return SIDEBAR_STRUCTURE
  return SIDEBAR_STRUCTURE.filter((entry) => entry.type !== 'group' || entry.group.id !== 'governance')
}

/** @deprecated Use sidebarStructureForRole. */
export function sidebarItemsForRole(canViewGovernance: boolean): readonly SidebarTopItem[] {
  return sidebarStructureForRole(canViewGovernance).flatMap((entry) =>
    entry.type === 'item' ? [entry.item] : [...entry.group.items],
  )
}

/** @deprecated M17.4 persona split — use {@link sidebarStructureForRole} (M20 RBAC). */
export function sidebarItemsForPersona(isGovernance: boolean): readonly SidebarTopItem[] {
  return sidebarItemsForRole(isGovernance)
}

/** @deprecated M17.1 — use SIDEBAR_STRUCTURE. */
export type SidebarLeafItem = {
  key: AppNavKey
  label: string
  path: string
}

export const PAGE_TITLE: Record<AppNavKey, string> = {
  dashboard: 'Dashboard',
  monitoring: 'Dashboard',
  streams: 'Streams',
  logs: 'Logs',
  alerts: 'Operational alerts',
  governance: 'Governance',
  administration: 'Administration',
  connectors: 'Connectors',
  mappings: 'Mappings',
  destinations: 'Destinations',
  routes: 'Routes',
  runtime: 'Runtime overview',
  topology: 'Topology',
  analytics: 'Delivery Analytics',
  aiGateway: 'AI Governance',
  aiGatewayProviders: 'AI Providers',
  aiGatewayStreams: 'AI Streams',
  aiGatewayTraffic: 'AI Traffic',
  aiGatewayGovernance: 'AI Governance',
  governanceDataProtection: 'Data Protection',
  governanceOperations: 'Governance Operations',
  governanceViolations: 'Violation Center',
  governanceQuarantine: 'Quarantine',
  governanceAudit: 'Audit',
  governanceApprovals: 'Approvals',
  governanceReplay: 'Replay',
  governanceNotifications: 'Notifications',
  governanceWorkspace: 'Governance Workspace',
  validation: 'Runtime health checks',
  templates: 'Templates',
  connectorCatalog: 'Connector Catalog',
  backup: 'Backup & Import',
  settings: 'Settings',
}
