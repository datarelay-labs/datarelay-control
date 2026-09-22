import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShellLayout, NotFoundPage, PlaceholderPage } from './components/layout/app-shell-layout'
import { PreserveSearchRedirect } from './components/layout/preserve-search-redirect'
import { OssRouteGuard } from './components/oss/oss-route-guard'
import { NAV_PATH } from './config/nav-paths'
import { PAGE_TITLE, type AppNavKey } from './config/app-navigation'
import {
  LazyAdminSettingsPage,
  LazyAdministrationHubPage,
  LazyApprovalWorkflowPage,
  LazyAuditLogsPage,
  LazyAuditTrailPage,
  LazyConnectorCatalogPage,
  LazyConnectorDetailPage,
  LazyConnectorsOverviewPage,
  LazyDashboardOverview,
  LazyDestinationDetailPage,
  LazyDestinationsManagementPage,
  LazyGovernanceDashboardPage,
  LazyGovernanceDataProtectionHubPage,
  LazyGovernanceShell,
  LazyGovernanceWorkspacePage,
  LazyLogsExplorerPage,
  LazyMappingEditPage,
  LazyMappingsOverviewPage,
  LazyNewConnectorWizardPage,
  LazyNewStreamWizardPage,
  LazyNotificationsPage,
  LazyOperationsBackupPage,
  LazyOperationsCenterPage,
  LazyQuarantineCenterPage,
  LazyReplayCenterPage,
  LazyRouteEditPage,
  LazyRoutesOverviewPage,
  LazyStreamApiTestPage,
  LazyStreamEnrichmentPage,
  LazyStreamEditPage,
  LazyStreamMappingPage,
  LazyStreamRuntimeDetailPage,
  LazyStreamsConsole,
  LazyTemplatesOverviewPage,
  LazyValidationAlertsPage,
  LazyValidationAuthPage,
  LazyValidationCheckpointPage,
  LazyValidationDeliveryPage,
  LazyValidationFailingPage,
  LazyValidationOverviewPage,
  LazyValidationRunsPage,
  LazyValidationShell,
  LazyViolationCenterPage,
} from './routes/lazy-routes'

const PLACEHOLDER_NAV_KEYS: AppNavKey[] = []

import { DisplayTimezoneProvider } from './contexts/display-timezone-context'

export default function App() {
  return (
    <DisplayTimezoneProvider>
    <Routes>
      <Route element={<AppShellLayout />}>
        <Route index element={<Navigate to={NAV_PATH.dashboard} replace />} />
        <Route path="streams" element={<LazyStreamsConsole />} />
        <Route path="streams/new" element={<LazyNewStreamWizardPage />} />
        <Route path="streams/:streamId/api-test" element={<LazyStreamApiTestPage />} />
        <Route path="streams/:streamId/enrichment" element={<LazyStreamEnrichmentPage />} />
        <Route path="streams/:streamId/runtime" element={<LazyStreamRuntimeDetailPage />} />
        <Route path="streams/:streamId/mapping" element={<LazyStreamMappingPage />} />
        <Route path="streams/:streamId/edit" element={<LazyStreamEditPage />} />
        <Route path="monitoring" element={<LazyDashboardOverview />} />
        <Route path="monitoring/streams" element={<PreserveSearchRedirect to={NAV_PATH.streams} />} />
        <Route path="monitoring/topology" element={<PreserveSearchRedirect to={NAV_PATH.dashboard} />} />
        <Route path="monitoring/analytics" element={<PreserveSearchRedirect to={NAV_PATH.dashboard} />} />
        <Route path="runtime" element={<PreserveSearchRedirect to={NAV_PATH.dashboard} />} />
        <Route path="runtime/topology" element={<PreserveSearchRedirect to={NAV_PATH.dashboard} />} />
        <Route path="runtime/analytics" element={<PreserveSearchRedirect to={NAV_PATH.dashboard} />} />
        <Route path="runtime/ai-gateway" element={<PreserveSearchRedirect to={NAV_PATH.streams} />} />
        <Route path="admin" element={<LazyAdministrationHubPage />} />
        <Route
          path="admin/connector-catalog"
          element={
            <OssRouteGuard redirectTo={NAV_PATH.administration}>
              <LazyConnectorCatalogPage />
            </OssRouteGuard>
          }
        />
        <Route path="connectors" element={<LazyConnectorsOverviewPage />} />
        <Route path="connectors/new" element={<LazyNewConnectorWizardPage />} />
        <Route path="connectors/:connectorId" element={<LazyConnectorDetailPage />} />
        <Route path="mappings" element={<LazyMappingsOverviewPage />} />
        <Route path="mappings/:mappingId/edit" element={<LazyMappingEditPage />} />
        <Route path="destinations" element={<LazyDestinationsManagementPage />} />
        <Route path="destinations/:destinationId" element={<LazyDestinationDetailPage />} />
        <Route path="routes" element={<LazyRoutesOverviewPage />} />
        <Route path="routes/:routeId/edit" element={<LazyRouteEditPage />} />
        <Route path="governance" element={<LazyGovernanceShell />}>
          <Route index element={<LazyGovernanceDashboardPage />} />
          <Route path="operations" element={<LazyOperationsCenterPage />} />
          <Route
            path="data-protection"
            element={
              <OssRouteGuard redirectTo={NAV_PATH.governance}>
                <LazyGovernanceDataProtectionHubPage />
              </OssRouteGuard>
            }
          />
          <Route path="violations" element={<LazyViolationCenterPage />} />
          <Route path="quarantine" element={<LazyQuarantineCenterPage />} />
          <Route path="audit" element={<LazyAuditTrailPage />} />
          <Route path="approvals" element={<LazyApprovalWorkflowPage />} />
          <Route path="replay" element={<LazyReplayCenterPage />} />
          <Route path="notifications" element={<LazyNotificationsPage />} />
          <Route path="workspace" element={<LazyGovernanceWorkspacePage />} />
        </Route>
        <Route
          path="validation"
          element={
            <OssRouteGuard redirectTo={NAV_PATH.dashboard}>
              <LazyValidationShell />
            </OssRouteGuard>
          }
        >
          <Route index element={<LazyValidationOverviewPage />} />
          <Route path="alerts" element={<LazyValidationAlertsPage />} />
          <Route path="runs" element={<LazyValidationRunsPage />} />
          <Route path="failing" element={<LazyValidationFailingPage />} />
          <Route path="auth" element={<LazyValidationAuthPage />} />
          <Route path="delivery" element={<LazyValidationDeliveryPage />} />
          <Route path="checkpoints" element={<LazyValidationCheckpointPage />} />
        </Route>
        <Route path="logs" element={<LazyLogsExplorerPage />} />
        <Route path="logs/:streamId" element={<LazyLogsExplorerPage />} />
        <Route
          path="templates"
          element={
            <OssRouteGuard redirectTo={NAV_PATH.streams}>
              <LazyTemplatesOverviewPage />
            </OssRouteGuard>
          }
        />
        <Route path="operations/backup" element={<LazyOperationsBackupPage />} />
        <Route path="settings" element={<LazyAdminSettingsPage />} />
        <Route path="settings/audit-logs" element={<LazyAuditLogsPage />} />
        <Route path="settings/network" element={<Navigate to="/settings" replace />} />
        {PLACEHOLDER_NAV_KEYS.map((key) => (
          <Route key={key} path={key} element={<PlaceholderPage title={PAGE_TITLE[key]} />} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
    </DisplayTimezoneProvider>
  )
}
