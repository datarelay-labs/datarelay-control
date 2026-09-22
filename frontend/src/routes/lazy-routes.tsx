import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { RoutePageFallback } from '../components/layout/route-page-fallback'
import { lazyWithChunkRetry } from '../lib/lazy-with-chunk-retry'

function lazyNamed<T extends Record<string, ComponentType<unknown>>, K extends keyof T>(
  factory: () => Promise<T>,
  exportName: K,
) {
  return lazy(
    lazyWithChunkRetry(() =>
      factory().then((module) => ({ default: module[exportName] as ComponentType<unknown> })),
    ),
  )
}

function suspend<P extends object>(Lazy: LazyExoticComponent<ComponentType<P>>): ComponentType<P> {
  function SuspendedLazy(props: P) {
    return (
      <Suspense fallback={<RoutePageFallback />}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return SuspendedLazy
}

// Stream wizard
export const LazyNewStreamWizardPage = suspend(
  lazyNamed(() => import('../components/streams/new-stream-wizard-page'), 'NewStreamWizardPage'),
)

// Dashboard
export const LazyDashboardOverview = suspend(
  lazyNamed(() => import('../components/dashboard/dashboard-overview'), 'DashboardOverview'),
)

// Stream runtime detail
export const LazyStreamRuntimeDetailPage = suspend(
  lazyNamed(() => import('../components/streams/stream-runtime-detail-page'), 'StreamRuntimeDetailPage'),
)

// Logs
export const LazyLogsExplorerPage = suspend(
  lazyNamed(() => import('../components/logs/logs-explorer-page'), 'LogsExplorerPage'),
)

// Routes & destinations
export const LazyDestinationsManagementPage = suspend(
  lazyNamed(() => import('../components/destinations/destinations-management-page'), 'DestinationsManagementPage'),
)
export const LazyDestinationDetailPage = suspend(
  lazyNamed(() => import('../components/destinations/destination-detail-page'), 'DestinationDetailPage'),
)
export const LazyRoutesOverviewPage = suspend(
  lazyNamed(() => import('../components/routes/routes-overview-page'), 'RoutesOverviewPage'),
)
export const LazyRouteEditPage = suspend(
  lazyNamed(() => import('../components/routes/route-edit-page'), 'RouteEditPage'),
)

// Governance
export const LazyGovernanceShell = suspend(
  lazyNamed(() => import('../components/governance/governance-shell'), 'GovernanceShell'),
)
export const LazyGovernanceDashboardPage = suspend(
  lazyNamed(() => import('../components/governance/governance-dashboard-page'), 'GovernanceDashboardPage'),
)
export const LazyOperationsCenterPage = suspend(
  lazyNamed(() => import('../components/governance/operations-center-page'), 'OperationsCenterPage'),
)
export const LazyGovernanceDataProtectionHubPage = suspend(
  lazyNamed(
    () => import('../components/governance/governance-section-hub-pages'),
    'GovernanceDataProtectionHubPage',
  ),
)
export const LazyViolationCenterPage = suspend(
  lazyNamed(() => import('../components/governance/violation-center-page'), 'ViolationCenterPage'),
)
export const LazyQuarantineCenterPage = suspend(
  lazyNamed(() => import('../components/governance/quarantine-center-page'), 'QuarantineCenterPage'),
)
export const LazyAuditTrailPage = suspend(
  lazyNamed(() => import('../components/governance/audit-trail-page'), 'AuditTrailPage'),
)
export const LazyApprovalWorkflowPage = suspend(
  lazyNamed(() => import('../components/governance/approval-workflow-page'), 'ApprovalWorkflowPage'),
)
export const LazyReplayCenterPage = suspend(
  lazyNamed(() => import('../components/governance/replay-center-page'), 'ReplayCenterPage'),
)
export const LazyNotificationsPage = suspend(
  lazyNamed(() => import('../components/governance/notifications-page'), 'NotificationsPage'),
)
export const LazyGovernanceWorkspacePage = suspend(
  lazyNamed(() => import('../components/governance/governance-workspace-page'), 'GovernanceWorkspacePage'),
)

// Administration & settings
export const LazySettingsOverviewPage = suspend(
  lazyNamed(() => import('../components/settings/settings-overview-page'), 'SettingsOverviewPage'),
)
export const LazyAdministrationHubPage = suspend(
  lazyNamed(() => import('../components/administration/administration-hub-page'), 'AdministrationHubPage'),
)
export const LazyConnectorCatalogPage = suspend(
  lazyNamed(() => import('../components/administration/connector-catalog-page'), 'ConnectorCatalogPage'),
)
export const LazyAuditLogsPage = suspend(
  lazyNamed(() => import('../components/settings/audit-logs-page'), 'AuditLogsPage'),
)
export const LazyOperationsBackupPage = suspend(
  lazyNamed(() => import('../components/operations/operations-backup-page'), 'OperationsBackupPage'),
)
export const LazyAdminSettingsPage = suspend(
  lazyNamed(() => import('../components/settings/admin-settings-page'), 'AdminSettingsPage'),
)

// Streams (eager → lazy) — module also exports non-component helpers; use explicit pick
export const LazyStreamsConsole = suspend(
  lazy(
    lazyWithChunkRetry(() =>
      import('../components/streams/streams-console').then((module) => ({
        default: module.StreamsConsole,
      })),
    ),
  ),
)
export const LazyStreamEditPage = suspend(
  lazyNamed(() => import('../components/streams/stream-edit-wizard-page'), 'StreamEditWizardPage'),
)
export const LazyStreamMappingPage = suspend(
  lazyNamed(() => import('../components/streams/stream-mapping-page'), 'StreamMappingPage'),
)
export const LazyStreamApiTestPage = suspend(
  lazyNamed(() => import('../components/streams/stream-api-test-page'), 'StreamApiTestPage'),
)
export const LazyStreamEnrichmentPage = suspend(
  lazyNamed(() => import('../components/streams/stream-enrichment-page'), 'StreamEnrichmentPage'),
)

// Connectors (eager → lazy)
export const LazyConnectorsOverviewPage = suspend(
  lazyNamed(() => import('../components/connectors/connectors-overview-page'), 'ConnectorsOverviewPage'),
)
export const LazyConnectorDetailPage = suspend(
  lazyNamed(() => import('../components/connectors/connector-detail-page'), 'ConnectorDetailPage'),
)
export const LazyNewConnectorWizardPage = suspend(
  lazyNamed(() => import('../components/connectors/new-connector-wizard-page'), 'NewConnectorWizardPage'),
)

// Mappings (eager → lazy)
export const LazyMappingsOverviewPage = suspend(
  lazyNamed(() => import('../components/mappings/mappings-overview-page'), 'MappingsOverviewPage'),
)
export const LazyMappingEditPage = suspend(
  lazyNamed(() => import('../components/mappings/mapping-edit-page'), 'MappingEditPage'),
)

// Templates (eager → lazy)
export const LazyTemplatesOverviewPage = suspend(
  lazyNamed(() => import('../components/templates/templates-overview-page'), 'TemplatesOverviewPage'),
)

// Validation (eager → lazy)
export const LazyValidationShell = suspend(
  lazyNamed(() => import('../components/validation/validation-shell'), 'ValidationShell'),
)
export const LazyValidationOverviewPage = suspend(
  lazyNamed(() => import('../components/validation/validation-overview-page'), 'ValidationOverviewPage'),
)
export const LazyValidationRunsPage = suspend(
  lazyNamed(() => import('../components/validation/validation-runs-page'), 'ValidationRunsPage'),
)
export const LazyValidationFailingPage = suspend(
  lazyNamed(() => import('../components/validation/validation-failing-page'), 'ValidationFailingPage'),
)
export const LazyValidationAuthPage = suspend(
  lazyNamed(() => import('../components/validation/validation-auth-page'), 'ValidationAuthPage'),
)
export const LazyValidationDeliveryPage = suspend(
  lazyNamed(() => import('../components/validation/validation-delivery-page'), 'ValidationDeliveryPage'),
)
export const LazyValidationAlertsPage = suspend(
  lazyNamed(() => import('../components/validation/validation-alerts-page'), 'ValidationAlertsPage'),
)
export const LazyValidationCheckpointPage = suspend(
  lazyNamed(() => import('../components/validation/validation-checkpoint-page'), 'ValidationCheckpointPage'),
)
